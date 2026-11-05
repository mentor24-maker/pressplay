'use strict';

/**
 * The Loop Queue's statuses, and the order loop-build drains them.
 *
 * WHY THIS EXISTS (2026-08-31, task 86bbr1u9v). Until today a ticket sent back
 * by review returned to `Queued`, where it was INDISTINGUISHABLE FROM WORK
 * THAT WAS NEVER STARTED. Three things followed, all of them measured:
 *
 *   1. It was invisible. "52 queued, 1 in review" read as 52 fresh tickets;
 *      six of them were half-built with open pull requests. Finding that out
 *      took a morning of reading logs by hand.
 *   2. It lost its place in line. A sent-back ticket re-entered the priority
 *      contest from scratch, so normal-priority rework never won against fresh
 *      high-priority work. #419 (Aug 25), #446, #447 and #449 did not go stale
 *      by accident — THE CLAIM RULE DID IT TO THEM.
 *   3. The cap could not report honestly. `wip-check` said "1 in flight, cap
 *      5" while five real branches sat open, because `Queued` is deliberately
 *      not counted — and it must not be, or the cap blocks the only work that
 *      could clear it (the 2026-08-25 deadlock, task 86bbm4zwd).
 *
 * So a send-back now lands in its own status, `Rework`, and this module is the
 * ONE place that says so. The name is Dane's call, 2026-08-31: "Recycle" was
 * rejected because recycling loses the thing's form, and here the branch, the
 * PR, the commits and the review notes all survive intact; "Send-back" was
 * rejected because it names the transition, and every other status on this
 * list names a state.
 *
 * WHY ONE MODULE AND NOT A STRING IN EACH CALLER. The status is read by the
 * claim gate, the pacing curve, the WIP cap, the pause sweep, the pulse and
 * the weekly report. `wipCap.ticketIdFromPrBody` already carries a comment
 * about the cost of two functions disagreeing about the same string; six would
 * be worse. A status list that drifts fails the way this ticket's own bug
 * failed — silently, and in the direction of looking fine.
 */

/** The Loop Queue's statuses, in the order the pipeline moves through them. */
const REQUESTED = 'requested';
const REWORK = 'rework';
const QUEUED = 'queued';
const BUILDING = 'building';
const IN_REVIEW = 'in review';
const READY_TO_LAUNCH = 'ready to launch';
const NEEDS_YOUR_INPUT = 'needs your input';
const LIVE = 'live';

/**
 * How the statuses are spelled when they are WRITTEN — ClickUp matches
 * case-insensitively on the way in, but a status printed back to a human
 * should read the way the board reads.
 */
const DISPLAY = Object.freeze({
  [REQUESTED]: 'Requested',
  [REWORK]: 'Rework',
  [QUEUED]: 'Queued',
  [BUILDING]: 'Building',
  [IN_REVIEW]: 'In review',
  [READY_TO_LAUNCH]: 'Ready to launch',
  [NEEDS_YOUR_INPUT]: 'Needs your input',
  [LIVE]: 'Live',
});

/**
 * The board's line-up, left to right, for anything that renders the stages.
 *
 * `Requested` (2026-10-30, SP-43) comes first: Dane filed it from the
 * tracker page and nobody has specced it yet. Its owner is the machine (a
 * spec pass), but it is deliberately in NONE of the sets below: not
 * claimable, because the build loop must never build from unspecced words;
 * not his, because he has already said his piece; not in flight, because no
 * pull request exists; and not terminal. It exists only in the tracker,
 * never in a ClickUp list.
 */
const STAGE_ORDER = Object.freeze([
  'Requested', 'Rework', 'Queued', 'Building', 'In review', 'Needs your input', 'Ready to launch', 'Live',
]);

/**
 * What loop-build may claim, IN DRAIN ORDER — rework before fresh work.
 *
 * This is the half of the ticket that actually fixes the staleness. A queue
 * that merely SHOWS rework separately, while still claiming by priority across
 * both tiers, reproduces consequence 2 above on day one: a normal-priority
 * rework ticket still never wins against fresh urgent work.
 *
 * Finishing half-built work is cheaper than starting new work — the branch
 * exists, the review notes exist, and every day it waits costs another
 * catch-up merge against a moving `main` (branch protection is `strict:true`,
 * so every merge dates every open branch; see wipCap.js).
 */
const CLAIMABLE_BY_BUILD = Object.freeze([REWORK, QUEUED]);

