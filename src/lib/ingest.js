/**
 * PressPlay Today — RSS ingestion core.
 *
 * COPYRIGHT POSTURE (do not change casually; the rule since PP-3, 2026-11-09):
 * - PUBLISHED (the public `stories` table, the site, games shown to players):
 *   ONLY headline, short snippet, source attribution, timestamp, the facts,
 *   and the link back to the original article. Never full text, never images.
 * - STORED PRIVATELY: full article text, only from outlets that have said yes
 *   (each feed's `fullCopy.allowed` in data/feeds.json, off by default), in
 *   the private `story_bodies` table, for 30 days. See src/lib/fullCopy.js.
 * Games are built from facts, always attributed and linked to the source.
 */
import Parser from "rss-parser";
import { cleanText } from "./text.js";
import {
  fullCopyPolicy, bodyFromFeedItem, fetchPageBody, retentionCutoff,
  MAX_PAGES_PER_FEED, MAX_PAGE_ATTEMPTS_PER_FEED, MIN_BODY_CHARS, USER_AGENT,
} from "./fullCopy.js";

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": USER_AGENT },
});

export { cleanText };

const SNIPPET_MAX = 280;
const MAX_AGE_HOURS = 48;
/** story_bodies lookups per request: guids are often long links, and `.in()` puts them all in the URL. */
export const GUID_BATCH = 50;

/** Truncate at a word boundary. */
export function snippet(text, max = SNIPPET_MAX) {
  const t = cleanText(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(" ")) + "…";
}

/**
 * Attention score v1 (0–100): pure recency decay.
 * v2 ideas: share velocity (social APIs), cross-feed duplication (same story in
 * N feeds = bigger story), search-trend signal, click-through feedback loop.
 */
export function attentionScore(publishedAt, now = Date.now()) {
  const ageH = Math.max(0, (now - publishedAt.getTime()) / 36e5);
  return Math.round(100 * Math.exp(-ageH / 12)); // half-life ≈ 8.3h
}

/** Normalize one rss-parser item into a story row. Returns null to skip. */
export function normalizeItem(item, feed, now = Date.now()) {
  const url = (item.link || "").trim();
  const title = cleanText(item.title || "");
  if (!url || !title) return null;

  const publishedAt = item.isoDate ? new Date(item.isoDate) : item.pubDate ? new Date(item.pubDate) : new Date(now);
  if (Number.isNaN(publishedAt.getTime())) return null;
  if ((now - publishedAt.getTime()) / 36e5 > MAX_AGE_HOURS) return null; // stale

  return {
    guid: item.guid || url, // stable identity for upsert
    title,
    url,
    source: feed.name,
    category: feed.category,
    snippet: snippet(item.contentSnippet || item.content || item.summary || ""),
    published_at: publishedAt.toISOString(),
    attention: attentionScore(publishedAt, now),
  };
}

/**
 * Normalize a parsed feed. Returns the public story rows, plus — only when
 * the feed allows full copy — one candidate per story for the private store.
 */
export function storiesFromParsed(parsed, feed, now = Date.now()) {
  const policy = fullCopyPolicy(feed);
  const stories = [];
  const candidates = [];
  for (const item of parsed.items || []) {
    const story = normalizeItem(item, feed, now);
    if (!story) continue;
    stories.push(story);
    if (policy.allowed) {
      candidates.push({
        story_guid: story.guid,
        url: story.url,
        source: feed.name,
        method: policy.method,
        text: policy.method === "feed" ? bodyFromFeedItem(item) : null,
      });
    }
  }
  const problem = policy.problem ? `${policy.problem}; full copy treated as off` : null;
  return { stories, candidates, problem };
}

/** Fetch and normalize a single feed. Never throws; returns {stories, candidates, error}. */
export async function ingestFeed(feed, { parseFeed = (url) => parser.parseURL(url), now = Date.now() } = {}) {
  try {
    const parsed = await parseFeed(feed.url);
    const { stories, candidates, problem } = storiesFromParsed(parsed, feed, now);
    return { feed: feed.name, stories, candidates, error: problem };
  } catch (err) {
    return { feed: feed.name, stories: [], candidates: [], error: err.message };
  }
}

/** Parse an XML string (used by offline tests). */
export async function ingestXml(xml, feed, now = Date.now()) {
  const parsed = await parser.parseString(xml);
  return storiesFromParsed(parsed, feed, now).stories;
}

/**
 * Turn one feed's candidates into private `story_bodies` rows: skip stories
 * already stored and guids seen twice, read the text a full-text feed
 * carries, fetch pages (robots.txt honoured). Per feed per run, at most
 * MAX_PAGES_PER_FEED pages are stored and at most MAX_PAGE_ATTEMPTS_PER_FEED
 * page requests are sent, so links that keep failing cannot block the
 * stories behind them. Errors name the feed and the link, never the text.
 */
