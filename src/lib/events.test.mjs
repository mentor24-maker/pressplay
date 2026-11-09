import { test } from "node:test";
import assert from "node:assert/strict";
import { keyWords, sameEvent, assignEvents, countEvents, linkEvents, LINK_BATCH, PAGE_ROWS } from "./events.js";

const NOW = Date.parse("2026-11-09T18:00:00Z");
const at = (hoursAgo) => new Date(NOW - hoursAgo * 36e5).toISOString();
let n = 0;
const story = (title, snippet = "", hoursAgo = 1, guid = `g${++n}`) => ({ guid, title, snippet, published_at: at(hoursAgo) });

// Pairs written the way different outlets really headline one event.
const SAME = [
  [
    story("Denver city council approves $2 billion budget after marathon session", "Council members voted 9-4 to pass the budget, which funds transit and housing."),
    story("Council passes Denver budget in late-night vote", "The Denver City Council approved a $2 billion spending plan early Tuesday."),
  ],
  [
    story("Magnitude 6.8 earthquake strikes off coast of Japan, tsunami warning issued", "The quake hit near Hokkaido on Monday evening."),
    story("Tsunami warning after strong earthquake hits northern Japan", "A magnitude 6.8 quake struck off Hokkaido, Japan's meteorological agency said."),
  ],
  [
    story("Nvidia posts record quarterly revenue as AI chip demand surges", "Revenue rose 94% from a year earlier on data-center sales."),
    story("Nvidia's revenue hits record on AI demand, shares climb", "The chipmaker's quarterly revenue beat estimates as demand for AI chips grew."),
  ],
];

// Pairs that share a word or a place but are different events.
const DIFFERENT = [
  [
    story("Denver city council approves $2 billion budget", "Council members voted 9-4 to pass the budget."),
    story("Denver Broncos beat Chiefs in overtime thriller", "Denver won 27-24 at home on Sunday."),
  ],
  [
    story("Earthquake strikes off coast of Japan", "The quake hit near Hokkaido."),
    story("Japan's central bank holds interest rates steady", "The Bank of Japan left rates unchanged on Tuesday."),
  ],
  [
    story("Apple unveils new iPhone at September event", "The company showed its latest phones and watches."),
    story("Microsoft unveils new Surface laptops", "The company showed its latest laptops and tablets."),
  ],
];

test("key words drop common words and plurals", () => {
  assert.deepEqual([...keyWords("The Council's votes say Cities: 9-4 after a long night")], ["council", "vote", "city", "long", "night"]);
  assert.ok(keyWords("Says new report on <b>budget</b> &amp; taxes").has("budget"));
});

test("two outlets' headlines about the same event match", () => {
  for (const [a, b] of SAME) assert.ok(sameEvent(a, b), `${a.title} / ${b.title}`);
});

test("unrelated stories do not match, even when they share a place or a word", () => {
  for (const [a, b] of DIFFERENT) assert.equal(sameEvent(a, b), false, `${a.title} / ${b.title}`);
});

test("the same headlines more than 48 hours apart are not one event", () => {
  const [a, b] = SAME[0];
  assert.equal(sameEvent({ ...a, published_at: at(1) }, { ...b, published_at: at(50) }), false);
});

test("a mixed batch makes one event per real event", () => {
  const all = [...SAME.flat(), ...DIFFERENT.flat()];
  const { links, events } = assignEvents(all);
  assert.equal(links.length, all.length, "every story gets an event");
  const eventOf = new Map(links.map((l) => [l.story_guid, l.event_key]));
  for (const [a, b] of SAME) assert.equal(eventOf.get(a.guid), eventOf.get(b.guid));
  // DIFFERENT[0][0] is the Denver budget again, so it joins SAME[0]'s event; the rest are on their own.
  assert.equal(eventOf.get(DIFFERENT[0][0].guid), eventOf.get(SAME[0][0].guid));
  assert.equal(eventOf.get(DIFFERENT[1][0].guid), eventOf.get(SAME[1][0].guid));
  assert.notEqual(eventOf.get(DIFFERENT[0][1].guid), eventOf.get(SAME[0][0].guid));
  assert.notEqual(eventOf.get(DIFFERENT[1][1].guid), eventOf.get(SAME[1][0].guid));
  assert.notEqual(eventOf.get(DIFFERENT[2][0].guid), eventOf.get(DIFFERENT[2][1].guid));
  assert.equal(events.length, 3 + 4, "three shared events, four stories on their own");
  assert.equal(new Set(links.map((l) => l.event_key)).size, events.length);
  assert.deepEqual(countEvents(all), { stories: all.length, events: 7, multiSource: 3 });
});

