'use strict';

/**
 * A TICKET LEFT IN BUILDING BY A BUILD PASS THAT DIED (SP-101).
 *
 * On 2026-11-02 the build pass that claimed SP-92 stopped about a minute
 * later: no report, no END line in the log, a worktree with uncommitted edits
 * and no branch pushed. Nothing claims from "Building", and every pass after
 * it read the ticket as "another pass is building this" and left it alone,
 * for a day, until a hand-run session moved it back.
 *
 * The first answer (PR #79, round 1) was a timer: no lock, no PR, ninety quiet
 * minutes. Review found three holes in it, and Dane chose (C) on 2026-11-03:
 * build on the claim marker StarCaster already uses (lib/passClaim.js) instead.
 *
 *   - A claim made BY THE BUILD RUNNER's pass writes a marker naming the
 *     ticket; the hand-off (`status`, `ask`) clears it. A person's hand-run
 *     session never writes one, so no later pass can take its ticket back,
 *     however quiet it is (hole 1).
 *   - The next pass begins by reading the marker. The runner is a serial
 *     `while true` loop, so a new pass under it means the last one ended: a
 *     marked ticket still in "Building" is dead, whatever its comments say
 *     (hole 2), and whether or not it already had a PR (hole 3).
 *
 * WHAT MAKES A PASS "THE RUNNER'S" is the one thing this module adds to
 * passClaim.js: the build lane's lock (`$LOG_DIR/$SLUG-loop-build.lock`,
 * scripts/loop_runner.sh), which holds the runner's pid. StarCaster's door
 * relies on the skill passing `--pass`, but a hand-run session follows the
 * same skill, so here the door asks the lock instead: the runner exports
 * `LOOP_RUNNER_PID`, and this process's ancestors are checked as a fallback
 * for a runner started before that export existed.
 *
 * The fail-safe direction, as in passClaim.js: a ticket repaired a pass late
 * is visible in the queue; a ticket built twice is silent and expensive. So
 * every reading that cannot be taken leaves the ticket alone and says so.
 */

const path = require('node:path');

/** The skill whose lock is read. The runner names its lock after the skill. */
const BUILD_SKILL = 'loop-build';

/** The runner's lock folder, built the way scripts/loop_runner.sh builds it. */
function buildLockPath({ logDir, productSlug, home = '' }) {
  const dir = String(logDir || '').replace(/^~(?=\/|$)/, home);
  return path.join(dir, `${productSlug}-${BUILD_SKILL}.lock`);
}

/**
 * What the build lane's lock says about this process.
 *
 *   ours        this process runs under the build runner that holds the lock
 *               (its pid is LOOP_RUNNER_PID, or an ancestor): this is a loop
 *               pass, and the runner's previous pass has ended.
 *   held        a live runner holds the lock and this process is not under
 *               it: a hand-run session while a build pass may be running.
 *   free        no lock, or a lock whose pid is gone: no runner is running.
 *   unreadable  a lock exists and its pid could not be read.
 *
 * @param {{ exists: boolean, pid: string|null, alive: boolean, ancestors?: number[], runnerPid?: string|null }} reading
 */
function lockState({ exists, pid, alive, ancestors = [], runnerPid = null } = {}) {
  if (!exists) return { state: 'free', why: 'no build runner holds the lock' };
  const n = Number(String(pid ?? '').trim());
  if (!Number.isInteger(n) || n <= 0) {
    return { state: 'unreadable', why: 'the build lock exists but names no readable pid' };
  }
  if (!alive) return { state: 'free', why: `the build lock names pid ${n}, which is no longer running` };
  if (Number(String(runnerPid ?? '').trim()) === n || ancestors.map(Number).includes(n)) {
    return { state: 'ours', why: `this pass runs under the build runner (pid ${n})` };
  }
  return { state: 'held', why: `a build runner (pid ${n}) is running and this session is not under it` };
}

/** Only a claim made under the build runner arms the marker. */
function writesMarker(lock) {
  return Boolean(lock) && lock.state === 'ours';
}

/**
 * May this caller act on the marker as passClaim's PASS seat (status alone
 * proves the claiming pass is gone)? Returns null when it may, or the
 * decision to report instead, in passClaim's own actions so its message and
 * exit code apply unchanged.
 *
 *   ours  the runner's next pass: the previous one ended. Go on.
 *   free  no runner is running, so the loop pass that wrote the marker is
 *         gone too. Go on.
 *   held  a runner is running and this is not its pass: the marked ticket
 *         may be the one it is building right now. Leave it (`in-flight`).
 *   unreadable  could not tell. Leave it, loudly.
 */
function seatGate(lock, marker) {
  if (!marker || !marker.found || !marker.record) return null;
  const task = marker.record.task;
  if (!lock || lock.state === 'unreadable') {
    return { action: 'unreadable', task, reason: `${lock ? lock.why : 'the build lock was not read'}, so whether ${task}'s pass is still running cannot be told` };
  }
  if (lock.state === 'held') {
    return { action: 'in-flight', task, reason: `${lock.why}, and ${task} may be the ticket it is building` };
  }
  return null;
}

