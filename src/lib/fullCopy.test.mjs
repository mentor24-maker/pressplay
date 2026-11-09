import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fullCopyPolicy, htmlToText, bodyFromFeedItem, extractArticleText,
  robotsAllows, fetchPageBody, retentionCutoff, RETENTION_DAYS,
} from "./fullCopy.js";

test("full copy is off unless a feed says allowed: true with a known method", () => {
  assert.equal(fullCopyPolicy({ name: "x" }).allowed, false);
  assert.equal(fullCopyPolicy({ fullCopy: { allowed: false, method: "page" } }).allowed, false);
  assert.equal(fullCopyPolicy({ fullCopy: { allowed: "true", method: "page" } }).allowed, false);
  const bad = fullCopyPolicy({ fullCopy: { allowed: true, method: "scrape" } });
  assert.equal(bad.allowed, false);
  assert.match(bad.problem, /method/);
  assert.deepEqual(fullCopyPolicy({ fullCopy: { allowed: true, method: "feed" } }), { allowed: true, method: "feed", problem: null });
});

test("every shipped feed has full copy off", async () => {
  const { readFile } = await import("node:fs/promises");
  const { feeds } = JSON.parse(await readFile(new URL("../../data/feeds.json", import.meta.url), "utf8"));
  assert.ok(feeds.length > 0);
  for (const f of feeds) assert.equal(fullCopyPolicy(f).allowed, false, `${f.name} must stay off until the outlet says yes`);
});

test("feed text keeps paragraphs and drops scripts", () => {
  const html = "<p>First &amp; one.</p><script>evil()</script><p>Second<br>line</p>";
  assert.equal(htmlToText(html), "First & one.\n\nSecond\n\nline");
  assert.equal(bodyFromFeedItem({ "content:encoded": "<p>A</p><p>B</p>" }), "A\n\nB");
  assert.equal(bodyFromFeedItem({}), "");
});

test("page text comes from <article> paragraphs only", () => {
  const html = `<html><nav><p>Menu</p></nav><article><h1>T</h1><p>One.</p><style>p{}</style><p class="x">Two <b>bold</b>.</p></article><footer><p>Footer</p></footer></html>`;
  assert.equal(extractArticleText(html), "One.\n\nTwo bold.");
  assert.equal(extractArticleText("<p>No article</p><p>here</p>"), "No article\n\nhere");
});

test("robots.txt: our group beats *, longest rule wins, Allow on a tie", () => {
  const robots = `
User-agent: *
Disallow: /

User-agent: PressPlayToday
Disallow: /private/
Allow: /private/ok$
`;
  assert.equal(robotsAllows(robots, "/news/story"), true);
  assert.equal(robotsAllows(robots, "/private/x"), false);
  assert.equal(robotsAllows(robots, "/private/ok"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /", "/a"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow:", "/a"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /*.pdf$", "/a.pdf"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /*.pdf$", "/a.pdf?x"), true);
  assert.equal(robotsAllows("", "/a"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /a\nAllow: /a", "/a"), true);
});

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (r === undefined) return { ok: false, status: 404, text: async () => "" };
    if (r instanceof Error) throw r;
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => r.body ?? "" };
  };
  return { impl, calls };
}

test("a page robots.txt disallows is never fetched", async () => {
  const { impl, calls } = fakeFetch({
    "https://news.example/robots.txt": { body: "User-agent: *\nDisallow: /" },
    "https://news.example/story": { body: "<article><p>secret</p></article>" },
  });
  const got = await fetchPageBody("https://news.example/story", { fetchImpl: impl });
  assert.equal(got.text, "");
  assert.match(got.error, /robots/);
  assert.deepEqual(calls, ["https://news.example/robots.txt"]);
});

test("an unreadable robots.txt refuses; a missing one allows", async () => {
  const down = fakeFetch({ "https://a.example/robots.txt": { status: 503 } });
  const refused = await fetchPageBody("https://a.example/s", { fetchImpl: down.impl });
  assert.match(refused.error, /robots\.txt unreadable/);
  assert.equal(down.calls.length, 1);

  const missing = fakeFetch({ "https://b.example/s": { body: "<article><p>Text here.</p></article>" } });
  const ok = await fetchPageBody("https://b.example/s", { fetchImpl: missing.impl });
  assert.equal(ok.error, null);
  assert.equal(ok.text, "Text here.");
});

test("a page error never carries the page's text", async () => {
  const { impl } = fakeFetch({ "https://c.example/s": { status: 403, body: "<p>PAYWALLED TEXT</p>" } });
  const got = await fetchPageBody("https://c.example/s", { fetchImpl: impl });
  assert.equal(got.error, "HTTP 403");
  assert.doesNotMatch(got.error, /PAYWALLED/);
  assert.match((await fetchPageBody("ftp://x/y", { fetchImpl: impl })).error, /web link/);
});

test("retention is 30 days", () => {
  assert.equal(RETENTION_DAYS, 30);
  const now = Date.parse("2026-11-09T12:00:00Z");
  assert.equal(retentionCutoff(now), "2026-10-10T12:00:00.000Z");
});
