import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestAll, normalizeItem, GUID_BATCH } from "./ingest.js";
import { MAX_PAGES_PER_FEED, MAX_PAGE_ATTEMPTS_PER_FEED } from "./fullCopy.js";

const NOW = Date.parse("2026-11-09T18:00:00Z");
const LONG = "The council voted seven to two on Tuesday night. ".repeat(20).trim();

/** A parsed feed with two fresh items carrying full text. */
const parsedFeed = () => ({
  items: [1, 2].map((n) => ({
    title: `Story ${n}`,
    link: `https://news.example/s${n}`,
    guid: `g${n}`,
    isoDate: new Date(NOW - n * 36e5).toISOString(),
    contentSnippet: LONG,
    "content:encoded": `<p>${LONG}</p><p>Paragraph two of story ${n}.</p>`,
  })),
});

/** A stand-in for the Supabase client that records every call. */
function fakeSupabase({ stored = [], fail = {} } = {}) {
  const calls = [];
  const from = (table) => ({
    upsert: async (rows, opts) => { calls.push({ table, op: "upsert", rows, opts }); return fail[`${table}:upsert`] ? { error: { message: "boom" } } : { error: null, count: rows.length }; },
    select: () => ({ in: async (col, vals) => { calls.push({ table, op: "select", vals }); return { data: stored.filter((g) => vals.includes(g)).map((g) => ({ story_guid: g })), error: null }; } }),
    delete: () => ({ lt: async (col, cutoff) => { calls.push({ table, op: "delete", col, cutoff }); return fail[`${table}:delete`] ? { error: { message: "boom" } } : { error: null, count: 0 }; } }),
  });
  return { from, calls };
}

const noFetch = async () => { throw new Error("no page may be fetched"); };

test("with full copy off, stories are written as before and story_bodies only gets the clean-up", async () => {
  const sb = fakeSupabase();
  const feed = { name: "Wire", url: "u", category: "top", fullCopy: { allowed: false, method: "feed" } };
  const res = await ingestAll([feed], sb, { parseFeed: async () => parsedFeed(), fetchImpl: noFetch, now: NOW });
  assert.equal(res.written, 2);
  assert.deepEqual(res.errors, []);
  const ops = sb.calls.map((c) => `${c.table}:${c.op}`);
  assert.deepEqual(ops, ["story_bodies:delete", "stories:upsert"], "clean-up runs first");
  assert.equal(sb.calls[0].cutoff, "2026-10-10T18:00:00.000Z");
  assert.deepEqual(res.fullCopy, { candidates: 0, stored: 0, deleted: 0, failed: [] });
});

test("a permitted feed stores full copy privately and the public row is unchanged", async () => {
  const sb = fakeSupabase();
  const feed = { name: "Partner", url: "u", category: "top", fullCopy: { allowed: true, method: "feed" } };
  const res = await ingestAll([feed], sb, { parseFeed: async () => parsedFeed(), fetchImpl: noFetch, now: NOW });

  const storiesUp = sb.calls.find((c) => c.table === "stories");
  const offRow = normalizeItem(parsedFeed().items[0], feed, NOW);
  assert.deepEqual(storiesUp.rows[0], offRow, "public row is exactly what it was before");
  for (const r of storiesUp.rows) {
    assert.ok(r.snippet.length <= 281, "snippet stays short");
    assert.equal(JSON.stringify(r).includes("Paragraph two"), false, "no full text in the public table");
  }

  const bodiesUp = sb.calls.find((c) => c.table === "story_bodies" && c.op === "upsert");
  assert.equal(bodiesUp.rows.length, 2);
  assert.equal(bodiesUp.rows[0].story_guid, "g1");
  assert.match(bodiesUp.rows[0].body, /Paragraph two of story 1\.$/);
  assert.equal(bodiesUp.rows[0].method, "feed");
  assert.equal(res.fullCopy.stored, 2);
  assert.equal(JSON.stringify(res.errors).includes("council"), false);
});

test("stories already stored are not fetched or written again", async () => {
  const sb = fakeSupabase({ stored: ["g1", "g2"] });
  const feed = { name: "Partner", url: "u", category: "top", fullCopy: { allowed: true, method: "page" } };
  const res = await ingestAll([feed], sb, { parseFeed: async () => parsedFeed(), fetchImpl: noFetch, now: NOW });
  assert.deepEqual(res.errors, []);
  assert.equal(sb.calls.some((c) => c.table === "story_bodies" && c.op === "upsert"), false);
});