/**
 * Where a dead pass's ticket goes. A recorded PR means a branch and pushed
 * work exist: Rework, where the next pass finishes it on the SAME PR. None
 * means nothing was recorded: Queued, to be built afresh. Comments that could
 * not be read cannot rule a PR out, so they go the way that cannot lose work.
 *
 * @param {boolean|null} hasPr
 */
function handbackDestination(hasPr) {
  if (hasPr === true) return { status: 'Rework', why: 'it already has a pull request, so the next pass finishes that one' };
  if (hasPr === false) return { status: 'Queued', why: 'no pull request was recorded on it' };
  return { status: 'Rework', why: 'its comments could not be read, so a recorded pull request cannot be ruled out' };
}

/**
 * How soon after its claim a pass makes its worktree. Step 2 of the skill,
 * right after the claim: minutes, not an hour. On SP-92's 2026-11-02 pass a
 * wider window also caught three unrelated worktrees made 50 to 89 minutes
 * later by other passes.
 */
const WORKTREE_WINDOW_MS = 20 * 60 * 1000;

/**
 * The worktrees that look like the dead pass's: made from just before its
 * claim to WORKTREE_WINDOW_MS after it, on a branch that never reached the
 * remote. A guess, and the note says so; nothing is deleted on its strength.
 *
 * @param {Array<{ path: string, branch: string, createdMs: number, pushed: boolean, dirty: boolean }>} worktrees
 */
function leftoverWorktrees(worktrees, { claimedMs, windowMs = WORKTREE_WINDOW_MS, slackMs = 5 * 60 * 1000 } = {}) {
  const from = Number(claimedMs) - slackMs;
  const to = Number(claimedMs) + Number(windowMs);
  return (Array.isArray(worktrees) ? worktrees : []).filter((w) => {
    const at = Number(w.createdMs);
    return Number.isFinite(at) && at >= from && at <= to && !w.pushed;
  });
}

/**
 * Why a runner pass's claim may NOT write its marker over the one already
 * there, or null when it may. The marker is the only record of a ticket a
 * dead pass left in Building: a reconcile that failed (exit 1) or could not
 * tell (exit 2) keeps it for the next pass, and a claim that overwrote it
 * would strand that ticket for good. So the marker may be replaced only when
 * it is absent, names this same ticket, or names one known to have left
 * Building. `status` is that ticket's status now, '' when it could not be read.
 *
 * @param {{ found: boolean, record: { task: string } | null, why?: string }} marker  readMarker's answer
 * @param {string} task    the ticket this claim is taking
 * @param {string} status  the marked ticket's status, lower case, '' if unread
 */
function markerBlocksClaim({ marker, task, status }) {
  if (!marker || !marker.found) return null;
  if (!marker.record) return `the claim marker cannot be read (${marker.why || 'no reason given'}), and it may be the only record of a ticket a dead pass left in Building`;
  const marked = String(marker.record.task);
  if (marked === String(task)) return null;
  if (!status) return `the claim marker names ${marked}, whose status could not be read, so it may still be stranded in Building`;
  if (String(status).toLowerCase() === 'building') return `the claim marker names ${marked}, still in Building: the pass that claimed it never handed it on, and pass-reconcile has not put it back`;
  return null;
}

/**
 * The one note on the ticket. `when` is the claim time, already written in
 * Mountain time by the caller; `destination` is handbackDestination's answer.
 * `unlisted` is why the worktrees could not be listed, when they could not:
 * the note must not then claim none were found.
 */
function handbackNote({ when, destination, leftovers = [], unlisted = '' }) {
  const lines = [
    `Put back in ${destination.status}: the build pass that claimed this ticket${when ? ` at ${when} MT` : ''} ended without handing it on, so it sat in Building with nothing building it.`,
    `Why ${destination.status}: ${destination.why}.`,
  ];
  if (unlisted) {
    lines.push(`The worktrees could not be listed (${unlisted}), so any left over from that pass are not named here.`);
  } else if (leftovers.length) {
    lines.push('Left over from that pass, maybe (made around the claim, never pushed):');
    for (const w of leftovers) {
      lines.push(`- worktree ${w.path}, branch ${w.branch || '(detached)'}${w.dirty ? ', with uncommitted edits' : ''}`);
    }
  } else {
    lines.push('No unpushed worktree from around the claim time was found.');
  }
  lines.push('Nothing was deleted: no worktree, no branch. (Automatic: npm run clickup -- pass-reconcile, the next loop-build pass.)');
  return lines.join('\n');
}

module.exports = {
  BUILD_SKILL,
  WORKTREE_WINDOW_MS,
  buildLockPath,
  lockState,
  writesMarker,
  seatGate,
  handbackDestination,
  leftoverWorktrees,
  markerBlocksClaim,
  handbackNote,
};
