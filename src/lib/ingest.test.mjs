import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestAll, normalizeItem } from "./ingest.js";

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
function fakeSupabase({ stored = [] } = {}) {
  const calls = [];
  const from = (table) => ({
    upsert: async (rows, opts) => { calls.push({ table, op: "upsert", rows, opts }); return { error: null, count: rows.length }; },
    select: () => ({ in: async (col, vals) => { calls.push({ table, op: "select", vals }); return { data: stored.filter((g) => vals.includes(g)).map((g) => ({ story_guid: g })), error: null }; } }),
    delete: () => ({ lt: async (col, cutoff) => { calls.push({ table, op: "delete", col, cutoff }); return { error: null, count: 0 }; } }),
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
  assert.deepEqual(ops, ["stories:upsert", "story_bodies:delete"]);
  assert.equal(sb.calls[1].cutoff, "2026-10-10T18:00:00.000Z");
  assert.deepEqual(res.fullCopy, { candidates: 0, stored: 0, deleted: 0 });
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
  assert.deepEqual(res.fullCopy, { candidates: 2, stored: 0, deleted: 0 });
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