test("a dry run fetches no article page and stores nothing", async () => {
  const feed = { name: "Partner", url: "u", category: "top", fullCopy: { allowed: true, method: "page" } };
  const res = await ingestAll([feed], null, { parseFeed: async () => parsedFeed(), fetchImpl: noFetch, now: NOW });
  assert.equal(res.fetched, 2);
  assert.deepEqual(res.fullCopy, { candidates: 2, stored: 0, deleted: 0, failed: [] });
});

test("page method: robots.txt refusal is reported by link, without any text", async () => {
  const sb = fakeSupabase();
  const fetchImpl = async (url) => url.endsWith("/robots.txt")
    ? { ok: true, status: 200, text: async () => "User-agent: PressPlayToday\nDisallow: /" }
    : (() => { throw new Error("page must not be fetched"); })();
  const feed = { name: "Partner", url: "u", category: "top", fullCopy: { allowed: true, method: "page" } };
  const res = await ingestAll([feed], sb, { parseFeed: async () => parsedFeed(), fetchImpl, now: NOW });
  assert.equal(res.errors.length, 2);
  assert.match(res.errors[0], /^Partner: full copy for https:\/\/news\.example\/s1: robots\.txt does not allow it$/);
  assert.equal(res.fullCopy.stored, 0);
});

test("a teaser-length body is not stored as full copy", async () => {
  const sb = fakeSupabase();
  const short = { items: [{ title: "T", link: "https://n.example/t", guid: "t", isoDate: new Date(NOW).toISOString(), "content:encoded": "<p>Just a teaser.</p>" }] };
  const feed = { name: "Partner", url: "u", category: "top", fullCopy: { allowed: true, method: "feed" } };
  const res = await ingestAll([feed], sb, { parseFeed: async () => short, fetchImpl: noFetch, now: NOW });
  assert.equal(res.fullCopy.stored, 0);
  assert.match(res.errors[0], /too short/);
  assert.doesNotMatch(res.errors[0], /teaser\./);
});

test("an unusable setting is named and treated as off", async () => {
  const sb = fakeSupabase();
  const feed = { name: "Odd", url: "u", category: "top", fullCopy: { allowed: true, method: "scrape" } };
  const res = await ingestAll([feed], sb, { parseFeed: async () => parsedFeed(), fetchImpl: noFetch, now: NOW });
  assert.equal(res.written, 2);
  assert.match(res.errors[0], /^Odd: fullCopy\.method must be one of feed, page; full copy treated as off$/);
  assert.equal(res.fullCopy.candidates, 0);
});

test("a failed step is recorded, not reported as zero", async () => {
  const feed = { name: "Partner", url: "u", category: "top", fullCopy: { allowed: true, method: "feed" } };
  const opts = { parseFeed: async () => parsedFeed(), fetchImpl: noFetch, now: NOW };

  const noStories = fakeSupabase({ fail: { "stories:upsert": true, "story_bodies:delete": true } });
  const a = await ingestAll([feed], noStories, opts);
  assert.deepEqual(a.fullCopy.failed, ["clean-up", "skipped (stories not saved)"]);
  assert.equal(noStories.calls.some((c) => c.table === "story_bodies" && c.op !== "delete"), false, "no full copy without its stories");

  const noWrite = fakeSupabase({ fail: { "story_bodies:upsert": true } });
  const b = await ingestAll([feed], noWrite, opts);
  assert.deepEqual(b.fullCopy.failed, ["write"]);
  assert.equal(b.fullCopy.stored, 0);
  assert.match(b.errors.join("\n"), /story_bodies write/);
});

test("the stored-already lookup goes in batches", async () => {
  const many = { items: Array.from({ length: GUID_BATCH + 5 }, (_, n) => ({
    title: `S${n}`, link: `https://news.example/${n}`, guid: `g${n}`,
    isoDate: new Date(NOW - 60e3).toISOString(), "content:encoded": `<p>${LONG}</p>`,
  })) };
  const sb = fakeSupabase();
  const feed = { name: "Partner", url: "u", category: "top", fullCopy: { allowed: true, method: "feed" } };
  await ingestAll([feed], sb, { parseFeed: async () => many, fetchImpl: noFetch, now: NOW });
  const reads = sb.calls.filter((c) => c.op === "select").map((c) => c.vals.length);
  assert.deepEqual(reads, [GUID_BATCH, 5]);
});

const pageHtml = (n) => `<article><p>${LONG}</p><p>Page ${n}.</p></article>`;
const okRobots = { ok: true, status: 200, text: async () => "User-agent: *\nAllow: /" };
const pageFeed = (name) => ({ name, url: name, category: "top", fullCopy: { allowed: true, method: "page" } });
const items = (prefix, n, host = "news.example") => Array.from({ length: n }, (_, i) => ({
  title: `${prefix}${i}`, link: `https://${host}/${prefix}${i}`, guid: `${prefix}${i}`,
  isoDate: new Date(NOW - 60e3).toISOString(), contentSnippet: "teaser",
}));