// ── The taxonomy: every SET of these eight is defined here, and only here ────
//
// (2026-09-02, task 86bbtujed — audit Phase 2.) Until today wipCap,
// pipelinePause and pulse each kept a private, partial copy of these
// groupings. When Rework was added on 2026-08-31 it had to be threaded
// through each file by hand, and wipCap and pulse had already drifted into
// DISAGREEING about what "done" means — four names versus one, both
// load-bearing. A set defined below is imported by its consumers as a view;
// the reasons a consumer cares about a particular view stay as comments ON
// that view, where they belong.

/**
 * Work that genuinely occupies the pipeline: a pull request whose ticket
 * wears one of these is real in-flight work — the merge side's question.
 * pipelinePause asks a NARROWER one (is a PASS actually running?) and derives
 * its pair of machine statuses from these minus OPERATOR_HELD, with its
 * reasoning kept on that view.
 *
 * THIS IS STILL THE HONEST TOTAL, and pulse and the throughput report both
 * want exactly it. What changed on 2026-09-04 (task 86bbuzzbk) is that
 * `wipCap` no longer measures its cap against this whole set — see
 * IN_PROGRESS_STATUSES below for the split and the reason.
 */
const IN_FLIGHT_STATUSES = Object.freeze([
  BUILDING, IN_REVIEW, READY_TO_LAUNCH, NEEDS_YOUR_INPUT,
]);

/** Parked on Dane, on purpose — only he moves a ticket out of these. */
const OPERATOR_HELD_STATUSES = Object.freeze([READY_TO_LAUNCH, NEEDS_YOUR_INPUT]);

/**
 * In-flight work that a MACHINE is still moving — in-flight minus the two
 * statuses parked on Dane. Derived, never re-listed, so the relationship is
 * what breaks if someone edits either side.
 *
 * WHY THE SPLIT EXISTS (2026-09-04, task 86bbuzzbk). `wipCap` used to measure
 * its cap of five against the whole IN_FLIGHT set, so a ticket that was
 * finished, reviewed, green and waiting only for Dane to press merge held one
 * of the five build slots for as long as he was asleep. Fill all five and the
 * build loop stops completely, however deep the queue is.
 *
 * The effect ran backwards: THE LONGER DANE WAS AWAY, THE LESS THE MACHINES
 * WERE ALLOWED TO DO. On the night of 2026-09-03 the cap sat full for three
 * separate hours with 66-71 tickets claimable, and loop-build ran roughly 222
 * of 640 minutes. It also put a hard ceiling of five on how much finished work
 * could ever be waiting for him at once — which is the thing he actually
 * asked for more of.
 *
 * WHAT THE OLD READING GOT RIGHT, AND WHY IT IS NOT LOST. The argument on
 * IN_FLIGHT_STATUSES ran: a ticket parked on Dane with an open PR is real work
 * occupying the merge pipeline, its branch still needs catching up every time
 * something lands, and "if his inbox is full the pipeline genuinely is full" —
 * so a cap that hid that would lie in the more dangerous direction. Every word
 * of that is still true, and none of it is being discarded.
 *
 * The mistake was answering it with ONE number. "Is the merge pipeline full?"
 * and "should loop-build stop producing?" are different questions, and
 * collapsing them made an honest signal into a throttle on the wrong thing.
 * So there are now two limits, not none: this set carries the build cap, and
 * OPERATOR_HELD carries its own separate ceiling in wipCap. Operator-held work
 * still bounds the loop — at its own, larger number — and `wip-check` names
 * all three counts every time. The reporting gets MORE precise, not quieter,
 * which is the direction the original argument was protecting.
 */
const IN_PROGRESS_STATUSES = Object.freeze(
  IN_FLIGHT_STATUSES.filter((s) => !OPERATOR_HELD_STATUSES.includes(s)),
);

/**
 * DECISION D1 (Dane, 2026-09-02, recorded on task 86bbtujed): `live` is the
 * ONLY terminal status. The evidence that made the recommendation: every one
 * of the 204 closed tickets in the Loop Queue is `live`, and the list defines
 * no other closed status. Before this decision wipCap counted four names as
 * finished (live/complete/closed/done) while pulse counted one — two
 * definitions of "done" running the cap and the flow diagnostics at once.
 */
const TERMINAL_STATUSES = Object.freeze([LIVE]);

/**
 * Names that mean "finished" in other systems and NEVER legitimately appear
 * in this list. Deliberately NOT terminal: silently counting one as done
 * (wipCap's old reading) while another instrument counts it in flight
 * (pulse's) is exactly the disagreement D1 closed. A ticket wearing one is
 * reported LOUDLY by name — it lands in wipCap's `unrecognised` bucket, which
 * quotes the status back — and a status ClickUp itself marks with a closed
 * TYPE is still honoured by pulse's own `status.type` check, which is a
 * different sense of "done" and stays where it is.
 */
const TERMINAL_ALIASES = Object.freeze(['complete', 'closed', 'done']);

