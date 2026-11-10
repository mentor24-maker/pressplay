import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import {
  writeFactSheets, eventsDue, readAnswer, spentThisMonth, costOf, worstCaseCost, reportLine, storySet, monthOf, buildPrompt,
  MONTHLY_CAP_USD, MAX_INPUT_CHARS, MAX_OUTPUT_TOKENS, LONG_PROMPT_TOKENS, MODEL, SCHEMA, MAX_UNFINISHED_TRIES, CALL_LIMIT_MS, RUN_BUDGET_MS,
} from "./factSheets.js";

const NOW = Date.parse("2026-11-09T18:00:00Z");
const BODY_SECRET = "FULL-COPY-TEXT-THAT-MUST-NEVER-BE-LOGGED";

/** A small in-memory Supabase: just the query shapes this module and moveStory use. */
function fakeDb(seed = {}, { fail = {} } = {}) {
  const keys = { stories: "guid", story_bodies: "story_guid", story_events: "story_guid", events: "key", fact_sheets: "event_key", ai_spend: "id" };
  const t = Object.fromEntries(Object.keys(keys).map((k) => [k, (seed[k] || []).map((r) => ({ ...r }))]));
  let nextId = 1;
  const calls = [];
  const from = (table) => {
    const q = { op: "select", filters: [], range: null, rows: null, patch: null, single: false, ret: false };
    const match = (r) => q.filters.every(([kind, c, v]) => (kind === "eq" ? r[c] === v : v.includes(r[c])));
    const run = () => {
      calls.push({ table, op: q.op });
      if (fail[`${table}:${q.op}`]) return { data: null, error: { message: "boom" } };
      const rows = t[table];
      if (q.op === "select") {
        let out = rows.filter(match);
        if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
        if (q.single) return { data: out[0] ? { ...out[0] } : null, error: null };
        return { data: out.map((r) => ({ ...r })), error: null };
      }
      if (q.op === "insert") {
        const added = q.rows.map((r) => ({ id: nextId++, ...r }));
        rows.push(...added);
        return { data: added.map((r) => ({ ...r })), error: null };
      }
      if (q.op === "update") {
        if (fail[`${table}:update-lost`]) return { data: [], error: null };
        const hit = rows.filter(match);
        hit.forEach((r) => Object.assign(r, q.patch));
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (q.op === "upsert") {
        const k = keys[table];
        const out = [];
        for (const r of q.rows) {
          const old = rows.find((x) => x[k] === r[k]);
          if (old && q.patch?.ignoreDuplicates) continue;
          if (old) Object.assign(old, r); else rows.push({ ...r });
          out.push({ ...r });
        }
        return { data: out, error: null, count: out.length };
      }
    };
    const b = {
      select: () => { if (q.op !== "select") q.ret = true; return b; },
      eq: (c, v) => { q.filters.push(["eq", c, v]); return b; },
      in: (c, v) => { q.filters.push(["in", c, v]); return b; },
      order: () => b,
      range: (lo, hi) => { q.range = [lo, hi]; return b; },
      maybeSingle: () => { q.single = true; return b; },
      insert: (rows) => { q.op = "insert"; q.rows = rows; return b; },
      update: (patch) => { q.op = "update"; q.patch = patch; return b; },
      upsert: (rows, opts) => { q.op = "upsert"; q.rows = rows; q.patch = opts; return b; },
      then: (ok, bad) => Promise.resolve().then(run).then(ok, bad),
    };
    return b;
  };
  return { from, t, calls };
}

const story = (guid, source, title, hoursAgo = 2) => ({ guid, source, title, url: `https://x/${guid}`, published_at: new Date(NOW - hoursAgo * 36e5).toISOString() });

/** Three stories in one event from three outlets, plus the full copy of each. */
function seed({ extra = [] } = {}) {
  const stories = [
    story("a", "NPR", "Denver council passes $2 billion budget", 3),
    story("b", "BBC", "Denver approves budget in late vote", 2),
    story("c", "AP", "Denver budget clears council 9-4", 1),
    ...extra,
  ];
  return {
    stories,
    story_bodies: stories.map((s) => ({ story_guid: s.guid, source: s.source, body: `${BODY_SECRET} ${s.title}`, method: "feed", fetched_at: s.published_at })),
    events: [{ key: "a", first_published_at: stories[0].published_at }],
    story_events: stories.map((s) => ({ story_guid: s.guid, event_key: "a", linked_by: "rule" })),
    fact_sheets: [],
    ai_spend: [],
  };
}

const GOOD = {
  belongs: ["S1", "S2", "S3"],
  outsiders: [],
  event: "Denver's city council passed a $2 billion budget.",
  facts: [
    { fact: "The council approved a $2 billion budget.", sources: ["S1", "S2", "S3"] },
    { fact: "The vote was 9-4.", sources: ["S3"] },
  ],
  disagreements: [{ about: "When the vote happened", accounts: [{ claim: "Late Monday", sources: ["S2"] }, { claim: "Early Tuesday", sources: ["S1"] }] }],
};

/**
 * A stand-in for the Anthropic client's streamed call: answers with `answer`,
 * counts and keeps each request and its signal. `hang` never answers until
 * the call's signal stops it, like a reply that takes too long.
 */
function fakeClaude(answer = GOOD, { usage = { input_tokens: 5000, output_tokens: 2000 }, stop = "end_turn", throws = null, hang = false } = {}) {
  const requests = [];
  const signals = [];
  return {
    requests,
    signals,
    messages: {
      stream: (params, opts = {}) => {
        requests.push(params);
        signals.push(opts.signal);
        return {
          finalMessage: async () => {
            // A real call holds a connection open; the stand-in holds a timer, so the test waits for the signal.
            if (hang) {
              const hold = setInterval(() => {}, 1000);
              await new Promise((_, no) => opts.signal.addEventListener("abort", () => { clearInterval(hold); no(new Anthropic.APIUserAbortError()); }, { once: true }));
            }
            if (throws) throw throws;
            const a = typeof answer === "function" ? answer(params) : answer;
            return { stop_reason: stop, usage, content: [{ type: "text", text: typeof a === "string" ? a : JSON.stringify(a) }] };
          },
        };
      },
    },
  };
}

/** Add a story, with its full copy, to an event in a fake database. */
function addStory(db, s, eventKey = "a") {
  db.t.stories.push(s);
  db.t.story_bodies.push({ story_guid: s.guid, source: s.source, body: `${BODY_SECRET} ${s.title}`, method: "feed", fetched_at: s.published_at });
  db.t.story_events.push({ story_guid: s.guid, event_key: eventKey, linked_by: "rule" });
}

test("an event with three outlets gets a fact sheet whose every fact names its outlets, with the disagreements", async () => {
  const db = fakeDb(seed());
  const claude = fakeClaude();
  const r = await writeFactSheets(db, { client: claude, now: NOW });
  assert.equal(r.failed, null, r.errors.join("; "));
  assert.equal(r.written, 1);
  const [sheet] = db.t.fact_sheets;
  assert.equal(sheet.event_key, "a");
  assert.deepEqual(sheet.sources, ["AP", "BBC", "NPR"]);
  assert.deepEqual(sheet.facts[0].sources.map((s) => s.source).sort(), ["AP", "BBC", "NPR"]);
  assert.deepEqual(sheet.facts[1].sources, [{ source: "AP", guid: "c" }]);
  for (const f of sheet.facts) assert.ok(f.sources.length >= 1);
  assert.equal(sheet.disagreements.length, 1);
  assert.deepEqual(sheet.disagreements[0].accounts.map((a) => a.sources[0].source), ["BBC", "NPR"]);
  assert.deepEqual(sheet.story_guids, ["a", "b", "c"]);

  // The request: the right model, the JSON schema, every outlet's full copy.
  const [req] = claude.requests;
  assert.equal(req.model, MODEL);
  assert.ok(claude.signals[0] instanceof AbortSignal, "the streamed call carries its time limit");
  assert.deepEqual(req.output_config.format, { type: "json_schema", schema: SCHEMA });
  for (const s of ["NPR", "BBC", "AP"]) assert.ok(req.messages[0].content.includes(`Outlet: ${s}`));
  assert.ok(req.messages[0].content.includes(BODY_SECRET));

  // Spend: booked, then settled at the real cost.
  const [spend] = db.t.ai_spend;
  assert.equal(spend.outcome, "written");
  assert.equal(spend.cost_usd, costOf({ input_tokens: 5000, output_tokens: 2000 }));
  assert.equal(spend.month, "2026-11");
});

test("running again does not send the same event twice", async () => {
  const db = fakeDb(seed());
  const claude = fakeClaude();
  await writeFactSheets(db, { client: claude, now: NOW });
  const again = await writeFactSheets(db, { client: claude, now: NOW });
  assert.equal(again.due, 0);
  assert.equal(claude.requests.length, 1);
});

test("a new story joining the event makes it due again", async () => {
  const db = fakeDb(seed());
  await writeFactSheets(db, { client: fakeClaude(), now: NOW });
  const d = story("d", "Reuters", "Denver passes budget", 0.5);
  db.t.stories.push(d);
  db.t.story_bodies.push({ story_guid: "d", source: "Reuters", body: "text", method: "feed", fetched_at: d.published_at });
  db.t.story_events.push({ story_guid: "d", event_key: "a", linked_by: "rule" });
  const due = await eventsDue(db);
  assert.deepEqual(due.map((e) => e.key), ["a"]);
  assert.equal(due[0].stories.length, 4);
});

test("an event with only one outlet, or stories without full copy, is not due", async () => {
  const s = seed();
  s.story_bodies = s.story_bodies.filter((b) => b.story_guid === "a"); // only NPR has full copy
  assert.deepEqual(await eventsDue(fakeDb(s)), []);
  const t = seed();
  t.story_bodies.forEach((b) => { b.source = "NPR"; }); // three stories, one outlet
  assert.deepEqual(await eventsDue(fakeDb(t)), []);
});

test("an event left with no stories is skipped", async () => {
  const s = seed();
  s.events.push({ key: "empty", first_published_at: s.stories[0].published_at });
  const due = await eventsDue(fakeDb(s));
  assert.deepEqual(due.map((e) => e.key), ["a"]);
});

test("the check splits off a story about a different event, and the sheet is written from the rest", async () => {
  const db = fakeDb(seed({ extra: [story("z", "CNN", "Denver Broncos win in overtime", 1)] }));
  const answer = (params) => {
    const ids = [...params.messages[0].content.matchAll(/<article id="(S\d+)">\nOutlet: (\w+)/g)];
    const cnn = ids.find(([, , o]) => o === "CNN")[1];
    const rest = ids.filter(([, id]) => id !== cnn).map(([, id]) => id);
    return { ...GOOD, belongs: rest, outsiders: [{ ids: [cnn], reason: "a football game" }], facts: [{ fact: "The council approved a budget.", sources: rest }], disagreements: [] };
  };
  const r = await writeFactSheets(db, { client: fakeClaude(answer), now: NOW });
  assert.equal(r.failed, null, r.errors.join("; "));
  assert.equal(r.split, 1);
  const z = db.t.story_events.find((l) => l.story_guid === "z");
  assert.equal(z.event_key, "split:z");
  assert.equal(z.linked_by, "check");
  assert.ok(db.t.events.some((e) => e.key === "split:z"));
  const [sheet] = db.t.fact_sheets;
  assert.deepEqual(sheet.story_guids, ["a", "b", "c"]);
  assert.ok(!sheet.sources.includes("CNN"));
  // The event now holds exactly the stories its sheet was written from: not due again.
  assert.deepEqual(await eventsDue(db), []);
});

test("when the check leaves only one outlet, no sheet is written and the event is not sent again", async () => {
  const s = seed();
  s.stories = s.stories.slice(0, 2); s.story_bodies = s.story_bodies.slice(0, 2); s.story_events = s.story_events.slice(0, 2);
  const db = fakeDb(s);
  const claude = fakeClaude({ ...GOOD, belongs: ["S1"], outsiders: [{ ids: ["S2"], reason: "different" }], facts: [], disagreements: [] });
  const r = await writeFactSheets(db, { client: claude, now: NOW });
  assert.equal(r.failed, null, r.errors.join("; "));
  assert.equal(r.noSheet, 1);
  assert.equal(r.written, 0);
  assert.equal(db.t.fact_sheets.length, 0);
  assert.equal(db.t.ai_spend[0].outcome, "no_sheet");
  await writeFactSheets(db, { client: claude, now: NOW });
  assert.equal(claude.requests.length, 1);
});

test("the cap: no call is made once the month's spend has reached $10, and the step says so", async () => {
  const s = seed();
  s.ai_spend = [{ id: 900, month: "2026-11", purpose: "fact_sheet", model: MODEL, reserved_usd: "1.000000", cost_usd: "10.000000", outcome: "written" }];
  const db = fakeDb(s);
  const claude = fakeClaude();
  const r = await writeFactSheets(db, { client: claude, now: NOW });
  assert.equal(claude.requests.length, 0, "Claude was not called");
  assert.deepEqual(r.capped, { month: "2026-11", spent: 10, cap: MONTHLY_CAP_USD });
  assert.equal(db.t.ai_spend.at(-1).outcome, "over_cap");
  assert.equal(db.t.ai_spend.at(-1).cost_usd, 0, "the cancelled booking no longer counts");
  assert.match(reportLine(r), /STOPPED: the monthly cap is reached \(\$10\.00 of \$10\.00 in 2026-11\)/);
});

test("the cap: with $9.99 spent, a call whose worst case still fits under $10 is made, and the month stays under $10", async () => {
  const s = seed();
  s.ai_spend = [{ id: 900, month: "2026-11", purpose: "fact_sheet", model: MODEL, reserved_usd: "1.000000", cost_usd: "9.990000", outcome: "written" }];
  const db = fakeDb(s);
  const claude = fakeClaude();
  const r = await writeFactSheets(db, { client: claude, now: NOW });
  assert.equal(claude.requests.length, 1, "a call under a cent fits in the cent that is left");
  assert.equal(r.written, 1);
  assert.ok(await spentThisMonth(db, NOW) <= MONTHLY_CAP_USD);
});

test("the cap counts last month's spend separately, and a booking that never settled counts at its worst case", async () => {
  const s = seed();
  s.ai_spend = [
    { id: 1, month: "2026-10", reserved_usd: "0.5", cost_usd: "60", outcome: "written" },
    { id: 2, month: "2026-11", reserved_usd: "0.7", cost_usd: null, outcome: "booked" },
    { id: 3, month: "2026-11", reserved_usd: "0.7", cost_usd: "0.2", outcome: "written" },
  ];
  assert.equal(Math.round((await spentThisMonth(fakeDb(s), NOW)) * 100) / 100, 0.9);
  const r = await writeFactSheets(fakeDb(s), { client: fakeClaude(), now: NOW });
  assert.equal(r.written, 1, "October's $60 does not stop November");
});

test("the cap is checked before every call, so a run stops partway through when it is reached", async () => {
  const s = seed();
  const more = [story("p", "NPR", "Storm hits coast", 1), story("q", "BBC", "Storm batters coast", 1)];
  s.stories.push(...more);
  s.story_bodies.push(...more.map((m) => ({ story_guid: m.guid, source: m.source, body: "text", method: "feed", fetched_at: new Date(NOW).toISOString() })));
  s.events.push({ key: "p", first_published_at: more[0].published_at });
  s.story_events.push(...more.map((m) => ({ story_guid: m.guid, event_key: "p", linked_by: "rule" })));
  // Room for one call's worst case, not two.
  s.ai_spend = [{ id: 900, month: "2026-11", reserved_usd: "0", cost_usd: String(MONTHLY_CAP_USD - worstCaseCost(5000)), outcome: "written" }];
  const db = fakeDb(s);
  const claude = fakeClaude((p) => (p.messages[0].content.includes("Storm")
    ? { ...GOOD, belongs: ["S1", "S2"], facts: [{ fact: "A storm hit.", sources: ["S1", "S2"] }], disagreements: [] }
    : GOOD), { usage: { input_tokens: 1000, output_tokens: 15000 } });
  const r = await writeFactSheets(db, { client: claude, now: NOW });
  assert.equal(claude.requests.length, 1);
  assert.equal(r.written, 1);
  assert.ok(r.capped, "stopped at the cap");
  assert.ok(await spentThisMonth(db, NOW) <= MONTHLY_CAP_USD);
});

test("every booking is the worst case, so a call can never cost more than it booked", () => {
  const chars = 40000;
  const realistic = costOf({ input_tokens: Math.ceil(chars / 4) + 1500, output_tokens: 16000 });
  assert.ok(worstCaseCost(chars) >= realistic);
});

test("the worst case of the longest event allowed covers a prompt billed at the higher price (over 100,000 tokens)", () => {
  const realistic = costOf({ input_tokens: Math.ceil(MAX_INPUT_CHARS / 2.5) + 1500, output_tokens: MAX_OUTPUT_TOKENS });
  assert.ok(Math.ceil(MAX_INPUT_CHARS / 2.5) + 1500 > LONG_PROMPT_TOKENS, "this prompt is over the line");
  assert.ok(worstCaseCost(MAX_INPUT_CHARS) >= realistic);
});

test("an answer that names a story outside the event, or misses one, is refused and nothing is stored", async () => {
  const cases = [
    { ...GOOD, facts: [{ fact: "x", sources: ["S9"] }] },
    { ...GOOD, belongs: ["S1", "S2"] },
    { ...GOOD, belongs: ["S1", "S2", "S3"], outsiders: [{ ids: ["S3"], reason: "" }] },
    { ...GOOD, belongs: ["S1", "S2"], outsiders: [{ ids: [], reason: "" }, { ids: ["S3"], reason: "" }] },
    { ...GOOD, facts: [{ fact: "x", sources: [] }] },
    { ...GOOD, facts: [] },
    "not json",
  ];
  for (const answer of cases) {
    const db = fakeDb(seed());
    const r = await writeFactSheets(db, { client: fakeClaude(answer), now: NOW });
    assert.equal(r.failed, "read answer", JSON.stringify(answer));
    assert.equal(db.t.fact_sheets.length, 0);
    assert.equal(db.t.ai_spend[0].outcome, "invalid", "the money spent is still counted");
    assert.ok(db.t.ai_spend[0].cost_usd > 0);
    assert.equal(db.t.story_events.filter((l) => l.linked_by === "check").length, 0, "nothing was moved");
  }
});

test("a reply cut off at the token limit is refused", async () => {
  const db = fakeDb(seed());
  const r = await writeFactSheets(db, { client: fakeClaude(GOOD, { stop: "max_tokens" }), now: NOW });
  assert.equal(r.failed, "read answer");
  assert.equal(db.t.fact_sheets.length, 0);
});

test("an API error is not charged and is tried again; a lost connection keeps its worst-case booking", async () => {
  const s = seed();
  const db = fakeDb(s);
  const apiErr = new Anthropic.APIError(529, { type: "error" }, "overloaded", new Headers());
  const r = await writeFactSheets(db, { client: fakeClaude(GOOD, { throws: apiErr }), now: NOW });
  assert.equal(r.failed, "ask Claude");
  assert.equal(db.t.ai_spend[0].outcome, "api_error");
  assert.equal(db.t.ai_spend[0].cost_usd, 0);
  assert.equal((await eventsDue(db)).length, 1, "tried again next run");

  const db2 = fakeDb(seed());
  await writeFactSheets(db2, { client: fakeClaude(GOOD, { throws: new Error("socket hang up") }), now: NOW });
  assert.equal(db2.t.ai_spend[0].outcome, "no_answer");
  assert.equal(db2.t.ai_spend[0].cost_usd, undefined, "no real cost is known, so the worst case counts");
  assert.equal(await spentThisMonth(db2, NOW), db2.t.ai_spend[0].reserved_usd);
});

test("without an API key or a database, the step does not run and says why", async () => {
  const noKey = await writeFactSheets(fakeDb(seed()), { client: null, now: NOW });
  assert.equal(reportLine(noKey), "Fact sheets: not run (no ANTHROPIC_API_KEY is set).");
  const noDb = await writeFactSheets(null, { client: fakeClaude(), now: NOW });
  assert.equal(noDb.off, "no database (dry run)");
});

test("an event with too much text is skipped, never cut short, and does not take a run's slot", async () => {
  const s = seed();
  s.story_bodies[0].body = "x".repeat(MAX_INPUT_CHARS);
  const claude = fakeClaude();
  const r = await writeFactSheets(fakeDb(s), { client: claude, now: NOW });
  assert.equal(claude.requests.length, 0);
  assert.equal(r.skipped.length, 1);

  // The big event is the newest, yet the one slot goes to the event that fits.
  const db = fakeDb(seed());
  db.t.story_bodies[0].fetched_at = new Date(NOW).toISOString();
  db.t.story_bodies[0].body = "x".repeat(MAX_INPUT_CHARS);
  const more = [story("p", "NPR", "Storm hits coast", 5), story("q", "BBC", "Storm batters coast", 5)];
  db.t.events.push({ key: "p", first_published_at: more[0].published_at });
  more.forEach((m) => addStory(db, m, "p"));
  const storm = fakeClaude({ ...GOOD, belongs: ["S1", "S2"], facts: [{ fact: "A storm hit.", sources: ["S1", "S2"] }], disagreements: [] });
  const r2 = await writeFactSheets(db, { client: storm, now: NOW, maxEvents: 1 });
  assert.equal(r2.skipped.length, 1);
  assert.equal(r2.written, 1);
  assert.equal(db.t.fact_sheets[0].event_key, "p");
});

test("a reply that takes too long is stopped at the call's limit, counts at its worst case, and is tried at most twice", async () => {
  const db = fakeDb(seed());
  const slow = fakeClaude(GOOD, { hang: true });
  for (let run = 0; run < MAX_UNFINISHED_TRIES + 2; run++) {
    const r = await writeFactSheets(db, { client: slow, now: NOW, callLimitMs: 20 });
    if (run < MAX_UNFINISHED_TRIES) assert.equal(r.failed, "ask Claude");
    else assert.equal(r.due, 0, "it waits for a new story instead of paying again");
  }
  assert.equal(slow.requests.length, MAX_UNFINISHED_TRIES);
  assert.ok(db.t.ai_spend.every((b) => b.outcome === "no_answer" && b.cost_usd === undefined));
  assert.equal(await spentThisMonth(db, NOW), db.t.ai_spend.reduce((n, b) => n + b.reserved_usd, 0));

  // A new story joining the event makes it worth one more try.
  addStory(db, story("d", "Reuters", "Denver passes budget", 0.5));
  assert.deepEqual((await eventsDue(db)).map((e) => e.key), ["a"]);
});

test("a sheet that could not be stored is not paid for again and again", async () => {
  const db = fakeDb(seed(), { fail: { "fact_sheets:upsert": true } });
  const claude = fakeClaude();
  for (let run = 0; run < MAX_UNFINISHED_TRIES + 2; run++) await writeFactSheets(db, { client: claude, now: NOW });
  assert.equal(claude.requests.length, MAX_UNFINISHED_TRIES);
});

test("a new call starts only if a whole one still fits in the run, so the run is never cut off mid-call", async () => {
  assert.ok(RUN_BUDGET_MS < 300_000 && CALL_LIMIT_MS <= RUN_BUDGET_MS, "inside the route's maxDuration");
  const s = seed();
  const more = [story("p", "NPR", "Storm hits coast", 1), story("q", "BBC", "Storm batters coast", 1)];
  s.events.push({ key: "p", first_published_at: more[0].published_at });
  const db = fakeDb(s);
  more.forEach((m) => addStory(db, m, "p"));
  let t = 0;
  const clock = () => t;
  const claude = fakeClaude((p) => {
    t += 100_000; // each call takes 100 s
    return p.messages[0].content.includes("Storm")
      ? { ...GOOD, belongs: ["S1", "S2"], facts: [{ fact: "A storm hit.", sources: ["S1", "S2"] }], disagreements: [] }
      : GOOD;
  });
  const r = await writeFactSheets(db, { client: claude, now: NOW, clock, budgetMs: 270_000, callLimitMs: 200_000 });
  assert.equal(claude.requests.length, 1, "after 100 s, a 200 s call no longer fits in 270 s");
  assert.equal(r.written, 1);
  assert.equal(r.outOfTime, 1);
  assert.match(reportLine(r), /1 left for the next run \(out of time\)/);
  assert.equal((await eventsDue(db)).length, 1, "the next run takes it");
});

test("copy expiring is not a change: the event is not sent again and its sheet is kept", async () => {
  const db = fakeDb(seed());
  const claude = fakeClaude();
  await writeFactSheets(db, { client: claude, now: NOW });
  db.t.story_bodies = db.t.story_bodies.filter((b) => b.story_guid !== "c"); // AP's copy is deleted after 30 days
  assert.deepEqual(await eventsDue(db), []);
  await writeFactSheets(db, { client: claude, now: NOW });
  assert.equal(claude.requests.length, 1);
  assert.deepEqual(db.t.fact_sheets[0].story_guids, ["a", "b", "c"]);

  // Two stories gone and one new: still fewer than the sheet has, so not sent.
  db.t.story_bodies = db.t.story_bodies.filter((b) => b.story_guid !== "b");
  addStory(db, story("d", "Reuters", "Denver passes budget", 0.5));
  assert.deepEqual(await eventsDue(db), []);
  // Another new story: as many as the sheet, with new ones in it, so it is due.
  addStory(db, story("e", "CNN", "Denver budget passes", 0.4));
  assert.deepEqual((await eventsDue(db)).map((e) => e.key), ["a"]);
});

test("a sheet is never replaced by one written from fewer stories", async () => {
  const db = fakeDb(seed());
  await writeFactSheets(db, { client: fakeClaude(), now: NOW });
  db.t.story_bodies = db.t.story_bodies.filter((b) => b.story_guid !== "a"); // NPR's copy expired
  addStory(db, story("d", "Reuters", "Putin to host Xi", 0.5));
  addStory(db, story("e", "CNN", "Xi to visit Moscow", 0.4));
  // The check says the two new ones are a different event: the new sheet would have two stories, the old has three.
  const r = await writeFactSheets(db, { client: fakeClaude({ ...GOOD, belongs: ["S1", "S2"], outsiders: [{ ids: ["S3", "S4"], reason: "other" }], facts: [{ fact: "x", sources: ["S1", "S2"] }], disagreements: [] }), now: NOW });
  assert.equal(r.failed, null, r.errors.join("; "));
  assert.equal(r.keptFuller, 1);
  assert.equal(r.written, 0);
  assert.deepEqual(db.t.fact_sheets[0].story_guids, ["a", "b", "c"]);
  assert.equal(db.t.ai_spend.at(-1).outcome, "kept_fuller");
  assert.match(reportLine(r), /kept the fuller sheet/);
});

test("old sheet stories the check moves to another event do not count for the old sheet", async () => {
  const db = fakeDb(seed());
  await writeFactSheets(db, { client: fakeClaude(), now: NOW });
  addStory(db, story("d", "Reuters", "Denver passes budget", 0.5));
  // Now the check says AP's story (in the old sheet) and the new one are a different event.
  const r = await writeFactSheets(db, { client: fakeClaude({ ...GOOD, belongs: ["S1", "S2"], outsiders: [{ ids: ["S3", "S4"], reason: "other" }], facts: [{ fact: "x", sources: ["S1", "S2"] }], disagreements: [] }), now: NOW });
  assert.equal(r.failed, null, r.errors.join("; "));
  assert.equal(r.written, 1, "the old sheet held a story that is not this event");
  assert.deepEqual(db.t.fact_sheets.find((f) => f.event_key === "a").story_guids, ["a", "b"]);
});

test("outsiders that report the same other event are moved together into one event", async () => {
  const db = fakeDb(seed({ extra: [story("y", "CNN", "Putin to host Xi", 1), story("z", "Fox", "Xi to visit Moscow", 1)] }));
  const answer = (params) => {
    const ids = Object.fromEntries([...params.messages[0].content.matchAll(/<article id="(S\d+)">\nOutlet: (\w+)/g)].map(([, id, o]) => [o, id]));
    return { ...GOOD, belongs: [ids.NPR, ids.BBC, ids.AP], outsiders: [{ ids: [ids.CNN, ids.Fox], reason: "a visit, not sanctions" }], facts: [{ fact: "x", sources: [ids.NPR, ids.BBC] }], disagreements: [] };
  };
  const r = await writeFactSheets(db, { client: fakeClaude(answer), now: NOW });
  assert.equal(r.failed, null, r.errors.join("; "));
  assert.equal(r.split, 2);
  const keyOf = (g) => db.t.story_events.find((l) => l.story_guid === g).event_key;
  assert.equal(keyOf("y"), keyOf("z"), "together");
  assert.match(keyOf("y"), /^split:/);
  // That event has two outlets, so it is due a sheet of its own.
  assert.deepEqual((await eventsDue(db)).map((e) => e.key), [keyOf("y")]);
});

test("a failed database step says so", async () => {
  for (const [k, step] of [["story_bodies:select", "read events"], ["ai_spend:insert", "book spend"], ["fact_sheets:upsert", "write sheet"], ["ai_spend:update-lost", "settle spend"]]) {
    const r = await writeFactSheets(fakeDb(seed(), { fail: { [k]: true } }), { client: fakeClaude(), now: NOW });
    assert.equal(r.failed, step, k);
    assert.match(reportLine(r), /FAILED/);
  }
});

test("article text and the facts never appear in the result, the report or the errors", async () => {
  const outcomes = [
    await writeFactSheets(fakeDb(seed()), { client: fakeClaude(), now: NOW }),
    await writeFactSheets(fakeDb(seed()), { client: fakeClaude({ ...GOOD, facts: [{ fact: BODY_SECRET, sources: ["S7"] }] }), now: NOW }),
    await writeFactSheets(fakeDb(seed(), { fail: { "fact_sheets:upsert": true } }), { client: fakeClaude(), now: NOW }),
  ];
  for (const r of outcomes) {
    const out = JSON.stringify(r) + reportLine(r);
    assert.ok(!out.includes(BODY_SECRET));
    assert.ok(!out.includes("The council approved"));
  }
});

test("helpers: month, cost, fingerprint, prompt", () => {
  assert.equal(monthOf(Date.parse("2026-12-01T03:00:00Z")), "2026-12");
  assert.equal(MODEL, "claude-haiku-5-5");
  assert.equal(MONTHLY_CAP_USD, 10);
  assert.equal(costOf({ input_tokens: 100000, output_tokens: 100000 }), 0.06, "at or under 100,000 prompt tokens: $0.10 / $0.50");
  assert.equal(costOf({ input_tokens: 1e6, output_tokens: 1e6 }), 3, "over 100,000 prompt tokens: $0.50 / $2.50 for the whole request");
  assert.equal(costOf({ input_tokens: 60000, cache_read_input_tokens: 50000, output_tokens: 0 }), 0.055, "cache reads count toward the prompt's length");
  assert.equal(storySet(["b", "a"]), storySet(["a", "b"]));
  assert.match(buildPrompt([{ source: "NPR", title: "T", published_at: "p", body: "B" }]), /<article id="S1">\nOutlet: NPR\nHeadline: T/);
  assert.equal(readAnswer(GOOD, seed().stories.map((s) => ({ ...s, body: "" }))).ok, true);
});
