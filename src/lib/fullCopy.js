/**
 * PressPlay Today — full copy, kept private.
 *
 * THE RULE (PP-3, decided by Dane on 2026-11-09; do not weaken casually):
 * - Full article text is stored ONLY for a feed whose entry in data/feeds.json
 *   says `"fullCopy": { "allowed": true, ... }`. Missing or anything else = off.
 *   A feed is turned on only once that outlet has said yes.
 * - It goes in the private `story_bodies` table, which only the server's
 *   service-role key can read. Never the public `stories` table, never the
 *   site, never the public API, never game text shown to players.
 * - It is never printed in a log or an error message. Errors name the feed and
 *   the link, never the text.
 * - It is kept RETENTION_DAYS days, then deleted.
 * - We never get around a paywall, a login or a site's robots.txt: the "page"
 *   method reads only what an anonymous reader may, and only where robots.txt
 *   allows our reader.
 */
import { cleanText } from "./text.js";

export const USER_AGENT = "PressPlayToday/0.1 (+https://pressplay.today; feed reader)";
export const ROBOTS_TOKEN = "pressplaytoday";
export const RETENTION_DAYS = 30;
export const METHODS = ["feed", "page"];
/** Page fetches per feed per run, so one run stays well inside the 60-second cron limit. */
export const MAX_PAGES_PER_FEED = 15;
/** Shorter than this is a teaser or an empty page, not full copy. */
export const MIN_BODY_CHARS = 200;

/**
 * What a feed's entry allows. Only an explicit `allowed: true` with a known
 * method turns full copy on; everything else is off.
 * Returns { allowed, method, problem } — `problem` explains a setting that is
 * on but unusable (it is then treated as off).
 */
export function fullCopyPolicy(feed) {
  const fc = feed && feed.fullCopy;
  if (!fc || fc.allowed !== true) return { allowed: false, method: null, problem: null };
  if (!METHODS.includes(fc.method)) {
    return { allowed: false, method: null, problem: `fullCopy.method must be one of ${METHODS.join(", ")}` };
  }
  return { allowed: true, method: fc.method, problem: null };
}

/** Inline tags (bold, links, ...) vanish without leaving a space: "<b>x</b>." stays "x.". */
const INLINE_TAGS = /<\/?(?:a|abbr|b|cite|em|i|mark|q|small|span|strong|sub|sup|time|u)\b[^>]*>/gi;
const paraText = (html) => cleanText(String(html).replace(INLINE_TAGS, ""));

/** HTML to plain text that keeps paragraph breaks. */
export function htmlToText(html = "") {
  const withoutJunk = String(html)
    .replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const paras = withoutJunk
    .split(/<\/p>|<br\s*\/?>|<\/h[1-6]>|<\/li>|<\/blockquote>/i)
    .map((chunk) => paraText(chunk))
    .filter(Boolean);
  return paras.join("\n\n");
}

/** The full text a feed item itself carries (a full-text feed), or "". */
export function bodyFromFeedItem(item) {
  const html = (item && (item["content:encoded"] || item.content)) || "";
  return htmlToText(html);
}

/**
 * The article's paragraphs from a page. Prefers the <article> element when
 * there is one; keeps only <p> text so menus, footers and ads are dropped.
 */
export function extractArticleText(html = "") {
  const src = String(html).replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ");
  const article = src.match(/<article\b[\s\S]*?<\/article>/i);
  const scope = article ? article[0] : src;
  const paras = [...scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => paraText(m[1]))
    .filter((t) => t.length > 0);
  return paras.join("\n\n");
}

/**
 * Does robots.txt let our reader fetch `path`? Follows the usual rules: the
 * group naming our reader wins over `*`; within it the longest matching rule
 * wins, Allow on a tie; `*` and `$` in rules are honoured; an empty
 * Disallow allows everything.
 */
export function robotsAllows(robotsTxt, path, token = ROBOTS_TOKEN) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(robotsTxt || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!current) continue;
      if (key === "allow" || key === "disallow") current.rules.push({ allow: key === "allow", pattern: value });
    }
  }
  const ours = groups.filter((g) => g.agents.includes(token));
  const chosen = ours.length ? ours : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules).filter((r) => r.pattern !== "");
  let best = null;
  for (const r of rules) {
    if (!robotsPatternMatches(r.pattern, path)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

function robotsPatternMatches(pattern, path) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp("^" + re + (anchored ? "$" : "")).test(path);
}

/**
 * Fetch one article page's text, honouring robots.txt.
 * Returns { text, error }. `error` never contains page text.
 * A robots.txt that is missing (404) allows; one that cannot be read any
 * other way refuses, so a doubt never becomes a fetch.
 */
export async function fetchPageBody(url, { fetchImpl = fetch, robotsCache = new Map() } = {}) {
  let target;
  try { target = new URL(url); } catch { return { text: "", error: "not a valid link" }; }
  if (!/^https?:$/.test(target.protocol)) return { text: "", error: "not a web link" };

  let allowed = robotsCache.get(target.origin);
  if (allowed === undefined) {
    allowed = await readRobots(target.origin, fetchImpl);
    robotsCache.set(target.origin, allowed);
  }
  if (typeof allowed === "string") return { text: "", error: allowed };
  if (!allowed(target.pathname + target.search)) return { text: "", error: "robots.txt does not allow it" };

  try {
    const res = await fetchImpl(target.href, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { text: "", error: `HTTP ${res.status}` };
    return { text: extractArticleText(await res.text()), error: null };
  } catch (err) {
    return { text: "", error: `could not fetch (${err.name || "error"})` };
  }
}

/** A function (path) => boolean, or a string saying why robots.txt could not be read. */
async function readRobots(origin, fetchImpl) {
  try {
    const res = await fetchImpl(`${origin}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404 || res.status === 410) return () => true;
    if (!res.ok) return `robots.txt unreadable (HTTP ${res.status}), so not fetched`;
    const txt = await res.text();
    return (path) => robotsAllows(txt, path);
  } catch (err) {
    return `robots.txt unreadable (${err.name || "error"}), so not fetched`;
  }
}

/** The cut-off before which stored full copy is deleted. */
export function retentionCutoff(now = Date.now(), days = RETENTION_DAYS) {
  return new Date(now - days * 864e5).toISOString();
}