test("an event's key is the guid of its oldest story, whatever order the stories come in", () => {
  const a = story("Tsunami warning after strong earthquake hits northern Japan", "", 5, "older");
  const b = story("Magnitude 6.8 earthquake strikes Japan, tsunami warning issued", "", 1, "newer");
  for (const list of [[a, b], [b, a]]) {
    const { events, links } = assignEvents(list);
    assert.deepEqual(events.map((e) => e.key), ["older"]);
    assert.deepEqual(links.map((l) => l.event_key), ["older", "older"]);
  }
});

test("a story already linked keeps its event and a new story joins it", () => {
  const [a, b] = SAME[1];
  const { links, events } = assignEvents([a, b], new Map([[a.guid, "evt-existing"]]));
  assert.deepEqual(events, [], "no new event");
  assert.deepEqual(links, [{ story_guid: b.guid, event_key: "evt-existing" }]);
});

/** A stand-in for the Supabase client that keeps rows like the real tables would. */
function fakeSupabase({ stories = [], fail = {} } = {}) {
  const db = { events: new Map(), story_events: new Map() };
  const calls = [];
  const err = (k) => (fail[k] ? { error: { message: "boom" } } : null);
  const from = (table) => ({
    select: () => {
      if (table === "stories") {
        const q = { since: null };
        const chain = {
          gte: (_c, v) => { q.since = v; return chain; },
          order: () => chain,
          range: async (lo, hi) => {
            calls.push({ table, op: "select", lo, hi });
            if (err("stories:select")) return err("stories:select");
            const rows = stories.filter((s) => s.published_at >= q.since)
              .sort((x, y) => x.published_at.localeCompare(y.published_at) || x.guid.localeCompare(y.guid));
            return { data: rows.slice(lo, hi + 1), error: null };
          },
        };
        return chain;
      }
      return { in: async (_c, vals) => {
        calls.push({ table, op: "select", vals });
        if (err(`${table}:select`)) return err(`${table}:select`);
        return { data: vals.filter((g) => db.story_events.has(g)).map((g) => ({ story_guid: g, event_key: db.story_events.get(g) })), error: null };
      } };
    },
    upsert: async (rows, opts) => {
      calls.push({ table, op: "upsert", rows, opts });
      if (err(`${table}:upsert`)) return err(`${table}:upsert`);
      const keyCol = table === "events" ? "key" : "story_guid";
      let count = 0;
      for (const r of rows) {
        if (db[table].has(r[keyCol])) continue; // ignoreDuplicates
        db[table].set(r[keyCol], table === "events" ? r : r.event_key);
        count++;
      }
      return { error: null, count };
    },
  });
  return { from, calls, db };
}

test("the grouping step writes events and links, and running it again duplicates nothing", async () => {
  const stories = [...SAME.flat(), DIFFERENT[2][0]];
  const sb = fakeSupabase({ stories });
  const first = await linkEvents(sb, { now: NOW });
  assert.deepEqual(first, { considered: 7, linked: 7, newEvents: 4, errors: [], failed: null });
  assert.equal(sb.db.events.size, 4);
  assert.equal(sb.db.story_events.size, 7);

  const before = sb.calls.length;
  const again = await linkEvents(sb, { now: NOW });
  assert.deepEqual(again, { considered: 7, linked: 0, newEvents: 0, errors: [], failed: null });
  assert.equal(sb.calls.slice(before).some((c) => c.op === "upsert"), false, "nothing written the second time");
  assert.equal(sb.db.events.size, 4);
});

test("a story arriving on a later run joins the event already there", async () => {
  const [a, b] = SAME[2];
  const stories = [a];
  const sb = fakeSupabase({ stories });
  await linkEvents(sb, { now: NOW });
  stories.push(b);
  const res = await linkEvents(sb, { now: NOW });
  assert.equal(res.newEvents, 0);
  assert.equal(res.linked, 1);
  assert.equal(sb.db.story_events.get(b.guid), sb.db.story_events.get(a.guid));
});

