'use strict';

// Top of file, not beside its first use: the taxonomy view below is built at
// module load, and a require that sits under it is a ReferenceError — found
// the hard way (task 86bbtujed).
const { operatorName, machineSenderTag, callerEnvVar } = require('./substrateConfig.js');

const loopStatuses = require('./loopStatuses.js');

/**
 * pipelinePause — is the pipeline running, or has the operator taken the deck?
 *
 * WHY THIS EXISTS (2026-08-25, task 86bbmfc15). Dane: "what I need is an
 * 'emergency shutdown' of the pipeline that clears the decks so I can run a
 * priority task through on the MacBook."
 *
 * The gap is real. There is the loop lane — specced, built, reviewed, merged,
 * roughly a day end to end — and there is nothing else. So when something is
 * urgent the only option is to step outside the system entirely, into the one
 * place where none of the guards apply. That is a MISSING LANE, not an
 * operator being careless, and the fix is to make going fast a sanctioned
 * move with a switch rather than an improvisation.
 *
 * Four properties, each of which the design turns on:
 *
 *   IT DRAINS, IT DOES NOT KILL. Stopping a pass mid-build strands its ticket
 *   in "Building" forever — the loops claim only from "Rework" and "Queued" — and
 *   that happened twice in the week this was written. So a pause stops new
 *   CLAIMS immediately and lets work in flight finish.
 *
 *   EVERY ACTOR ASKS, NOT JUST THE LOOPS. A pause only the loops respected
 *   would not have prevented what it was written for: the session that merged
 *   PR #432 was a hand-driven one and would never have looked. So the flag
 *   lives in ClickUp, where every actor already is, and is checked the way
 *   `node:owns` is checked — asked every time, never remembered.
 *
 *   IT FAILS SAFE. Cannot read the flag -> treated as PAUSED. The two costs
 *   are not symmetric: wrongly running means colliding with whatever the
 *   operator is doing on the deck, and wrongly pausing means idle machines
 *   and a loud message. `wipCap` deliberately fails the other way and says so;
 *   this one is a correctness guard, not a throughput optimisation.
 *
 *   IT CANNOT BE FORGOTTEN. A pause left on is indistinguishable from a broken
 *   pipeline, which is precisely the confusion that cost most of 2026-08-25.
 *   So it announces itself after two hours and keeps saying so hourly.
 *
 * Pure and time-injected on purpose, like loopNote and mergeOnComment: every
 * verdict below is a function of a comment list and a clock, so the whole
 * decision surface — including the fail-safe — is testable with no network,
 * no ClickUp token and no waiting. The plumbing that carries these decisions
 * out lives in scripts/pipeline.mjs and scripts/clickup_direct.mjs.
 */

/**
 * The state lives as a trail of comments on ONE ClickUp task — the pause
 * switch. Comments, not a status or a custom field, for three reasons:
 *
 *   - they are append-only, so the record says who paused, when, and why,
 *     and a later reader can reconstruct the whole history;
 *   - task comments were the single most reliable write in this API through
 *     the sixteen-hour chat outage of 2026-08-23 (see busRelayPlan.js), and a
 *     switch that cannot be read is a pipeline that stops;
 *   - a STATUS on that ticket would put it inside bus-relay's watches and the
 *     loops' claim query, where a pause switch has no business being.
 *
 * Markers are line-anchored whole-line prefixes so prose that merely mentions
 * one ("I paused it earlier") can never be mistaken for a record. Same
 * discipline as MERGE_MARKER and BUS_RELAY_MARKER.
 */
const PAUSE_MARKER = '[pipeline] PAUSED';
const RESUME_MARKER = '[pipeline] RUNNING';
const NAG_MARKER = '[pipeline] STILL PAUSED';

/** The reserved name of the switch task, when it is resolved by name rather
 *  than by CLICKUP_PAUSE_TASK. Matched trimmed and case-insensitively. */
const SWITCH_TASK_NAME = 'Pipeline pause switch';

/**
 * The body `npm run pipeline -- pause` writes when it creates the switch.
 *
 * IT LIVES HERE, NOT IN `scripts/pipeline.mjs`, AND THAT IS THE POINT (task
 * 86bbwab1n, review round 2, 2026-09-08). The pause switch is the FOURTH
 * standing ticket — a Loop Queue ticket created in a closed-type status and
 * rewritten in place, which `lib/loopThroughput.js` would otherwise count as
 * a ticket that shipped. `lib/loopNoticeboards.js` registers the other three
 * by requiring the module that owns each name, and the test that keeps that
 * registry honest finds them by searching requireable CJS modules for the
 * seed sentence below.
 *
 * With the sentence written inline in `scripts/pipeline.mjs` — an ESM script
 * that runs on import and so cannot be required by a test — that search could
 * not see this ticket at all. The registry shipped stale, the test passed, and
 * `docs/LOOP_ENGINEERING.md` said in as many words that a fourth one would
 * fail it. Keeping the seed text beside the name it seeds is what makes the
 * search structurally capable of finding it.
 *
 * The sentence is written out in full, exactly as the other three standing
 * tickets write theirs, rather than imported from `lib/loopNoticeboards.js`:
 * that module requires this one to read the name above, so importing back
 * would be a require cycle.
 */
const SWITCH_SEED_DESCRIPTION =
  'The pipeline pause switch. Do not build this, do not close it, do not delete it.\n\n'
  + 'Its COMMENTS are the flag: the newest `[pipeline] PAUSED` / `[pipeline] RUNNING` record is the state '
  + 'of the whole build pipeline, and every loop, the bus relay and every hand-driven session asks it '
  + 'before claiming a ticket or merging anything.\n\n'
  + 'Run `npm run pipeline -- status` to read it in plain English. Only the operator resumes.';

/** Two hours before the first nag, hourly after that (acceptance criterion 5). */
const NAG_AFTER_MS = 2 * 60 * 60 * 1000;
const NAG_EVERY_MS = 60 * 60 * 1000;

/**
 * How long a ticket may sit in a machine status untouched before it is
 * treated as STRANDED rather than in flight.
 *
 * Generous on purpose. A build pass stamps its Loop note when it claims and
 * then says nothing until the PR is open, which is routinely half an hour of
 * real work; calling that "stranded" and yanking the ticket back into the claim line
 * would hand the same job to a second builder. Ninety minutes is longer than
 * any pass observed to date and far shorter than "forever", which is what the
 * two stranded tickets of 2026-08-25 actually got.
 */
const STRANDED_AFTER_MS = 90 * 60 * 1000;

/** The statuses a pass in flight can hold, and what kind of pass it is. */
// The NARROW view of the taxonomy (loopStatuses.js, task 86bbtujed): not
// "does this ticket occupy the pipeline" but "is a PASS actually running on
// it". Deliberately IN_FLIGHT minus OPERATOR_HELD — a ticket parked on Dane
// has no pass to strand, so the drain never waits on one and the sweep never
// touches one.
const IN_FLIGHT_STATUSES = {
  [loopStatuses.BUILDING]: 'a build',
  [loopStatuses.IN_REVIEW]: 'a review',
};

