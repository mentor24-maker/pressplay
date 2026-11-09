/**
 * PressPlay Today — group stories about the same news event (PP-4).
 *
 * Different outlets write different headlines for one event. This module
 * decides, with a plain rule and no AI, which stories are about the same
 * event, and records it in two PRIVATE tables (supabase/schema.sql):
 * `events` (one row per event) and `story_events` (each story's event).
 * Neither is public: the site never reads them. The fact sheet written from
 * an event's sources is the next step (PP-5).
 *
 * THE RULE (`sameEvent`): two stories are about the same event when
 * - they were published within EVENT_WINDOW_HOURS of each other, and
 * - their headlines share at least MIN_SHARED_TITLE key words, and
 * - headline plus snippet share at least MIN_SHARED_ALL key words, which is
 *   at least MIN_OVERLAP of the shorter story's key words, and
 * - at least one key word both headlines share is a name: a word neither
 *   story ever writes in lower case (Denver, Nvidia, Hegseth). Common words
 *   alone ("linked", "lower", "risk") are not enough, and a headline Written
 *   In Title Case does not turn its common words into names, because the
 *   snippets write them in lower case.
 * Key words are the words left after dropping common words ("the", "says",
 * "after"...), lower-cased, with a plain plural "s" taken off.
 *
 * STABLE ACROSS RUNS: a story linked to an event keeps it. Each run only
 * places stories with no event yet: into the event of the closest matching
 * story, or into a new event. A new event's key is the guid of the story
 * that started it, so a run repeated after a half-failed write lands on the
 * same keys, and nothing is ever duplicated.
 */
import { cleanText } from "./text.js";

export const EVENT_WINDOW_HOURS = 48;
export const MIN_SHARED_TITLE = 2;
export const MIN_SHARED_ALL = 3;
export const MIN_OVERLAP = 0.25;
/** Rows read per request: Supabase returns at most 1,000 rows at a time. */
export const PAGE_ROWS = 1000;
/** story_events lookups per request (guids are often long links, and `.in()` puts them in the URL). */
export const LINK_BATCH = 50;

/** Common words and news filler that say nothing about which event a story is. */
const STOP_WORDS = new Set(`
a about above after again against all also am an and any are as at be been before being below between both but by
can could did do does doing down during each few for from further had has have having he her here hers him his how
i if in into is it its itself just me more most my no nor not now of off on once only or other our ours out over own
same she should so some such than that the their theirs them then there these they this those through to too under
until up very was we were what when where which while who whom why will with would you your yours
says said say saying tells told new news latest live update updates report reports reported breaking today tonight
yesterday tomorrow week weeks year years day days month months time first last next one two three get gets got make
makes made may might must amid could via per near back still yet ahead set sets watch video photos opinion analysis
`.split(/\s+/).filter(Boolean));

/** A light stem so "votes" meets "vote" and "cities" meets "city". */
function stem(word) {
  let w = word.replace(/['’]s$/, "").replace(/['’]/g, "");
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  return w;
}

/** The key words of a piece of text, as a Set. */
export function keyWords(text = "") {
  const words = cleanText(String(text)).toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) || [];
  const out = new Set();
  for (const raw of words) {
    if (STOP_WORDS.has(raw)) continue;
    const w = stem(raw);
    if (STOP_WORDS.has(w)) continue;
    if (/^\p{N}+$/u.test(w) ? w.length < 2 : w.length < 3) continue;
    out.add(w);
  }
  return out;
}

/** The key words a text writes, at least once, starting with a lower-case letter. */
export function lowerCaseWords(text = "") {
  const words = cleanText(String(text)).match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) || [];
  return keyWords(words.filter((w) => /^\p{Ll}/u.test(w)).join(" "));
}

/** What the rule compares, worked out once per story. */
export function profile(story) {
  const title = keyWords(story.title || "");
  const all = new Set([...title, ...keyWords(story.snippet || "")]);
  const lower = lowerCaseWords(`${story.title || ""} ${story.snippet || ""}`);
  return { title, all, lower, at: Date.parse(story.published_at) };
}

const sharedCount = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n; };

/**
 * How strongly two stories match: 0 when they are not the same event,
 * otherwise the number of key words they share (higher is closer).
 * Takes stories or profiles.
 */
export function matchScore(a, b) {
  const pa = a.all ? a : profile(a);
  const pb = b.all ? b : profile(b);
  if (!Number.isFinite(pa.at) || !Number.isFinite(pb.at)) return 0;
  if (Math.abs(pa.at - pb.at) > EVENT_WINDOW_HOURS * 36e5) return 0;
  if (sharedCount(pa.title, pb.title) < MIN_SHARED_TITLE) return 0;
  const shared = sharedCount(pa.all, pb.all);
  if (shared < MIN_SHARED_ALL) return 0;
  if (shared / Math.min(pa.all.size, pb.all.size) < MIN_OVERLAP) return 0;
  let sharesName = false;
  for (const w of pa.title) {
    if (pb.title.has(w) && /^\p{L}/u.test(w) && !pa.lower.has(w) && !pb.lower.has(w)) { sharesName = true; break; }
  }
  if (!sharesName) return 0;
  return shared;
}