// ── The two staleness clocks, side by side (audit finding C4) ────────────────
//
// They live with their owners, but they are RECORDED together here because
// they gate adjacent questions about the same objects and were chosen
// separately:
//
//   STRANDED_AFTER_MS      90 minutes — pipelinePause.js. A ticket sitting in
//                          a machine status untouched this long has no pass on
//                          it; the sweep, the WIP cap discount and
//                          pass-reconcile all act on this one number.
//   LOOP_STALE_AFTER_HOURS ~3 hours — pulse.js. A loop LOG silent this long
//                          means the lane looks dead (three times the pacing
//                          curve's longest interval).
//
// Both are defensible alone. Tune either only with the other in view, so the
// next adjustment is ONE decision — that sentence is the whole reason this
// comment exists.

/** ClickUp's priority names, best first. Anything unrecognised sorts last. */
const PRIORITY_RANK = Object.freeze({ urgent: 1, high: 2, normal: 3, low: 4 });
const PRIORITY_UNKNOWN = 9;

/** Lower-case a status off a ClickUp task, whatever shape it arrived in. */
function statusOf(task) {
  if (typeof task === 'string') return task.trim().toLowerCase();
  return String(task?.status?.status ?? '').trim().toLowerCase();
}

/** Is this a status loop-build may claim from? */
function isClaimableByBuild(status) {
  return CLAIMABLE_BY_BUILD.includes(String(status ?? '').trim().toLowerCase());
}

/**
 * Which tier a status claims in: 0 = rework, 1 = queued, null = not claimable.
 * `null` rather than a large number on purpose — a caller that sorts on this
 * must decide what to do with a ticket that is not in the contest at all,
 * rather than have it silently sort to the end and look claimable.
 */
function claimTier(status) {
  const s = String(status ?? '').trim().toLowerCase();
  const at = CLAIMABLE_BY_BUILD.indexOf(s);
  return at === -1 ? null : at;
}

/** ClickUp's dates arrive as strings; a missing one sorts oldest. */
function createdAt(task) {
  const n = Number(task?.date_created);
  return Number.isFinite(n) ? n : 0;
}

function priorityRank(task) {
  return PRIORITY_RANK[String(task?.priority?.priority ?? '').toLowerCase()] ?? PRIORITY_UNKNOWN;
}

/**
 * The claim order, as a comparator: every `Rework` ticket before every
 * `Queued` one, and within each tier the rule that tier deserves.
 *
 * REWORK IGNORES PRIORITY, AND THAT IS DELIBERATE. Priority is a statement
 * about what to START; rework is not started, it is finished. Ordering rework
 * by priority would recreate the same starvation one tier down — the two-week
 * old normal-priority send-back losing to the fresh urgent one, which is
 * exactly what #419 has been doing since 25 August. Oldest first, full stop.
 *
 * `Queued` keeps the rule it has always had: priority, then oldest. Nothing
 * about fresh work changed.
 *
 * A ticket in neither tier sorts after both, but see `claimTier` — a caller
 * should filter first rather than lean on that.
 */
function compareForClaim(a, b) {
  const ta = claimTier(statusOf(a));
  const tb = claimTier(statusOf(b));
  const ra = ta === null ? CLAIMABLE_BY_BUILD.length : ta;
  const rb = tb === null ? CLAIMABLE_BY_BUILD.length : tb;
  if (ra !== rb) return ra - rb;
  // Within rework, age alone. Within queued, priority then age.
  if (ra === claimTier(QUEUED)) {
    const pa = priorityRank(a);
    const pb = priorityRank(b);
    if (pa !== pb) return pa - pb;
  }
  return createdAt(a) - createdAt(b);
}

/**
 * Every ticket loop-build could claim, in the order it should claim them.
 * Pure, and non-mutating — the caller's array is left alone.
 */
function claimOrder(tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && typeof t === 'object' && isClaimableByBuild(statusOf(t)))
    .slice()
    .sort(compareForClaim);
}

module.exports = {
  IN_FLIGHT_STATUSES,
  OPERATOR_HELD_STATUSES,
  IN_PROGRESS_STATUSES,
  TERMINAL_STATUSES,
  TERMINAL_ALIASES,
  REQUESTED,
  REWORK,
  QUEUED,
  BUILDING,
  IN_REVIEW,
  READY_TO_LAUNCH,
  NEEDS_YOUR_INPUT,
  LIVE,
  DISPLAY,
  STAGE_ORDER,
  CLAIMABLE_BY_BUILD,
  PRIORITY_RANK,
  PRIORITY_UNKNOWN,
  statusOf,
  isClaimableByBuild,
  claimTier,
  compareForClaim,
  claimOrder,
};