export async function resolveBodies(candidates, { already = new Set(), fetchImpl = fetch, now = Date.now(), robotsCache = new Map() } = {}) {
  const rows = [];
  const errors = [];
  const seen = new Set(already);
  const storedBySource = new Map();
  const requestsBySource = new Map();
  const fetchedAt = new Date(now).toISOString();
  for (const c of candidates) {
    if (seen.has(c.story_guid)) continue;
    seen.add(c.story_guid);
    let text = c.text;
    if (c.method === "page") {
      const requests = requestsBySource.get(c.source) || 0;
      if ((storedBySource.get(c.source) || 0) >= MAX_PAGES_PER_FEED || requests >= MAX_PAGE_ATTEMPTS_PER_FEED) continue; // the rest wait for the next run
      // Count page requests (each redirect hop is one); robots.txt reads are cached per site and not counted.
      let sent = 0;
      const counting = (url, opts) => { if (!String(url).endsWith("/robots.txt")) sent++; return fetchImpl(url, opts); };
      const got = await fetchPageBody(c.url, { fetchImpl: counting, robotsCache });
      requestsBySource.set(c.source, requests + sent);
      if (got.error) { errors.push(`${c.source}: full copy for ${c.url}: ${got.error}`); continue; }
      text = got.text;
    }
    if (!text || text.length < MIN_BODY_CHARS) {
      errors.push(`${c.source}: full copy for ${c.url}: too short to be the full article, not stored`);
      continue;
    }
    storedBySource.set(c.source, (storedBySource.get(c.source) || 0) + 1);
    rows.push({ story_guid: c.story_guid, body: text, method: c.method, source: c.source, fetched_at: fetchedAt });
  }
  return { rows, errors };
}

/** The first row for each guid: two feeds carrying one story would make the whole upsert fail. */
function uniqueByGuid(rows) {
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.guid) ? false : (seen.add(r.guid), true)));
}

/**
 * Ingest all feeds and upsert into Supabase.
 * Pass supabase=null for a dry run (returns rows without writing; no article
 * page is fetched on a dry run).
 * Full copy goes only to the private `story_bodies` table, and only for feeds
 * that allow it; rows older than RETENTION_DAYS are deleted every run.
 */
export async function ingestAll(feeds, supabase = null, { parseFeed, fetchImpl = fetch, now = Date.now() } = {}) {
  const results = await Promise.all(feeds.map((f) => ingestFeed(f, { parseFeed, now })));
  const rows = uniqueByGuid(results.flatMap((r) => r.stories));
  const candidates = results.flatMap((r) => r.candidates);
  const errors = results.filter((r) => r.error).map((r) => `${r.feed}: ${r.error}`);

  let written = 0;
  // `failed` names each story_bodies step that did not work this run, so the
  // report says so instead of printing a count of zero as if all was well.
  const fullCopy = { candidates: candidates.length, stored: 0, deleted: 0, failed: [] };
  if (!supabase) return { fetched: rows.length, written, errors, rows, fullCopy };

  // Retention first, every run, even with every feed off: page fetches below
  // can be slow, and a run cut short by the time limit must still clear old
  // copy (and copy a feed left behind before it was turned off).
  const del = await supabase.from("story_bodies").delete({ count: "exact" }).lt("fetched_at", retentionCutoff(now));
  if (del.error) { errors.push(`supabase (story_bodies clean-up): ${del.error.message}`); fullCopy.failed.push("clean-up"); }
  else fullCopy.deleted = del.count ?? 0;

  let storiesSaved = true;
  if (rows.length) {
    // Upsert on guid: re-running never duplicates; attention refreshes each run.
    const { error, count } = await supabase
      .from("stories")
      .upsert(rows, { onConflict: "guid", ignoreDuplicates: false, count: "exact" });
    if (error) { errors.push(`supabase: ${error.message}`); storiesSaved = false; }
    else written = count ?? rows.length;
  }

  // Full copy only once its stories are saved (story_bodies points at stories.guid).
  if (candidates.length && !storiesSaved) fullCopy.failed.push("skipped (stories not saved)");
  if (candidates.length && storiesSaved) {
    const already = new Set();
    let readOk = true;
    const guids = [...new Set(candidates.map((c) => c.story_guid))];
    for (let i = 0; i < guids.length; i += GUID_BATCH) {
      const { data, error } = await supabase.from("story_bodies").select("story_guid").in("story_guid", guids.slice(i, i + GUID_BATCH));
      if (error) { errors.push(`supabase (story_bodies read): ${error.message}`); readOk = false; break; }
      for (const d of data || []) already.add(d.story_guid);
    }
    if (!readOk) fullCopy.failed.push("read");
    else {
      // Each feed is a different outlet, so feeds fetch side by side (one
      // page at a time within a feed), and each feed's rows are written the
      // moment that feed is done: a run cut short by the time limit keeps
      // what it already fetched instead of losing it all.
      const bySource = new Map();
      for (const c of candidates) bySource.set(c.source, [...(bySource.get(c.source) || []), c]);
      const robotsCache = new Map();
      let writeFailed = false;
      await Promise.all([...bySource.values()].map(async (group) => {
        const resolved = await resolveBodies(group, { already, fetchImpl, now, robotsCache });
        errors.push(...resolved.errors);
        if (!resolved.rows.length) return;
        const up = await supabase
          .from("story_bodies")
          .upsert(resolved.rows, { onConflict: "story_guid", ignoreDuplicates: true, count: "exact" });
        if (up.error) { errors.push(`supabase (story_bodies write, ${group[0].source}): ${up.error.message}`); writeFailed = true; }
        else fullCopy.stored += up.count ?? resolved.rows.length;
      }));
      if (writeFailed) fullCopy.failed.push("write");
    }
  }

  return { fetched: rows.length, written, errors, rows, fullCopy };
}