test("a feed-method outlet with only a teaser (no content:encoded) stores nothing", async () => {
  const sb = fakeSupabase();
  // rss-parser puts <description> in `content`; a long teaser there must not pass as full copy.
  const teaserOnly = { items: [{ title: "T", link: "https://n.example/t", guid: "t", isoDate: new Date(NOW).toISOString(), content: LONG, contentSnippet: LONG }] };
  const feed = { name: "Partner", url: "u", category: "top", fullCopy: { allowed: true, method: "feed" } };
  const res = await ingestAll([feed], sb, { parseFeed: async () => teaserOnly, fetchImpl: noFetch, now: NOW });
  assert.equal(res.fullCopy.stored, 0);
  assert.equal(sb.calls.some((c) => c.table === "story_bodies" && c.op === "upsert"), false);
  assert.match(res.errors[0], /too short/);
});

test("failing links do not use up the stored-page budget, and a repeated guid is fetched once", async () => {
  const sb = fakeSupabase();
  const feedItems = [...items("bad", MAX_PAGES_PER_FEED), ...items("good", 3)];
  feedItems.push({ ...feedItems[MAX_PAGES_PER_FEED] }); // good0 listed twice
  const fetched = [];
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) return okRobots;
    fetched.push(url);
    return url.includes("/bad") ? { ok: false, status: 500 } : { ok: true, status: 200, text: async () => pageHtml(url) };
  };
  const res = await ingestAll([pageFeed("Partner")], sb, { parseFeed: async () => ({ items: feedItems }), fetchImpl, now: NOW });
  const up = sb.calls.find((c) => c.table === "story_bodies" && c.op === "upsert");
  assert.deepEqual(up.rows.map((r) => r.story_guid), ["good0", "good1", "good2"], "stories behind the failing links are still stored");
  assert.equal(fetched.filter((u) => u.endsWith("/good0")).length, 1, "a repeated guid is fetched once");
  assert.equal(res.fullCopy.stored, 3);
});

test("page requests per feed stop at MAX_PAGE_ATTEMPTS_PER_FEED; robots refusals do not count", async () => {
  const sb = fakeSupabase();
  const feedItems = [...items("private", 10), ...items("bad", MAX_PAGE_ATTEMPTS_PER_FEED + 10)];
  let pageRequests = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) return { ok: true, status: 200, text: async () => "User-agent: *\nDisallow: /private" };
    pageRequests++;
    return { ok: false, status: 503 };
  };
  await ingestAll([pageFeed("Partner")], sb, { parseFeed: async () => ({ items: feedItems }), fetchImpl, now: NOW });
  assert.equal(pageRequests, MAX_PAGE_ATTEMPTS_PER_FEED);
});

test("each feed's full copy is written as soon as that feed is done, not after every feed", async () => {
  const sb = fakeSupabase();
  let releaseSlow;
  const slowGate = new Promise((r) => { releaseSlow = r; });
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) return okRobots;
    if (url.includes("slow.example")) await slowGate;
    return { ok: true, status: 200, text: async () => pageHtml(url) };
  };
  const parseFeed = async (u) => ({ items: u === "Fast" ? items("f", 2, "fast.example") : items("s", 2, "slow.example") });
  const run = ingestAll([pageFeed("Slow"), pageFeed("Fast")], sb, { parseFeed, fetchImpl, now: NOW });

  // Wait until the fast feed's rows land while the slow feed is still stuck.
  for (let i = 0; i < 50 && !sb.calls.some((c) => c.table === "story_bodies" && c.op === "upsert"); i++) await new Promise((r) => setTimeout(r, 5));
  const early = sb.calls.filter((c) => c.table === "story_bodies" && c.op === "upsert");
  assert.equal(early.length, 1, "the fast feed is saved before the slow one finishes");
  assert.deepEqual(early[0].rows.map((r) => r.source), ["Fast", "Fast"]);

  releaseSlow();
  const res = await run;
  assert.equal(sb.calls.filter((c) => c.table === "story_bodies" && c.op === "upsert").length, 2);
  assert.equal(res.fullCopy.stored, 4);
});

test("two feeds carrying the same story do not break the stories write", async () => {
  const sb = fakeSupabase();
  const a = { name: "A", url: "a", category: "top" };
  const b = { name: "B", url: "b", category: "top" };
  const res = await ingestAll([a, b], sb, { parseFeed: async () => parsedFeed(), fetchImpl: noFetch, now: NOW });
  const up = sb.calls.find((c) => c.table === "stories");
  assert.deepEqual(up.rows.map((r) => r.guid), ["g1", "g2"]);
  assert.equal(res.written, 2);
});