test("a run repeated after the link write failed lands on the same events", async () => {
  const stories = SAME.flat();
  const sb = fakeSupabase({ stories, fail: { "story_events:upsert": true } });
  const broken = await linkEvents(sb, { now: NOW });
  assert.equal(broken.failed, "write links");
  assert.match(broken.errors[0], /^supabase \(events write links\): boom$/);
  assert.equal(sb.db.events.size, 3);
  const ok = fakeSupabase({ stories });
  ok.db.events = sb.db.events; // same database, write now works
  const res = await linkEvents(ok, { now: NOW });
  assert.equal(res.failed, null);
  assert.equal(res.newEvents, 0, "the events from the failed run are reused, not duplicated");
  assert.equal(ok.db.events.size, 3);
  assert.equal(res.linked, 6);
});

test("a failed read stops the step and says which one", async () => {
  for (const [k, step] of [["stories:select", "read stories"], ["story_events:select", "read links"]]) {
    const sb = fakeSupabase({ stories: SAME.flat(), fail: { [k]: true } });
    const res = await linkEvents(sb, { now: NOW });
    assert.equal(res.failed, step);
    assert.equal(sb.calls.some((c) => c.op === "upsert"), false, "nothing written on a failed read");
  }
});

test("stories older than the window are left out, and big runs are read in pages and batches", async () => {
  const many = Array.from({ length: PAGE_ROWS + 3 }, (_, i) => story(`zeta${i} alpha${i} omega${i}`, "", 1 + i / 100, `m${i}`));
  const old = story("Ancient story", "", 60, "old");
  const sb = fakeSupabase({ stories: [...many, old] });
  const res = await linkEvents(sb, { now: NOW });
  assert.equal(res.considered, many.length);
  assert.equal(res.failed, null);
  assert.equal(sb.db.story_events.has("old"), false);
  assert.equal(sb.calls.filter((c) => c.table === "stories").length, 2, "two pages");
  const lookups = sb.calls.filter((c) => c.table === "story_events" && c.op === "select");
  assert.equal(lookups.length, Math.ceil(many.length / LINK_BATCH));
  assert.ok(lookups.every((c) => c.vals.length <= LINK_BATCH));
});

// Wrong groupings the first version of the rule made on the live feeds (2026-11-09): kept apart now.
const LIVE_LOOKALIKES = [
  [
    story("Stronger flu shot linked to nearly 55% lower Alzheimer's risk", "A surprising new study suggests that a stronger flu shot could offer older adults greater protection against Alzheimer's disease."),
    story("Common osteoporosis drugs linked to 24% lower dementia risk in major study", "A massive study of more than 120,000 older adults suggests that common osteoporosis drugs may reduce the risk of Alzheimer's disease."),
  ],
  [
    story("Women's AP Top 25 poll reaction: South Carolina on top, Michigan rising", "The first in-season poll is out, and we have what you need to know about all 25 teams."),
    story("Men's AP Top 25 poll week 1 breakdown: Florida, Duke are 1-2", "Stats, records and upcoming games for the Top 25 teams in the men's AP poll."),
  ],
  [
    story("MIT scientists turn immune cells into cancer killers inside the body", "Researchers reprogrammed immune cells to attack cancer."),
    story("Scientists wipe out deadly brain tumors in every mouse tested with new cancer therapy", "A new cancer therapy cleared tumors in mice."),
  ],
];

test("stories on the same topic but not the same event stay apart (cases seen on the live feeds)", () => {
  for (const [a, b] of LIVE_LOOKALIKES) assert.equal(sameEvent(a, b), false, `${a.title} / ${b.title}`);
});

test("a headline in Title Case still matches one in sentence case", () => {
  assert.ok(sameEvent(
    story("Thomas Massie Moves to Force Vote on Impeaching Pete Hegseth", "The Kentucky Republican said he would force a vote."),
    story("Thomas Massie files articles of impeachment against Defense Secretary Pete Hegseth", "Massie filed the articles on Monday."),
  ));
});