/**
 * The Loop note a review pass stamps when it claims a ticket to check —
 * IMPORTED, never re-typed. A hand copy would drift the first time the note
 * was reworded, and the drain would then see a live review as a resting
 * ticket. loopNote.js is the one source (it is pure, so this file stays pure).
 */
const { REVIEW_CLAIM_NOTE } = require('./loopNote.js');

/**
 * The register the operator reads. The RECORD keeps a machine-precise ISO
 * instant — the read-back that proves a write stuck depends on it being exact
 * — but nothing a person is shown should say "2026-08-25T23:02:10.656Z". He
 * is not a career programmer and the repo's first standing rule is to say
 * things in the language he actually uses (CLAUDE.md, "Coach the operator").
 */
function humanTime(ms) {
  if (!Number.isFinite(Number(ms))) return null;
  return new Date(Number(ms)).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * A LENGTH OF TIME, in the words a person uses for it — as distinct from
 * `humanTime`, which formats an INSTANT. Mixing the two produces
 * "untouched for Dec 31, 1969, 5:06 PM", which is what the first live run of
 * the sweep printed for a ticket stranded six minutes.
 *
 * The unit changes with the size because the reader's question changes with
 * it. Under an hour he wants to know whether a pass is merely slow; over one
 * he wants to know whether something died last night, and "487 minutes" makes
 * him do the division. The scale is deliberately coarse: this number is only
 * ever used to judge "is anything still working on this", and a false sense of
 * precision would invite it to be read as a measurement.
 */
function humanDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  const mins = n / 60000;
  if (mins < 1) return 'under a minute';
  if (mins < 60) {
    const m = Math.round(mins);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const hours = n / 3600000;
  if (hours < 24) return `${hours.toFixed(1)} hours`;
  return `${(n / 86400000).toFixed(1)} days`;
}

/**
 * WHAT COUNTS AS A LINE BREAK IS THE PARSER'S LIST, NOT A GUESS. `FIELD_RE`
 * below ends in `(.*)$`, and in JavaScript `.` matches every character EXCEPT
 * these four — LF, CR, U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR.
 * Each one therefore ends a line for the READER exactly as `\n` does, so the
 * writer's idea of a line break has to be the same set. Shut only `\n` and a
 * value can carry a break the writer cannot see and the reader acts on.
 *
 * That is not theoretical: round 2 of this ticket collapsed `\n` alone, which
 * left the other three failing WORSE than the bug it fixed. They passed the
 * gate, and their `why:` line then matched no field at all — so the resume
 * succeeded, echoed the operator's words back to the caller as confirmation,
 * and recorded no reason whatsoever. `status` printed `why: (not recorded)`,
 * which is the 2026-09-01 incident exactly, reached through the guard written
 * to prevent it.
 *
 * The two shapes are derived from ONE source because two literals are two
 * definitions and they drift the first time one is edited — the same reason
 * the writer and the reader live in this one file. `\s` already covers all
 * four, so the surrounding runs absorb blank lines and indentation.
 */
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const LINE_BREAK_RUN = new RegExp(`\\s*${LINE_BREAK.source}\\s*`, 'g');

/**
 * ONE LINE PER FIELD IS THE WIRE FORMAT, so a value carrying a line break
 * cannot be written as-is: the parser reads the next line as a new field,
 * which loses everything after the break and — where the continuation happens
 * to start `by:`, `node:`, `at:` or `why:` — silently OVERWRITES that field.
 * A resume record naming the wrong resumer is the exact failure this whole
 * ticket exists to make impossible, so the collapse happens here, in the one
 * place every record is built, rather than at each caller.
 *
 * Whitespace only: no word is dropped, and runs of blank lines and indentation
 * become a single space so the line reads the way the sentence was typed.
 * `resume` refuses a `--why` carrying any of them outright before reaching
 * this (see `resumeAuthorization`), because for a QUOTE the honest move is to
 * ask the caller to reflow it rather than to reflow it for them; this is the
 * backstop that keeps every other record — pause, the nag — from being
 * corruptible the same way.
 */
function flattenValue(value) {
  return String(value).replace(LINE_BREAK_RUN, ' ').trim();
}

function line(label, value) {
  if (value == null || value === '') return null;
  const flat = flattenValue(value);
  return flat === '' ? null : `${label}: ${flat}`;
}

/**
 * One record, in the shape the parser below reads back. Writer and reader are
 * in the same file for the same reason MERGE_MARKER is: two copies of a wire
 * format are two formats, and they drift the first time one is edited.
 */
function record(marker, { by, node, at, why } = {}) {
  return [
    marker,
    line('by', by),
    line('node', node),
    line('at', at),
    line('why', why),
  ].filter(Boolean).join('\n');
}

function pauseRecord(fields) { return record(PAUSE_MARKER, fields); }
function resumeRecord(fields) { return record(RESUME_MARKER, fields); }
function nagRecord(fields) { return record(NAG_MARKER, fields); }

const FIELD_RE = /^(by|node|at|why):\s*(.*)$/i;

/**
 * Read one comment back into a record, or null if it is not one.
 *
 * The marker must be the comment's FIRST line. A record is a machine's own
 * write; anything that merely quotes one — a relayed bus message, someone
 * pasting the trail into a note — is prose and must not steer the pipeline.
 */
function parseRecord(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const head = String(lines[0] || '').trim();
  const kind = head === PAUSE_MARKER ? 'paused'
    : head === RESUME_MARKER ? 'running'
      : head === NAG_MARKER ? 'nag'
        : null;
  if (!kind) return null;
  const out = { kind, by: '', node: '', at: '', why: '' };
  for (const raw of lines.slice(1)) {
    const m = FIELD_RE.exec(String(raw).trim());
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

function commentDate(c) {
  const n = Number(c && c.date);
  return Number.isFinite(n) ? n : 0;
}

/** Newest first, by ClickUp's own comment timestamp. */
function byDateNewestFirst(comments) {
  return (Array.isArray(comments) ? comments.slice() : [])
    .sort((a, b) => commentDate(b) - commentDate(a));
}

/**
 * The trail reduced to a state: the NEWEST pause-or-resume record wins, and
 * the newest nag tells the announcer when it last spoke.
 *
 * Deliberately "newest wins" rather than "any pause anywhere": a switch that
 * could only ever be turned on would be a pipeline with an off button and no
 * on button.
 */
function readTrail(comments) {
  const sorted = byDateNewestFirst(comments);
  let state = null;
  let lastNagAt = null;
  let sawNag = false;
  for (const c of sorted) {
    const rec = parseRecord(c && c.comment_text);
    if (!rec) continue;
    if (rec.kind === 'nag') {
      sawNag = true;
      if (lastNagAt == null) lastNagAt = commentDate(c) || Date.parse(rec.at) || null;
      continue;
    }
    if (!state) {
      state = {
        paused: rec.kind === 'paused',
        by: rec.by,
        node: rec.node,
        why: rec.why,
        at: rec.at,
        atMs: commentDate(c) || Date.parse(rec.at) || null,
      };
    }
    // Keep scanning: a nag older than the newest state record is still the
    // last thing the announcer said, and stopping here would re-announce a
    // pause every single pass.
  }
  return { state, lastNagAt, sawNag };
}

/**
 * THE GUARD. Every actor calls this before claiming a ticket or merging.
 *
 * Returns a verdict rather than exiting, for the same reason `checkRole` does:
 * a background loop should say so and exit 0, while a command someone just
 * typed should refuse out loud.
 *
 *   code 0 — running, go ahead
 *   code 3 — paused. A NORMAL outcome, the same shape as "another machine owns
 *            this job": claim nothing, write nothing, say so once.
 *
 * There is no third code. An unreadable switch returns 3 as well, because the
 * whole point is that "we could not check" and "it is paused" must lead to the
 * same behaviour — while never being described in the same words.
 */
function pauseVerdict({ readable = true, why = '', switchFound = true, comments = [], yielded = false } = {}) {
  // A SCHEDULED JOB STANDING DOWN AT THE RESERVE IS NOT AN UNREADABLE SWITCH
  // (2026-09-15, task 86bc0w6my). This is the design call that ticket asked
  // for, and it is answered in one direction only: the BEHAVIOUR is unchanged
  // — code 3, claim nothing, merge nothing, because the switch genuinely was
  // not read and failing open here is the one thing this module must never do
  // — while the WORDS stop lying.
  //
  // The lie was expensive. The reserve exists so a background job never blocks
  // a session Dane is talking to; it is routine, self-clearing, and fires
  // whenever two jobs share a minute. Reported as "could not read the switch,
  // treating the pipeline as PAUSED" it is indistinguishable from the operator
  // having taken the deck — which is a perfectly normal thing for a pass to
  // report, so nobody investigates. On 2026-09-15 both loop lanes stood down
  // that way while `npm run pipeline -- status`, on the same machine and the
  // same token, printed RUNNING.
  //
  // `certain: false` stays false: this verdict still did not read the switch.
  // `yielded: true` is what a caller reports differently — the pulse's
  // heartbeat, `--json` consumers, and the preflight line a loop pass prints.
  //
  // AND THE MESSAGE MAY NOT CLAIM THE OPERATOR'S STATE EITHER. The first fix
  // for this ticket said "the operator does NOT have the deck", which is the
  // same defect facing the other way: the read never happened, so whether he
  // has the deck is precisely the thing this verdict cannot know, and if he
  // HAS paused the line while a scheduled pass hits the reserve in the same
  // minute, that sentence prints the opposite of the truth into the loop log.
  // What is known is the CAUSE — the reserve, not the operator — and that the
  // question is still open. Say both; claim neither answer.
  if (!readable && yielded) {
    return {
      paused: true,
      certain: false,
      yielded: true,
      code: 3,
      message:
        'The pipeline pause switch was NOT READ, so nothing may be claimed or merged on this pass.\n'
        + 'This stand-down was not caused by the operator taking the deck — the ClickUp reserve caused it.\n'
        + 'Whether he has the deck is UNKNOWN, because the switch was never read; the next pass finds out.\n\n'
        + `Reason: ${why || 'a scheduled job stopped at the ClickUp reserve'}\n\n`
        + 'This is a scheduled job, and the ClickUp budget for this minute was down to the reserve kept for\n'
        + `the sessions ${operatorName()} is actually talking to, so it stopped instead of spending it. Nothing is broken,\n`
        + 'and it clears itself: the next pass reads the switch normally.\n'
        + 'It is NOT a network fault and NOT a token problem, so do not go looking for one. To read the switch\n'
        + `by hand from a session ${operatorName()} is in, run the command without ${callerEnvVar()}=scheduled —\n`
        + 'interactive callers never yield.',
    };
  }

  if (!readable) {
    return {
      paused: true,
      certain: false,
      code: 3,
      message:
        'Could not read the pipeline pause switch, so the pipeline is being treated as PAUSED.\n' +
        // On its own line: the reason is sometimes several lines long (see
        // pipelinePauseStore's 401 hint), and folded into a parenthesis it
        // ran straight into the next sentence.
        `Reason: ${why || 'unknown'}\n\n` +
        'That is deliberate and it is not symmetric: running when the operator has the deck collides with\n' +
        'whatever he is doing there, while pausing when he does not costs idle machines and this message.\n' +
        'Fix the read (network, token, the switch ticket) and everything starts again on its own.',
    };
  }

  if (!switchFound) {
    return {
      paused: false,
      certain: true,
      code: 0,
      message:
        'The pipeline is RUNNING — no pause switch exists, so it has never been paused.\n' +
        `(\`npm run pipeline -- pause\` creates the switch ticket "${SWITCH_TASK_NAME}" the first time it is used.)`,
    };
  }

  const { state, sawNag } = readTrail(comments);

  // A NAG with no state record behind it means the read was TRUNCATED, not
  // that the pipeline is running. A nag is only ever written while paused, so
  // seeing one without the pause it refers to proves the trail is incomplete —
  // and an incomplete trail must fail the same way an unreadable one does.
  //
  // This is the belt behind the braces. The braces are the paged read in
  // pipelinePauseStore; on 2026-08-26 an unpaged one lost the pause record
  // after roughly 25 hourly nags and reported the pipeline RUNNING. If the
  // paging is ever wrong again, this catches it in the safe direction.
  if (!state && sawNag) {
    return {
      paused: true,
      certain: false,
      truncated: true,
      code: 3,
      message:
        'The pipeline pause switch is being treated as PAUSED: its record is INCOMPLETE.\n' +
        'The switch carries a "still paused" reminder but not the pause it refers to, and a reminder is only\n' +
        'ever written while the line is off — so part of the trail was not read.\n\n' +
        'Claim nothing and merge nothing until `npm run pipeline -- status` gives a straight answer.',
    };
  }

  if (!state || !state.paused) {
    return {
      paused: false,
      certain: true,
      code: 0,
      message: state
        ? `The pipeline is RUNNING — resumed${state.by ? ` by ${state.by}` : ''}${state.at ? ` at ${humanTime(state.atMs) || state.at}` : ''}.`
        : 'The pipeline is RUNNING — the switch exists but carries no pause record.',
    };
  }

  return {
    paused: true,
    certain: true,
    code: 3,
    since: state.at,
    sinceMs: state.atMs,
    by: state.by,
    node: state.node,
    reason: state.why,
    message:
      `The pipeline is PAUSED${state.by ? ` — ${state.by} has the deck` : ''}${state.at ? ` (since ${humanTime(state.atMs) || state.at})` : ''}.\n` +
      (state.why ? `Why: ${state.why}\n` : '') +
      'Claim nothing and merge nothing. This is a normal outcome, not a failure — say so once and stop.\n' +
      'Only the operator resumes: `npm run pipeline -- resume --operator-asked`.',
  };
}

/**
 * Is a ticket in a machine status a pass in flight, or one that was stranded?
 *
 * The distinction is the whole of acceptance criterion 7. A pass in flight
 * must be waited for; a stranded ticket must be handed back to a claimable
 * status, because nothing will ever pick it up again on its own. WHICH
 * claimable status is `strandedBuildDestination`'s call, not this one's.
 */
function classifyTicket(task, { nowMs, strandedAfterMs = STRANDED_AFTER_MS } = {}) {
  const status = String(task?.status?.status || task?.status || '').toLowerCase();
  const kind = IN_FLIGHT_STATUSES[status];
  if (!kind) return null;

  // "In review" is a resting status as well as a working one: a ticket waits
  // there for a review pass to pick it up. Only one carrying the review claim
  // note has a pass actually running on it.
  if (status === loopStatuses.IN_REVIEW && !String(task.loopNote || '').startsWith(REVIEW_CLAIM_NOTE)) return null;

  const updated = Number(task.date_updated);
  const age = Number.isFinite(updated) && Number.isFinite(nowMs) ? nowMs - updated : null;
  const stranded = age != null && age > strandedAfterMs;
  return {
    id: String(task.id),
    name: String(task.name || ''),
    status: task?.status?.status || status,
    kind,
    ageMs: age,
    stranded,
  };
}

/** Everything a drain is waiting on, split into the two cases. */
function inFlight(tasks, opts = {}) {
  const rows = (Array.isArray(tasks) ? tasks : [])
    .map((t) => classifyTicket(t, opts))
    .filter(Boolean);
  return {
    working: rows.filter((r) => !r.stranded),
    stranded: rows.filter((r) => r.stranded),
  };
}

/** "1 build and 1 review", for a sentence a person reads. */
function describeTickets(rows) {
  if (!rows.length) return 'nothing';
  return rows.map((r) => `${r.kind} on ${r.id} ("${r.name}")`).join(', ');
}

/**
 * WHY a stranded ticket is stuck — which is a DIFFERENT sentence for each kind,
 * and used to be one sentence asserted over both (task 86bbqw49y).
 *
 * A stranded BUILD is stuck because of its status: it sits in "Building", which
 * no loop claims from, so nothing will ever pick it up again.
 *
 * A stranded REVIEW is stuck for the opposite reason. Its status is already
 * right — "In review" is exactly where a ticket waits for a reviewer — and the
 * only thing wrong with it is the stale claim note saying a pass is running.
 * Telling a reader "the loops only claim from Queued" about that ticket sends
 * them looking for a status problem that does not exist.
 *
 * Returns one line per kind present, naming the ids, so a mixed sweep reports
 * both rather than applying one kind's reason to all of them.
 */
function strandedExplanation(stranded = []) {
  const rows = Array.isArray(stranded) ? stranded : [];
  const reviews = rows.filter((r) => r && r.kind === 'a review');
  const builds = rows.filter((r) => r && r.kind !== 'a review');
  const lines = [];
  if (builds.length) {
    const ids = builds.map((r) => r.id).join(', ');
    lines.push(builds.length === 1
      ? `${ids}: a build with nothing working on it and nothing that ever will — it is in "Building", and the loops only claim from Rework and Queued.`
      : `${ids}: builds with nothing working on them and nothing that ever will — they are in "Building", and the loops only claim from Rework and Queued.`);
  }
  if (reviews.length) {
    const ids = reviews.map((r) => r.id).join(', ');
    lines.push(reviews.length === 1
      ? `${ids}: the build is finished and its pull request is open. Its STATUS is right — a stale claim note is all that makes it look like a review is already running, so no review pass will take it.`
      : `${ids}: their builds are finished and their pull requests are open. Their STATUSES are right — stale claim notes are all that make them look like reviews are already running, so no review pass will take them.`);
  }
  return lines;
}

/**
 * What `pause` reports when it stops waiting, and whether that is a clean
 * stop. It must never return a promise it has not kept — "the decks are
 * clear" said over a running build is the one sentence this command cannot
 * be allowed to say.
 *
 *   ended 'clear'    nothing is claiming and nothing is mid-build. Exit 0.
 *   ended 'left'     --now was used. Names exactly what was left running.
 *   ended 'timeout'  waited the full budget and work is still in flight.
 *
 * Both non-clear endings exit 3, deliberately the same code as "paused":
 * claiming HAS stopped in all three cases, which is what a caller acts on.
 */
function drainReport({ ended, working = [], stranded = [], waitedMs = 0, budgetMs = 0 } = {}) {
  const waitedMin = Math.round(waitedMs / 60000);
  const strandedLine = stranded.length
    ? `\n${stranded.length} ticket(s) look STRANDED rather than busy (nothing has touched them in a long while): ` +
      `${describeTickets(stranded)}.\nThey are not being waited for. \`npm run pipeline -- resume --operator-asked\` puts them right.`
    : '';

  if (ended === 'clear') {
    const waited = waitedMin ? ` (waited ${waitedMin} min)` : '';
    // "The decks are clear" is the one sentence this command must never say
    // loosely: the operator reads it and goes to work on the deck. Nothing
    // MOVING is not the same as nothing THERE — a ticket is reclassified as
    // stranded merely by being untouched for 90 minutes, and a CI wait passes
    // that routinely, so a live build can be sitting in the stranded column.
    // Say what is true instead of reaching for the reassuring word.
    return {
      clear: true,
      code: 0,
      message: stranded.length
        ? `Pipeline PAUSED and nothing is still moving${waited} — but the decks are NOT empty.${strandedLine}`
        : `Pipeline PAUSED and the decks are clear — nothing is claiming and nothing is mid-build${waited}.`,
    };
  }

  if (ended === 'left') {
    return {
      clear: false,
      code: 3,
      message:
        'Pipeline PAUSED immediately (--now), so the decks are NOT clear.\n' +
        `Still in flight, and left running: ${describeTickets(working)}.\n` +
        'Each will finish on its own and hand its ticket on; nothing will claim anything new.' +
        strandedLine,
    };
  }

  return {
    clear: false,
    code: 3,
    message:
      `Pipeline PAUSED, but the decks did NOT clear within ${Math.round(budgetMs / 60000)} minutes.\n` +
      `Still in flight: ${describeTickets(working)}.\n` +
      'Nothing new can be claimed, so it is safe to work — but a pass is still running, and if it is\n' +
      'writing to the repo you are about to touch, wait for it or check what it is doing.' +
      strandedLine,
  };
}

/**
 * Should the announcer say something this pass?
 *
 * Two hours of silence, then hourly. The threshold is not politeness: a pause
 * nobody remembers looks exactly like a pipeline that has broken, and telling
 * those two apart cost most of a day on 2026-08-25.
 */
function nagDecision({ paused, sinceMs, lastNagAt, nowMs, afterMs = NAG_AFTER_MS, everyMs = NAG_EVERY_MS } = {}) {
  if (!paused) return { post: false, reason: 'the pipeline is running' };
  if (!Number.isFinite(sinceMs) || !Number.isFinite(nowMs)) {
    return { post: false, reason: 'no readable pause time to measure from' };
  }
  const heldFor = nowMs - sinceMs;
  if (heldFor < afterMs) {
    return { post: false, reason: `paused ${Math.round(heldFor / 60000)} min — under the ${Math.round(afterMs / 60000)} min threshold` };
  }
  if (Number.isFinite(Number(lastNagAt)) && Number(lastNagAt) > 0) {
    const sinceNag = nowMs - Number(lastNagAt);
    if (sinceNag < everyMs) {
      return { post: false, reason: `last said ${Math.round(sinceNag / 60000)} min ago — hourly` };
    }
  }
  return { post: true, reason: 'paused past the threshold and due to say so', heldMs: heldFor };
}

/** What the announcer actually says on the party line. */
function nagMessage({ by, why, sinceMs, nowMs } = {}) {
  const hours = Number.isFinite(sinceMs) && Number.isFinite(nowMs)
    ? Math.max(1, Math.round((nowMs - sinceMs) / 3600000))
    : null;
  return `${machineSenderTag()} The build pipeline is still PAUSED` +
    (hours ? ` — ${hours} hour${hours === 1 ? '' : 's'} now` : '') +
    (by ? `, paused by ${by}` : '') + '.' +
    (why ? `\nWhy: ${why}` : '') +
    '\nNothing is being claimed, reviewed or merged while it is off.' +
    '\nResume with: npm run pipeline -- resume --operator-asked';
}

/**
 * What actually happened to ONE swept ticket, in the words that match it.
 *
 * A released review and a returned build are two different outcomes, and the
 * summary used to name only the build one — so a resume reported a ticket it
 * had correctly left in "In review" as "returned to Queued", contradicting its
 * own per-ticket line two lines earlier (seen 2026-08-31, task 86bbqw49y).
 *
 * A bare string is tolerated so that a caller which regresses to the old
 * id-only array still prints an id rather than "[object Object]" — this is a
 * safety tool's report, and a garbled one is worse than a terse one.
 */
function sweptTicketPhrase(entry, { applied = true } = {}) {
  if (typeof entry === 'string') return entry;
  const id = String(entry?.id ?? '');
  const kind = String(entry?.kind ?? '');
  const destination = String(entry?.destination ?? '');
  // A dry run has moved nothing, so it may not use the past tense. The two
  // wordings are generated from ONE place for the same reason the summary is:
  // a second copy drifts the first time a destination is reworded, and the
  // reader cannot tell a report of what happened from a report of what would.
  if (kind === 'a review') {
    return applied
      ? `${id} (released in "${destination || 'In review'}")`
      : `${id} (would be released in "${destination || 'In review'}")`;
  }
  if (destination) return `${id} (${applied ? 'returned' : 'would return'} to ${destination})`;
  return id;
}

/**
 * The one-sentence tally of the sweep — the SAME sentence for the terminal and
 * for the party line, so the two reports of one event cannot disagree.
 *
 * Every ticket carries its own outcome: "unstuck" is the only verb true of
 * both kinds, and where each one went is said per ticket rather than asserted
 * over the group (that was this ticket's original defect).
 *
 * AN EMPTY `swept` LIST HAS THREE CAUSES AND THEY ARE NOT THE SAME NEWS
 * (task 86bbqw49y, round 2). Answering all three with one all-clear is how a
 * sweep comes to print, in two consecutive lines:
 *
 *     86bbzzzzz: the note landed but the move did NOT (403) — it is still stranded.
 *   The pipeline is RUNNING again. No stranded tickets needed unsticking.
 *
 * which is the same contradicting-pair shape the ticket was opened about, with
 * the summary again the false half. `if (!ok) continue` producing an all-clear
 * is DOCTRINE 3.11 by name. So:
 *
 *   nothing was stranded   the all-clear is TRUE. Say it.
 *   a sweep step FAILED    the ticket is still stuck. Say how many, and never
 *                          say "no stranded tickets".
 *   nothing was CHECKED    `--no-sweep`, or the queue could not be read.
 *                          Nobody looked, so the honest answer is that it
 *                          could not tell — never an all-clear.
 *
 * `left` (how many stranded tickets were examined and NOT unstuck) and
 * `checked` (was the queue examined at all) have to come from the caller: what
 * was LEFT BEHIND is structurally invisible to a function that is only ever
 * shown what was taken. `why` names the reason nothing was checked.
 *
 * A FOURTH CAUSE, added 2026-09-04 (task 86bbur9tk): `preserved` — tickets the
 * sweep examined and deliberately did NOT move, because a build for them is
 * still sitting in a worktree, or because a machine could not be looked at.
 * That is a correct outcome, not a failed write, so it cannot go in `left`;
 * and no move happened, so it cannot go in `swept`. Left out of the sentence
 * entirely it would produce "No stranded tickets needed unsticking." over a
 * ticket the same run had just refused to touch — the exact contradicting
 * pair this function already carries two scars from.
 */
function sweptSummary(swept = [], { checked = true, left = 0, why = '', applied = true, preserved = [] } = {}) {
  const rows = Array.isArray(swept) ? swept : [];
  const stuck = Number.isFinite(left) && left > 0 ? Math.trunc(left) : 0;
  const kept = preservedSummary(preserved);

  if (!checked) {
    return `Whether anything is stranded was NOT checked${why ? ` — ${why}` : ''}.`
      + ' Run `npm run pipeline -- status` to find out.';
  }

  const noun = rows.length === 1 ? '1 stranded ticket' : `${rows.length} stranded tickets`;
  const verb = applied ? 'unstuck' : 'WOULD be unstuck';
  const unstuck = rows.length
    ? `${noun} ${verb}: ${rows.map((r) => sweptTicketPhrase(r, { applied })).join(', ')}.`
    : '';

  // A DRY RUN MAY NOT REPORT AN OUTCOME IT DID NOT CAUSE. Everything below the
  // `checked` gate is the same news either way — what is stranded and where it
  // belongs — but the verb is not, and neither is the ending: a reader who
  // takes "2 stranded tickets unstuck" from a run that wrote nothing will not
  // run the command again, which is the whole failure this ticket is about
  // (`resume` reporting nothing to do and doing nothing being the other half).
  if (!applied) {
    // `--apply` MOVES THE TICKETS IN `unstuck`. It does not move the ones in
    // `kept` — refusing to move those is the whole point of preserving them —
    // so the offer is made only where it is true (finding 5 of the round-1
    // review). Appending it to a preserved-only summary produced the
    // contradicting pair this function already carries two scars from: a
    // sentence saying a ticket was deliberately left alone, followed by an
    // offer to apply the change that would not touch it.
    const nothingChanged = 'Nothing has been changed — add `--apply` to do it.';
    if (unstuck) return [`${unstuck} ${nothingChanged}`, kept].filter(Boolean).join(' ');
    if (kept) {
      const one = preservedCount(preserved) === 1;
      return `${kept} \`--apply\` would not move ${one ? 'that one' : 'those'} either — leaving `
        + `${one ? 'it' : 'them'} alone IS the decision.`;
    }
    return 'No stranded tickets need unsticking.';
  }

  if (!stuck) return [unstuck, kept].filter(Boolean).join(' ') || 'No stranded tickets needed unsticking.';

  const stillStranded = `${stuck} stranded ticket${stuck === 1 ? '' : 's'} could NOT be unstuck`
    + ` and ${stuck === 1 ? 'is' : 'are'} STILL stranded.`
    + ' Run `npm run pipeline -- status` to see which.';
  return [unstuck, kept, stillStranded].filter(Boolean).join(' ');
}

/** How many tickets the sweep deliberately left alone. One reader, so the
 *  count in the sentence and the count in the exit code cannot drift. */
function preservedCount(preserved = []) {
  return (Array.isArray(preserved) ? preserved : []).filter(Boolean).length;
}

/**
 * The half-sentence for tickets the sweep left alone ON PURPOSE.
 *
 * The two reasons are said separately because they need different things from
 * the reader: half-built work wants finishing (or handing back deliberately),
 * a blind spot wants somebody to go and look. Collapsing them into "N left
 * alone" would tell nobody which.
 */
function preservedSummary(preserved = []) {
  const rows = (Array.isArray(preserved) ? preserved : []).filter(Boolean);
  if (!rows.length) return '';
  const ids = (v) => rows.filter((r) => r.verdict === v).map((r) => r.id);
  const halfBuilt = ids('work');
  const blind = rows.filter((r) => r.verdict !== 'work').map((r) => r.id);
  const parts = [];
  // SINGULAR AND PLURAL BOTH READ AS ENGLISH. This string goes to the
  // terminal, the scheduled repair report and the bus verbatim, and the
  // singular form shipped as "1 ticket ... so it was left exactly where they
  // are" — which appeared in a live run before anyone read it (finding 6 of
  // the round-1 review). Every number/verb pair is chosen here rather than
  // patched at the join.
  if (halfBuilt.length) {
    const one = halfBuilt.length === 1;
    parts.push(`${halfBuilt.length} ticket${one ? ' was' : 's were'} left in "Building" because `
      + `${one ? 'a half-finished build for it is' : 'half-finished builds for them are'} still on a machine: `
      + `${halfBuilt.join(', ')}.`);
  }
  if (blind.length) {
    const one = blind.length === 1;
    parts.push(`${blind.length} ticket${one ? '' : 's'} could NOT be judged — a machine could not be looked at, so `
      + `${one ? 'it was left exactly where it is' : 'they were left exactly where they are'}: ${blind.join(', ')}.`);
  }
  return parts.join(' ');
}

/**
 * What the standalone `sweep` command exits with.
 *
 * WHY IT IS NOT JUST 0-OR-1. The sweep exists to be reachable at any time —
 * including from a script, which is the point of splitting it out of `resume`
 * (this ticket). Four outcomes matter to a caller and collapsing any two of
 * them loses the distinction the command was written to make:
 *
 *   0  clean — nothing was stranded, or everything stranded was unstuck.
 *   1  a sweep step FAILED: something is still stranded. A real problem.
 *   2  the queue could not be read, so NOTHING IS KNOWN. Never 0 — "could not
 *      tell" reading as an all-clear is DOCTRINE 3.11, and this file already
 *      carries two scars from it (`sweptSummary`'s three empty-list causes).
 *   3  a dry run found stranded work and deliberately did not act. A normal,
 *      expected decline, and 3 is what a normal decline exits with everywhere
 *      else here (`pipeline check`, `node:owns`).
 *
 * `found` is how many stranded tickets were SEEN, which is what separates a
 * dry run with work to do from a dry run with none.
 */
function sweepExitCode({ checked = true, left = 0, found = 0, applied = true, preserved = [] } = {}) {
  if (!checked) return 2;
  if (Number(left) > 0) return 1;
  if (!applied && Number(found) > 0) return 3;
  // Stranded work was FOUND and deliberately not acted on (task 86bbur9tk) —
  // which is what 3 already means here. A half-built ticket left in "Building"
  // and a ticket nobody could look at both need a decision from somebody, and
  // exiting 0 would tell the caller the deck is clear when two tickets are
  // still sitting on it.
  if ((Array.isArray(preserved) ? preserved.length : Number(preserved) || 0) > 0) return 3;
  return 0;
}

/**
 * What it says once, when the deck goes back.
 *
 * It reports the sweep with `sweptSummary`'s own words rather than a second
 * set of its own. It used to carry the sibling of the bug above — "Nothing was
 * left stranded." on the same empty list — so the bus heard an all-clear the
 * terminal had already contradicted. One sentence, one source.
 */
function resumedMessage({ by, pausedForMs, swept = [], checked = true, left = 0, why = '', preserved = [] } = {}) {
  const mins = Number.isFinite(pausedForMs) ? Math.round(pausedForMs / 60000) : null;
  return `${machineSenderTag()} The build pipeline is RUNNING again` +
    (by ? `, resumed by ${by}` : '') +
    (mins != null ? ` after ${mins} min paused` : '') + '.' +
    `\n${sweptSummary(swept, { checked, left, why, preserved })}`;
}

/**
 * Where a stranded BUILD belongs — `Rework` or `Queued`.
 *
 * WHY THE DISTINCTION (2026-08-31, task 86bbr1u9v). Both statuses are claimable
 * by loop-build, so this is not about visibility. It is about ORDER and about
 * telling the truth: rework drains first, because a half-built ticket has a
 * branch, a PR and review notes already, and every day it waits costs another
 * catch-up merge against a moving `main`. Sweeping a half-built ticket into
 * `Queued` puts it back at the end of the priority contest it has already been
 * losing — the exact staleness the Rework status was created to end.
 *
 * It takes `buildStart.resolveBuildStart`'s answer rather than re-deriving one,
 * so the sweep and the next build pass can never disagree about whether work
 * exists. The three answers map cleanly:
 *
 *   continue  an OPEN PR — half-built, so Rework
 *   fresh     no PR at all, or one already merged/closed — genuinely new work
 *   unknown   a PR is named but its state could not be read
 *
 * `unknown` goes to REWORK, and that is the safe direction here rather than a
 * contradiction of buildStart's "never guess": buildStart refuses because the
 * cost of guessing wrong is a duplicate branch, which is a correctness problem.
 * Here the ticket is going to a claimable status either way and `build-start`
 * will ask the same question again before a line is written — so the only thing
 * at stake is which queue it waits in, and a ticket that NAMES a PR belongs
 * with the half-built ones. The caller says out loud that it could not read the
 * state.
 */
function strandedBuildDestination(buildStartAction, { unlookedSeats = '' } = {}) {
  // WHICH SEATS WERE NEVER LOOKED AT, inside the sentence that asserts the
  // absence (round-1 review of task 86bbur9tk, 2026-09-05).
  //
  // Some machines have no ssh route from here at all — permanently, by the
  // inventory's own declaration — so the sweep genuinely cannot see them and
  // genuinely must keep working anyway (`strandedLocalWork`'s header argues
  // that out). The move goes ahead; what must NOT go ahead is the flat
  // "nothing has been built for it", because that is the exact false sentence
  // this ticket exists to remove. A qualified true sentence is a different
  // thing, and this is where it gets qualified: the string lands in the
  // ticket's own hand-back note, so the next builder reads the caveat where
  // they read the instruction.
  const seats = String(unlookedSeats || '').trim();
  const freshWhy = seats
    ? 'nothing that a new branch would duplicate was found on any machine that could be looked at'
      + ` — but ${seats} could not be, so this is the best reading available rather than a certainty`
      + ' (check there before rebuilding)'
    : 'nothing has been built for it that a new branch would duplicate';
  switch (String(buildStartAction || '')) {
    case 'continue':
      return { status: 'Rework', why: 'its pull request is still open, so this is half-built work to be finished' };
    case 'unknown':
      return { status: 'Rework', why: 'it names a pull request whose state could not be read — a ticket that names a PR belongs with the half-built work' };
    case 'fresh':
      return { status: 'Queued', why: freshWhy };
    default:
      // An answer nobody anticipated is not a licence to pick one. Rework is
      // the conservative choice for the same reason `unknown` is: it cannot
      // lose work, only order it ahead of fresh tickets.
      return { status: 'Rework', why: `the build-start check answered "${buildStartAction}", which is not one of its three answers — treated as half-built rather than guessed away` };
  }
}

/**
 * Where a stranded build belongs ONCE THE DISK HAS ALSO BEEN LOOKED AT.
 *
 * WHY THIS IS A SECOND FUNCTION AND NOT A FLAG ON THE FIRST (2026-09-06, task
 * 86bbvj44f). `strandedBuildDestination` answers from a PULL REQUEST lookup,
 * which cannot see a worktree with seven uncommitted files in it. The stranded
 * sweep closed that hole by taking a local reading as well — but when the
 * reading says work exists the sweep's answer is to LEAVE THE TICKET IN
 * "Building" and print where the work is, which `pass-reconcile` may never do:
 * its entire purpose is to un-hide a ticket that is invisible there.
 *
 * So the two callers genuinely need different answers to the same reading, and
 * the reading itself — `strandedLocalWork.findWorkInProgress` — stays the one
 * definition both share. This is the mapping for the caller that must always
 * move the ticket somewhere claimable:
 *
 *   work         REWORK, with the machine, worktree and branch in the note, so
 *                the next claimant is told where the half-finished build is
 *                instead of rebuilding it (the 2026-08-20 double-build shape).
 *   cannot-tell  REWORK too. A machine that should have answered did not, so
 *                nothing may be asserted absent (DOCTRINE 3.11). Rework is the
 *                direction that cannot lose work: `build-start` asks the same
 *                question again before a line is written, and the only thing
 *                at stake is which queue it waits in.
 *   none         `strandedBuildDestination`'s answer, unchanged, carrying its
 *                unlooked-seat caveat. This is the path that must keep
 *                working — a guard that never lets anything through is the
 *                mirror-image defect and this repo has shipped it before.
 *
 * `describeWork` produces the sentence naming where the work is; it is passed
 * in rather than imported so this module stays free of `strandedLocalWork`'s
 * ssh-shaped dependencies, exactly as `pipelineSweep` injects its probe.
 */
function reconciledBuildDestination(buildStartAction, local = {}, { describeWork = () => [] } = {}) {
  const verdict = String(local?.verdict || 'none');
  const unlookedSeats = String(local?.unlookedSeats || '').trim();

  if (verdict === 'work') {
    const where = describeWork(local.work || []).join('; ');
    return {
      status: 'Rework',
      why: 'a half-finished build for it is sitting on a machine'
        + (where ? ` — ${where}` : '')
        + '. Nothing has been pushed or committed for you: finish it there rather than starting over',
    };
  }

  if (verdict === 'cannot-tell') {
    const blind = String(local?.blindSpots || '').trim();
    return {
      status: 'Rework',
      why: 'whether anything was built for it could NOT be checked'
        + (blind ? ` — ${blind}` : '')
        + '. It is in the claim line rather than asserted unbuilt; look there before starting over',
    };
  }

  return strandedBuildDestination(buildStartAction, { unlookedSeats });
}

/**
 * The note left on a ticket the sweep unstuck.
 *
 * A returned ticket with no explanation is how a builder rebuilds work that
 * was already half done. Say what happened and what the next pass should
 * check before it starts over.
 */
function sweptTicketNote({ at, by, kind = 'a build', destination = 'Queued', why = '', command = 'npm run pipeline -- resume' } = {}) {
  // WHICH COMMAND RAN, named — in the BODY as well as the signature.
  //
  // The signature said "pipeline resume" for every sweep until 2026-09-02,
  // when the sweep became runnable on its own, and the first live
  // `sweep --apply` credited a resume that never happened. The body kept the
  // same bug one layer down for the rest of that day: it opened "Returned to
  // Queued by the pipeline pause sweep" no matter what had actually moved the
  // ticket, so `pass-reconcile`'s first live hand-back blamed a sweep that
  // never ran. A trail that names the wrong actor is the defect, not a wording
  // preference (DOCTRINE 2.5/2.6: a hand-off names the actor).
  //
  // `command` is the WHOLE invocation now, not a word to be prefixed, so the
  // note tells the reader exactly what to type to watch it happen again.
  const ran = String(command || 'npm run pipeline -- resume');
  const signature = `\n\n(Automatic — ${ran}${by ? `, ${by}` : ''}${at ? `, ${at}` : ''}.)`;

  // A stranded REVIEW keeps its status. It is already in "In review", which is
  // where a ticket waits for a reviewer; the only thing wrong with it is the
  // stale claim note. Sending it to Queued would throw away a finished build
  // with an open PR and hand the same job to a second builder.
  if (kind === 'a review') {
    return `Released by \`${ran}\`.\n\n` +
      'A review pass claimed this ticket and then ended without leaving a verdict, so it sat here looking ' +
      'like it was being checked when nothing was. **Nothing about the build has changed** — the branch and ' +
      'its PR are exactly as they were, and this ticket stays in "In review" so the next review pass picks ' +
      'it up instead of the work being rebuilt.' + signature;
  }

  const where = String(destination || 'Queued');
  return `Returned to ${where} by \`${ran}\`.\n\n` +
    'This ticket was sitting in a machine status with nothing working on it — its pass ended without ' +
    'handing it on, which leaves it invisible to the loops (they only claim from Rework and Queued). ' +
    `It went to **${where}**${why ? ` because ${why}` : ''}. ` +
    'Nothing has been undone: **check for an existing branch and PR before building** ' +
    '(`npm run clickup -- build-start --task <id>`), because part of the work may already be pushed.' +
    signature;
}

/**
 * A numeric command-line option, where ZERO is a real answer.
 *
 * `Number(arg(...)) || DEFAULT` swallows a falsy 0, so `--wait-minutes 0` —
 * "pause, but do not wait for the drain" — silently waited the full half hour
 * instead (found in review, PR #434). Only a MISSING or unparseable value may
 * fall back to the default; a supplied 0 means 0.
 *
 * Here rather than in pipeline.mjs so it can be driven in `node --test`: the
 * command itself exits before argv parsing unless a live token is present.
 */
function numericOption(argv, name, fallback) {
  const list = Array.isArray(argv) ? argv : [];
  const i = list.indexOf(`--${name}`);
  const raw = i !== -1 && list[i + 1] && !String(list[i + 1]).startsWith('--') ? list[i + 1] : null;
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Who may resume.
 *
 * The pipeline may be paused by anyone — an agent that finds itself about to
 * collide with the operator should be able to stop the line. Resuming is the
 * opposite: it hands the deck back, and only the person standing on it knows
 * whether he is finished. So `resume` refuses unless the caller states, on the
 * record, that the operator asked for it.
 *
 * This is the same `--operator-asked` claim the Urgent-priority guard uses,
 * and it is honest about what it is: an agent CAN type the flag, exactly as it
 * can type it to file an Urgent ticket. What makes it a real control is that
 * every resume is written to the switch's own trail with the machine name and
 * announced on the party line, so a resume nobody authorized is visible within
 * minutes rather than never. Prevention where it is possible, evidence where
 * it is not (DOCTRINE §3.11).
 *
 * THAT EVIDENCE WAS MISSING UNTIL NOW, which is what `--why` fixes (2026-09-01,
 * task 86bbrqa5j). A resume recorded who and when and nothing else, so the one
 * question worth asking afterwards — on whose word? — could not be answered
 * from the switch ticket at all. On 2026-09-01 the line was paused for a
 * hand-driven fast-track; at 2:33pm Dane wrote "I am finished (for now) with
 * the other fast-track task", and nineteen seconds later a different session
 * resumed. That sentence retires the pause's stated REASON; it is not "hand
 * the deck back", and he had not authorized it. Establishing that meant
 * reading another session's transcript off disk.
 *
 * The flag is REQUIRED, and the requirement — not the audit trail — is the
 * mechanism. An agent that must paste the operator's own words has to go find
 * those words, and the 2:34pm session would have discovered at that moment
 * that no such sentence existed. An OPTIONAL field would have been skipped by
 * exactly the session that most needed to fill it in.
 *
 * What it deliberately does NOT do is check that the text really is a quote.
 * That is not detectable, and a check that pretended to would be worse than
 * none — it would licence the claim it cannot verify. Requiring the field is
 * the whole of it.
 */
function resumeAuthorization({ operatorAsked, why } = {}) {
  if (!operatorAsked) {
    return {
      allowed: false,
      code: 2,
      message:
        'Refusing to resume: only the operator takes the pipeline off pause.\n' +
        'An agent may pause the line — that is a safety move anyone should be able to make — but it may not\n' +
        'hand the deck back, because only the person working on it knows whether he is finished.\n' +
        `If ${operatorName()} has said to resume, re-run with --operator-asked. That claim is recorded on the switch ticket\n` +
        'with this machine\'s name and announced on the party line, so it is checkable afterwards.',
    };
  }

  // The second half of the same claim, and it is refused separately so the
  // message can name the one thing that is missing. Whitespace is not an
  // answer: `--why "   "` is the shape a session reaches for when it has no
  // sentence to paste, which is precisely the case this exists to catch.
  if (!String(why || '').trim()) {
    return {
      allowed: false,
      code: 1,
      message:
        'Refusing to resume: --operator-asked was given, but not --why.\n' +
        'Saying the operator asked is a claim no script can check. What makes it checkable later is his own\n' +
        'words, written onto the switch ticket beside it — so `resume` will not run without them.\n\n' +
        `  npm run pipeline -- resume --operator-asked --why "<paste what ${operatorName()} actually said>"\n\n` +
        'Quote him, do not summarise him. If you cannot find a sentence to paste, that is the answer:\n' +
        'nobody has handed the deck back, and the pipeline stays paused. Nothing has been written.',
    };
  }

  // A record keeps ONE LINE PER FIELD, so a quote that spans lines cannot be
  // stored as it was typed. What it costs depends on which break it carries,
  // and both outcomes are measured in the tests rather than reasoned about:
  // after an LF or CRLF everything past the first break is lost and a
  // continuation beginning `by:` replaces the name of whoever resumed, while a
  // bare CR, U+2028 or U+2029 stops the `why:` line matching FIELD_RE at all,
  // so the reason vanishes ENTIRELY while the resume reports success. A
  // half-sentence presented on the switch ticket as the operator's words is
  // worse than none, because nothing on the ticket says a half was dropped —
  // and no sentence at all, on a resume that said it recorded one, is worse
  // again.
  //
  // The class is LINE_BREAK, shared with the serializer, so the gate and the
  // format can never disagree about what a line break is. Testing `\n` alone —
  // which is what round 2 did — leaves the three that fail open.
  //
  // It REFUSES rather than reflowing, for the same reason the flag is required
  // at all: his words are the evidence, and a script that quietly rewrites the
  // evidence is not evidence. Reflowing it is one keystroke for the caller and
  // a visible choice; doing it for them is invisible. (`line()` still collapses
  // line breaks when building any record — that is the backstop for every other
  // caller, not a licence for this one.)
  if (LINE_BREAK.test(String(why))) {
    return {
      allowed: false,
      code: 1,
      message:
        'Refusing to resume: --why spans more than one line.\n' +
        'The switch record keeps one line per field, so a quote broken across lines cannot be stored as typed:\n' +
        'at best only the first line survives, a second line starting "by:" would overwrite the name of whoever\n' +
        'resumed, and some line breaks drop the reason altogether while the resume still reports success. Either\n' +
        'way the ticket would show a half-quote — or none — with nothing to say anything was lost.\n\n' +
        '  npm run pipeline -- resume --operator-asked --why "<his words, reflowed onto one line>"\n\n' +
        'Keep every word he said; just join the lines with spaces. Nothing has been written.',
    };
  }

  return {
    allowed: true,
    message:
      'Resuming on the operator\'s say-so (--operator-asked). Recorded on the switch and announced on the party line.\n' +
      `  on his word: ${String(why).trim()}`,
  };
}

module.exports = {
  IN_FLIGHT_STATUSES,
  humanTime,
  humanDuration,
  PAUSE_MARKER,
  RESUME_MARKER,
  NAG_MARKER,
  SWITCH_TASK_NAME,
  SWITCH_SEED_DESCRIPTION,
  NAG_AFTER_MS,
  NAG_EVERY_MS,
  STRANDED_AFTER_MS,
  REVIEW_CLAIM_NOTE,
  pauseRecord,
  resumeRecord,
  nagRecord,
  parseRecord,
  readTrail,
  pauseVerdict,
  classifyTicket,
  inFlight,
  describeTickets,
  strandedExplanation,
  drainReport,
  nagDecision,
  nagMessage,
  resumedMessage,
  sweptTicketPhrase,
  sweptSummary,
  preservedSummary,
  preservedCount,
  sweepExitCode,
  strandedBuildDestination,
  reconciledBuildDestination,
  sweptTicketNote,
  resumeAuthorization,
  numericOption,
};
