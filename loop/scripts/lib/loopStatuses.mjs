/**
 * The Loop Queue's statuses, and the order loop-build drains them.
 *
 * Copied from StarCaster's scripts/builder/loopStatuses.js, where each of
 * these choices was paid for by an incident. The short version:
 *
 *  - A send-back lands in `Rework`, its own status, so a half-built ticket
 *    (branch, PR and review notes all intact) is never mistaken for work
 *    nobody has started.
 *  - loop-build claims every `Rework` ticket before any `Queued` one, rework
 *    OLDEST FIRST with priority ignored. Priority says what to START; rework
 *    is not started, it is finished.
 *  - `Requested` is first on the board: Dane filed it from the tracker page
 *    and nobody has specced it yet. A spec pass owns it, so it is a machine
 *    status, but the build loop never claims it and it is never his. It
 *    exists only in the tracker, never in a ClickUp list.
 *  - `Live` is the ONLY terminal status, and it must be a closed-type status
 *    in ClickUp, or finished work never leaves Dane's open view.
 *
 * This module is the one place the names live. Every command that reads a
 * status reads it from here.
 */

export const REQUESTED = 'requested';
export const REWORK = 'rework';
export const QUEUED = 'queued';
export const BUILDING = 'building';
export const IN_REVIEW = 'in review';
export const READY_TO_LAUNCH = 'ready to launch';
export const NEEDS_YOUR_INPUT = 'needs your input';
export const LIVE = 'live';

/** How each status is spelled when WRITTEN. ClickUp matches case-insensitively. */
export const DISPLAY = Object.freeze({
  [REQUESTED]: 'Requested',
  [REWORK]: 'Rework',
  [QUEUED]: 'Queued',
  [BUILDING]: 'Building',
  [IN_REVIEW]: 'In review',
  [READY_TO_LAUNCH]: 'Ready to launch',
  [NEEDS_YOUR_INPUT]: 'Needs your input',
  [LIVE]: 'Live',
});

/** The board, left to right. */
export const STAGE_ORDER = Object.freeze([
  'Requested', 'Rework', 'Queued', 'Building', 'In review', 'Needs your input', 'Ready to launch', 'Live',
]);

/** What loop-build may claim, in drain order. */
export const CLAIMABLE_BY_BUILD = Object.freeze([REWORK, QUEUED]);

/** Parked on Dane, on purpose. Only he moves a ticket out of these. */
export const OPERATOR_STATUSES = Object.freeze([READY_TO_LAUNCH, NEEDS_YOUR_INPUT]);

/** Work a machine is still moving. */
export const MACHINE_STATUSES = Object.freeze([REQUESTED, REWORK, QUEUED, BUILDING, IN_REVIEW]);

export const TERMINAL_STATUSES = Object.freeze([LIVE]);

/** ClickUp's priority names, best first. Anything unrecognised sorts last. */
export const PRIORITY_RANK = Object.freeze({ urgent: 1, high: 2, normal: 3, low: 4 });
export const PRIORITY_UNKNOWN = 9;

/** ClickUp's numeric priorities for writes. */
export const PRIORITY_VALUE = Object.freeze({ urgent: 1, high: 2, normal: 3, low: 4 });

export function statusOf(task) {
  if (typeof task === 'string') return task.trim().toLowerCase();
  return String(task?.status?.status ?? '').trim().toLowerCase();
}

export function isClaimableByBuild(status) {
  return CLAIMABLE_BY_BUILD.includes(String(status ?? '').trim().toLowerCase());
}

export function isOperatorStatus(status) {
  return OPERATOR_STATUSES.includes(String(status ?? '').trim().toLowerCase());
}

export function isReadyToLaunch(status) {
  return String(status ?? '').trim().toLowerCase() === READY_TO_LAUNCH;
}

/** 0 = rework, 1 = queued, null = not claimable. */
export function claimTier(status) {
  const at = CLAIMABLE_BY_BUILD.indexOf(String(status ?? '').trim().toLowerCase());
  return at === -1 ? null : at;
}

function createdAt(task) {
  const n = Number(task?.date_created);
  return Number.isFinite(n) ? n : 0;
}

export function priorityRank(task) {
  return PRIORITY_RANK[String(task?.priority?.priority ?? '').toLowerCase()] ?? PRIORITY_UNKNOWN;
}

/** Rework before Queued; rework oldest-first; queued by priority then age. */
export function compareForClaim(a, b) {
  const ta = claimTier(statusOf(a));
  const tb = claimTier(statusOf(b));
  const ra = ta === null ? CLAIMABLE_BY_BUILD.length : ta;
  const rb = tb === null ? CLAIMABLE_BY_BUILD.length : tb;
  if (ra !== rb) return ra - rb;
  if (ra === claimTier(QUEUED)) {
    const pa = priorityRank(a);
    const pb = priorityRank(b);
    if (pa !== pb) return pa - pb;
  }
  return createdAt(a) - createdAt(b);
}

/** Every ticket loop-build could claim, in the order it should claim them. */
export function claimOrder(tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && typeof t === 'object' && isClaimableByBuild(statusOf(t)))
    .slice()
    .sort(compareForClaim);
}

/** Within one status: highest priority first, then oldest. */
export function compareWithinStatus(a, b) {
  return priorityRank(a) - priorityRank(b) || createdAt(a) - createdAt(b);
}