/** Are two stories about the same event? */
export const sameEvent = (a, b) => matchScore(a, b) > 0;

/**
 * Place every story that has no event yet.
 * `stories`: rows with guid, title, snippet, published_at.
 * `linked`: Map guid -> event key, for stories that already have one (kept as is).
 * Stories are placed oldest first. Each joins the event of the story it
 * matches best (an already-placed one), or starts a new event keyed by its
 * own guid. Returns { links: [{story_guid, event_key}], events: [{key, ...}] }
 * holding only what is new this time.
 */
export function assignEvents(stories, linked = new Map()) {
  const unique = new Map();
  for (const s of stories) if (s && s.guid && !unique.has(s.guid)) unique.set(s.guid, s);
  const ordered = [...unique.values()].sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at) || (a.guid < b.guid ? -1 : 1));

  const placed = []; // { profile, key }
  for (const s of ordered) if (linked.has(s.guid)) placed.push({ p: profile(s), key: linked.get(s.guid) });

  const links = [];
  const newEvents = new Map();
  for (const s of ordered) {
    if (linked.has(s.guid)) continue;
    const p = profile(s);
    let best = null;
    let bestScore = 0;
    for (const other of placed) {
      const score = matchScore(p, other.p);
      if (score > bestScore) { bestScore = score; best = other; }
    }
    const key = best ? best.key : s.guid;
    if (!best) newEvents.set(key, { key, first_published_at: s.published_at });
    placed.push({ p, key });
    links.push({ story_guid: s.guid, event_key: key });
  }
  return { links, events: [...newEvents.values()] };
}

/** How many events a set of stories makes, in memory (the dry run's report). */
export function countEvents(stories) {
  const { links, events } = assignEvents(stories);
  const sizes = new Map();
  for (const l of links) sizes.set(l.event_key, (sizes.get(l.event_key) || 0) + 1);
  return { stories: links.length, events: events.length, multiSource: [...sizes.values()].filter((n) => n > 1).length };
}

/**
 * The grouping step of ingestion: read the stories of the last
 * EVENT_WINDOW_HOURS and their existing links, place the unlinked ones,
 * write the new events and links. Run after the stories are saved.
 * Never throws. Returns { considered, linked, newEvents, errors, failed }:
 * `failed` names the step that did not work, so the report never shows a
 * zero as if all was well.
 */
export async function linkEvents(supabase, { now = Date.now() } = {}) {
  const res = { considered: 0, linked: 0, newEvents: 0, errors: [], failed: null };
  const fail = (step, error) => { res.errors.push(`supabase (events ${step}): ${error.message}`); res.failed = step; return res; };
  const since = new Date(now - EVENT_WINDOW_HOURS * 36e5).toISOString();

  try {
    const stories = [];
    for (let from = 0; ; from += PAGE_ROWS) {
      const { data, error } = await supabase
        .from("stories").select("guid,title,snippet,published_at")
        .gte("published_at", since).order("published_at", { ascending: true }).order("guid", { ascending: true })
        .range(from, from + PAGE_ROWS - 1);
      if (error) return fail("read stories", error);
      stories.push(...(data || []));
      if (!data || data.length < PAGE_ROWS) break;
    }
    res.considered = stories.length;
    if (!stories.length) return res;

    const linked = new Map();
    const guids = stories.map((s) => s.guid);
    for (let i = 0; i < guids.length; i += LINK_BATCH) {
      const { data, error } = await supabase.from("story_events").select("story_guid,event_key").in("story_guid", guids.slice(i, i + LINK_BATCH));
      if (error) return fail("read links", error);
      for (const d of data || []) linked.set(d.story_guid, d.event_key);
    }

    const { links, events } = assignEvents(stories, linked);
    if (events.length) {
      const up = await supabase.from("events").upsert(events, { onConflict: "key", ignoreDuplicates: true, count: "exact" });
      if (up.error) return fail("write events", up.error);
      res.newEvents = up.count ?? events.length;
    }
    if (links.length) {
      const up = await supabase.from("story_events").upsert(links, { onConflict: "story_guid", ignoreDuplicates: true, count: "exact" });
      if (up.error) return fail("write links", up.error);
      res.linked = up.count ?? links.length;
    }
    return res;
  } catch (err) {
    return fail("step", err);
  }
}
