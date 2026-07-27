/**
 * PressPlay Today — RSS ingestion core.
 *
 * COPYRIGHT POSTURE (do not change casually):
 * We store ONLY headline, short snippet, source attribution, timestamp, and the
 * link back to the original article. Never full article text, never images.
 * Games are built from facts, always attributed and linked to the source.
 */
import Parser from "rss-parser";

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "PressPlayToday/0.1 (+https://pressplay.today; feed reader)" },
});

const SNIPPET_MAX = 280;
const MAX_AGE_HOURS = 48;

/** Strip HTML tags/entities and collapse whitespace. */
export function cleanText(html = "") {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

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

/** Fetch and normalize a single feed. Never throws; returns {stories, error}. */
export async function ingestFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    const stories = (parsed.items || [])
      .map((item) => normalizeItem(item, feed))
      .filter(Boolean);
    return { feed: feed.name, stories, error: null };
  } catch (err) {
    return { feed: feed.name, stories: [], error: err.message };
  }
}

/** Parse an XML string (used by offline tests). */
export async function ingestXml(xml, feed) {
  const parsed = await parser.parseString(xml);
  return (parsed.items || []).map((i) => normalizeItem(i, feed)).filter(Boolean);
}

/**
 * Ingest all feeds and upsert into Supabase.
 * Pass supabase=null for a dry run (returns rows without writing).
 */
export async function ingestAll(feeds, supabase = null) {
  const results = await Promise.all(feeds.map(ingestFeed));
  const rows = results.flatMap((r) => r.stories);
  const errors = results.filter((r) => r.error).map((r) => `${r.feed}: ${r.error}`);

  let written = 0;
  if (supabase && rows.length) {
    // Upsert on guid: re-running never duplicates; attention refreshes each run.
    const { error, count } = await supabase
      .from("stories")
      .upsert(rows, { onConflict: "guid", ignoreDuplicates: false, count: "exact" });
    if (error) errors.push(`supabase: ${error.message}`);
    else written = count ?? rows.length;
  }
  return { fetched: rows.length, written, errors, rows };
}
