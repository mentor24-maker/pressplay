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
 * - the headlines share a name that proves it is one event (`sharedName`).
 *   A name is a key word neither story ever writes in lower case, and that
 *   one of them writes with a capital in ordinary sentence-case text (a
 *   snippet, or a headline not Written In Title Case): Denver, Nvidia,
 *   Hegseth. Common words alone ("linked", "lower", "risk") are not enough,
 *   and two Title Case headlines ("Stock Market Falls Sharply") prove
 *   nothing by their capitals alone.
 *   A common institution ("Supreme Court", "White House", "stock market")
 *   is a name too, but on its own it does not say which event: the court
 *   hears several cases a day. With only an institution in common, the
 *   headlines must also share MIN_TOPIC_WORDS words that say what happened
 *   (not "hears", "case", "ruling", ...).
 * - the headlines are not one pattern with a word swapped (`swappedSlot`):
 *   "Trump signs executive order on tariffs" / "... on immigration",
 *   "Senate passes defense spending bill" / "... farm spending bill". When
 *   most of the headline is the same words in the same order (at least
 *   TEMPLATE_SHARE of the longer headline), and between the same shared words
 *   each headline has its own word the other story never uses, the swapped
 *   word is what happened, and the stories are different events. Two outlets
 *   writing up one event word for word do not swap in a word of their own;
 *   when they write it up their own way, little of the order is shared.
 *   Exception: headlines that share two different names (France and Iran,
 *   Nvidia and Jensen Huang) have pinned down who twice over, and a swap
 *   there is only wording ("hacking" / "cyber attacks"). Name words side by
 *   side in both headlines are one name: "Donald Trump" or "Elon Musk" says
 *   who as little as "Trump" does. A swap of opposites ("buys" / "sells",
 *   "rises" / "falls") is never only wording, names or not. This misses some real pairs on purpose:
 *   "Judge denies motion to dismiss Lindsay Clancy's murder case" / "Judge
 *   Denies Request to Throw Out Lindsay Clancy's Murder Charges" stay apart,
 *   because a plain rule cannot tell that swap from "tariffs" /
 *   "immigration". A missed merge costs a second fact sheet; a wrong merge
 *   mixes two stories until it is caught (see THE RULE IS A FIRST PASS).
 * Key words are the words left after dropping common words ("the", "says",
 * "after"...), lower-cased, with a plain plural "s" taken off.
 *
 * JOINING AN EVENT: a new story joins an event only when it matches at
 * least half of that event's stories (in the window), not just any one, so
 * A~B, B~C, C~D does not chain A and D into one event when they share
 * nothing: by the time D comes, it must match two of A, B and C.
 *
 * STABLE ACROSS RUNS: a story linked to an event keeps it. Each run only
 * places stories with no event yet: into the closest event it joins, or
 * into a new event. A new event's key is the guid of the story
 * that started it, so a run repeated after a half-failed write lands on the
 * same keys, and nothing is ever duplicated.
 *
 * THE RULE IS A FIRST PASS (Dane's choice "A" on PP-4, 2026-11-09): some
 * different events still group, because words alone cannot tell them apart
 * ("Putin says Russia will respond to sanctions" / "Putin says Russia will
 * host Xi"). Before writing an event's fact sheet, PP-5's AI confirms its
 * stories really are one event and splits off any that are not, with
 * `moveStory`. Each link says who placed it (`linked_by`): "rule" for this
 * module's grouping, "check" for a move. Ingestion never re-places a linked
 * story, so a moved story stays where the check put it.
 *
 * KNOWN LIMIT (for PP-5): if the events write works and the links write then
 * fails, the next run may place those stories differently, leaving an event
 * row with no stories. A story moved out of an event can leave it empty the
 * same way. PP-5 should skip events that have no stories.
 */
import { cleanText } from "./text.js";
import { GUID_BATCH } from "./ingest.js";

export const EVENT_WINDOW_HOURS = 48;
export const MIN_SHARED_TITLE = 2;
export const MIN_SHARED_ALL = 3;
export const MIN_OVERLAP = 0.25;
export const MIN_TOPIC_WORDS = 3;
export const TEMPLATE_SHARE = 0.5;
/** Rows read per request: Supabase returns at most 1,000 rows at a time. */
export const PAGE_ROWS = 1000;
/** story_events lookups per request: the same limit, for the same reason, as ingest's story lookups. */
export const LINK_BATCH = GUID_BATCH;

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

/**
 * Institutions so common in the news that sharing one does not, alone, say
 * two stories are about the same event (key-word form: lower case, no plural "s").
 */
const INSTITUTIONS = new Set(`
supreme court white house congress congressional senate senator representative federal fed reserve
stock market wall street dow nasdaq pentagon capitol government administration state department
justice police parliament republican democrat democratic gop fbi cia nato united nation
`.split(/\s+/).filter(Boolean));

/** Words that say what kind of thing happened, never which event it was. */
const GENERIC = new Set(`
hear hearing argument case court ruling rule rules decision decide decides vote votes bill law order orders
plan plans deal talk talks meeting meet calls call move moves sharply slightly big huge major report key
`.split(/\s+/).filter(Boolean).map((w) => w.replace(/s$/, "")));

/** Words whose swap for each other says the opposite happened (key-word form). */
const OPPOSITES = [
  ["rise", "fall"], ["rise", "drop"], ["rise", "sink"], ["gain", "fall"], ["gain", "drop"], ["gain", "lose"], ["jump", "fall"], ["jump", "drop"],
  ["climb", "fall"], ["climb", "drop"], ["soar", "plunge"], ["surge", "plunge"], ["surge", "slump"], ["buy", "sell"], ["buy", "sold"], ["bought", "sell"],
  ["bought", "sold"], ["win", "lose"], ["won", "lost"], ["beat", "lose"], ["hire", "fire"], ["hired", "fired"], ["open", "close"], ["opened", "closed"],
  ["approve", "reject"], ["approved", "rejected"], ["pass", "fail"], ["passe", "fail"], ["passed", "failed"], ["raise", "cut"], ["raise", "lower"],
  ["increase", "decrease"], ["up", "down"], ["higher", "lower"], ["ban", "allow"], ["sign", "veto"], ["join", "leave"], ["start", "end"],
].map(([x, y]) => [x, y].map((w) => stem(w)));

const opposite = (xs, ys) => OPPOSITES.some(([x, y]) => (xs.includes(x) && ys.includes(y)) || (xs.includes(y) && ys.includes(x)));

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
  const words = cleanText(String(text)).match(WORD) || [];
  return keyWords(words.filter((w) => /^\p{Ll}/u.test(w)).join(" "));
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;

/**
 * Is a headline Written In Title Case? Every word of four letters or more
 * starts with a capital (and there are at least three of them). Its
 * capitals then say nothing about which words are names.
 */
export function isTitleCase(text = "") {
  const long = (cleanText(String(text)).match(WORD) || []).filter((w) => /^\p{L}{4}/u.test(w));
  return long.length >= 3 && long.every((w) => /^\p{Lu}/u.test(w));
}

/** The key words a text writes, at least once, starting with a capital letter. */
function capitalWords(text = "") {
  const words = cleanText(String(text)).match(WORD) || [];
  return keyWords(words.filter((w) => /^\p{Lu}/u.test(w)).join(" "));
}

/** What the rule compares, worked out once per story. */
export function profile(story) {
  const title = keyWords(story.title || "");
  const all = new Set([...title, ...keyWords(story.snippet || "")]);
  const lower = lowerCaseWords(`${story.title || ""} ${story.snippet || ""}`);
  // Capitals that count as evidence of a name: the snippet always, the headline unless it is in Title Case.
  const capitals = capitalWords(`${isTitleCase(story.title) ? "" : story.title || ""} ${story.snippet || ""}`);
  return { title, words: [...title], all, lower, capitals, at: Date.parse(story.published_at) };
}

/**
 * Do two headlines share a name that proves they are one event? A real name
 * (Nvidia, Hegseth) is enough; an institution alone needs MIN_TOPIC_WORDS
 * shared words besides it that say what happened.
 */
export function sharedName(pa, pb) {
  return headlineNames(pa, pb).proves;
}

/**
 * The names the two headlines share. `proves`: a real name, or an
 * institution plus MIN_TOPIC_WORDS words that say what happened.
 * `different`: how many different real (non-institution) names they share,
 * where name words side by side in both headlines ("Jensen Huang") are one.
 */
function headlineNames(pa, pb) {
  let institution = false;
  let topic = 0;
  const names = [];
  for (const w of pa.title) {
    if (!pb.title.has(w)) continue;
    const isName = /^\p{L}/u.test(w) && !pa.lower.has(w) && !pb.lower.has(w) && (pa.capitals.has(w) || pb.capitals.has(w));
    if (isName && !INSTITUTIONS.has(w)) names.push(w);
    else if (isName) institution = true;
    else if (!GENERIC.has(w)) topic++;
  }
  let different = 0;
  const at = (p, w) => p.words.indexOf(w);
  names.sort((x, y) => at(pa, x) - at(pa, y)).forEach((w, k) => {
    const prev = names[k - 1];
    const sideBySide = prev && at(pa, w) === at(pa, prev) + 1 && at(pb, w) === at(pb, prev) + 1;
    if (!sideBySide) different++;
  });
  return { different, proves: names.length > 0 || (institution && topic >= MIN_TOPIC_WORDS) };
}

/** Index pairs [i, j] of the longest run of words the two lists share in the same order. */
function inOrder(a, b) {
  const len = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      len[i][j] = a[i] === b[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
    }
  }
  const pairs = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (len[i + 1][j] >= len[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Are two headlines one pattern with a word swapped? (See THE RULE above.)
 * True when they share at least TEMPLATE_SHARE of the longer headline's
 * words in the same order, and somewhere between the same shared words (or
 * before the first, or after the last) each has a word of its own that the
 * other story, headline or snippet, never uses, and that says more than
 * GENERIC filler. Two different shared names lift it (see above), except
 * for a swap of OPPOSITES.
 */
export function swappedSlot(pa, pb) {
  const pairs = inOrder(pa.words, pb.words);
  if (pairs.length < TEMPLATE_SHARE * Math.max(pa.words.length, pb.words.length)) return false;
  const lifted = headlineNames(pa, pb).different >= 2;
  const own = (words, other) => words.filter((w) => !other.all.has(w) && !GENERIC.has(w));
  const anchors = [[-1, -1], ...pairs, [pa.words.length, pb.words.length]];
  for (let k = 1; k < anchors.length; k++) {
    const [i0, j0] = anchors[k - 1];
    const [i1, j1] = anchors[k];
    const ownA = own(pa.words.slice(i0 + 1, i1), pb);
    const ownB = own(pb.words.slice(j0 + 1, j1), pa);
    if (ownA.length && ownB.length && (!lifted || opposite(ownA, ownB))) return true;
  }
  return false;
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
  if (!sharedName(pa, pb)) return 0;
  if (swappedSlot(pa, pb)) return 0;
  return shared;
}

/** Are two stories about the same event? */
export const sameEvent = (a, b) => matchScore(a, b) > 0;

/**
 * Place every story that has no event yet.
 * `stories`: rows with guid, title, snippet, published_at.
 * `linked`: Map guid -> event key, for stories that already have one (kept as is).
 * Stories are placed oldest first. Each joins the event, among those it
 * matches at least half the stories of, that it matches most of (then by
 * total score), or starts a new event keyed by its own guid. Returns { links: [{story_guid, event_key}], events: [{key, ...}] }
 * holding only what is new this time.
 */
export function assignEvents(stories, linked = new Map()) {
  const unique = new Map();
  for (const s of stories) if (s && s.guid && !unique.has(s.guid)) unique.set(s.guid, s);
  const ordered = [...unique.values()].sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at) || (a.guid < b.guid ? -1 : 1));

  const members = new Map(); // event key -> profiles of its stories
  const add = (key, p) => { if (!members.has(key)) members.set(key, []); members.get(key).push(p); };
  for (const s of ordered) if (linked.has(s.guid)) add(linked.get(s.guid), profile(s));

  const links = [];
  const newEvents = new Map();
  for (const s of ordered) {
    if (linked.has(s.guid)) continue;
    const p = profile(s);
    let best = null;
    let bestHits = 0;
    let bestScore = 0;
    for (const [key, ps] of members) {
      let hits = 0;
      let score = 0;
      for (const other of ps) {
        const m = matchScore(p, other);
        if (m > 0) { hits++; score += m; }
      }
      if (hits * 2 < ps.length) continue; // must match at least half of the event's stories
      if (hits > bestHits || (hits === bestHits && score > bestScore)) { best = key; bestHits = hits; bestScore = score; }
    }
    const key = best ?? s.guid;
    if (!best) newEvents.set(key, { key, first_published_at: s.published_at });
    add(key, p);
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

/** The key of the event a story split out of its event gets. */
export const splitKey = (storyGuid) => `split:${storyGuid}`;

/**
 * Change a story's event, for PP-5's check (see THE RULE IS A FIRST PASS).
 * `toEvent`: the key of an existing event to move it into. Left out, the
 * story is split off into an event of its own, keyed `splitKey(guid)`
 * (written if it is not there yet), so a repeated split lands on the same key.
 * The write is guarded on the story's current event and read back, so a
 * story moved underneath this call is reported, not overwritten.
 * Never throws. Returns { moved, from, to, error }: `moved` false with no
 * error means the story was already there.
 */
export async function moveStory(supabase, storyGuid, { toEvent } = {}) {
  const res = { moved: false, from: null, to: null, error: null };
  const fail = (msg) => { res.error = `events move ${storyGuid}: ${msg}`; return res; };
  try {
    const cur = await supabase.from("story_events").select("event_key").eq("story_guid", storyGuid).maybeSingle();
    if (cur.error) return fail(`read link: ${cur.error.message}`);
    if (!cur.data) return fail("the story has no event yet");
    res.from = cur.data.event_key;
    res.to = toEvent || splitKey(storyGuid);
    if (res.to === res.from) return res;

    if (toEvent) {
      const ev = await supabase.from("events").select("key").eq("key", toEvent).maybeSingle();
      if (ev.error) return fail(`read event: ${ev.error.message}`);
      if (!ev.data) return fail(`no event with key ${toEvent}`);
    } else {
      const st = await supabase.from("stories").select("published_at").eq("guid", storyGuid).maybeSingle();
      if (st.error) return fail(`read story: ${st.error.message}`);
      if (!st.data) return fail("no such story");
      const up = await supabase.from("events").upsert([{ key: res.to, first_published_at: st.data.published_at }], { onConflict: "key", ignoreDuplicates: true });
      if (up.error) return fail(`write event: ${up.error.message}`);
    }

    const w = await supabase.from("story_events")
      .update({ event_key: res.to, linked_by: "check", linked_at: new Date().toISOString() })
      .eq("story_guid", storyGuid).eq("event_key", res.from)
      .select("story_guid,event_key");
    if (w.error) return fail(`write link: ${w.error.message}`);
    if (!w.data || w.data.length !== 1 || w.data[0].event_key !== res.to) {
      return fail(`the link did not change (its event moved from ${res.from} underneath this call)`);
    }
    res.moved = true;
    return res;
  } catch (err) {
    return fail(err.message);
  }
}
