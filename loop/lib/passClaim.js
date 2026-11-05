'use strict';

/**
 * THE CLAIM MARKER — how a loop-build pass proves it finished what it started.
 *
 * WHY THIS EXISTS (2026-09-02, task 86bbtmbpc). A loop pass claims a ticket by
 * moving it to "Building", and the loops claim only from "Rework" and
 * "Queued". So a pass that ends without handing its ticket on leaves it
 * unreachable — not slow, not queued, but invisible to every actor in the
 * system, forever, until a person moves it by hand.
 *
 * It happened twice on the night of 2026-09-01, in two shapes that need
 * different answers:
 *
 *   86bbjt1b4  the pass RAN TO COMPLETION. It finished PR #449, wrote
 *              "I have a waiter armed that will bring me back the moment all
 *              four checks settle", and exited 0 at 00:29 without moving the
 *              ticket. There is no coming back: a pass is a one-shot
 *              `claude -p` session that ends when it stops producing output.
 *
 *   86bbr2jpq  the pass was KILLED. Claimed at 2:06am, dead at 2:08 on
 *              "You've hit your session limit · resets 2:50am".
 *
 * The second is why none of this lives inside the pass. Nothing in a killed
 * session runs again — no `Stop` hook, no "before you finish" instruction, no
 * amount of skill prose. The repair has to be done by something that runs
 * AFTERWARDS, and the cheapest thing guaranteed to run afterwards is the next
 * pass: the runner is a `while true` loop, and a fresh session is precisely
 * what survives the previous one being killed.
 *
 * So: claiming writes a marker, handing off clears it, and every pass begins
 * by reconciling whatever the last one left behind.
 *
 * WHY THE MARKER IS OPT-IN. A hand-driven fast-track session claims tickets
 * with the same command. If every claim wrote a marker, a later loop pass
 * would find a ticket a person is actively building and hand it back out from
 * under them. Only the loop skill passes `--pass`, and that is the whole of
 * the safety argument — there is no timing heuristic here to get wrong.
 */

const fs = require('node:fs');
const path = require('node:path');
const pipelinePause = require('./pipelinePause.js');

/** The one filename, so writer and reader cannot drift. */
const MARKER_FILE = 'loop-pass-claim.json';

/**
 * WHO IS ASKING (2026-09-04, task 86bbu60ax).
 *
 * This command was written as the FIRST thing a new `loop-build` pass runs,
 * and in that seat one inference is free: the runner is a serial `while true`
 * loop, so a new pass starting means the previous pass ENDED. A ticket still
 * in "Building" therefore has nothing working on it, and the status alone is
 * proof enough.
 *
 * Then `npm run repair` started calling the same command on a timer — the
 * relay's ten-minute idle wake, throttled to one reading per half hour. The
 * inference does not travel: a schedule firing says nothing whatever about
 * whether a pass is running. So a build that outlived the throttle had its
 * LIVE claim revoked on a timer, twice in one morning on task 86bbqb0ac,
 * while the pass was still building. Between the revocation and the pass's own
 * hand-off the ticket sits in "Queued" — claimable — with a live pass on it,
 * which is the 2026-08-20 double-build arriving through the mechanism meant to
 * prevent stranding.
 *
 * Hence a trigger. Same command, two seats, and the seat is stated rather
 * than assumed.
 */
const TRIGGER_PASS = 'pass';
const TRIGGER_SCHEDULED = 'scheduled';

/**
 * How long a claim may be young enough that the SCHEDULED caller must leave it
 * alone.
 *
 * WHY NOT THE PID. The marker records one (`claimRecord` below), and it is the
 * obvious liveness signal — but it is the pid of the short-lived
 * `clickup_direct.mjs claim` process, which exits seconds after writing the
 * file, not of the pass. Measured on a live claim on 2026-09-04: the marker
 * for a ticket being actively built named pid 21193, already gone. A liveness
 * probe on it would call EVERY claim dead — the present bug, re-derived — and
 * pid reuse would occasionally do the reverse and strand a ticket forever.
 *
 * So: age, and BORROWED rather than re-declared. `pipelinePause` already
 * answers "how long may a pass hold a ticket before it is stranded rather than
 * busy", argued out to ninety minutes ("longer than any pass observed to date
 * and far shorter than forever"). A second number here would be a second
 * definition of the same thing, free to drift.
 */
const LIVE_CLAIM_GRACE_MS = pipelinePause.STRANDED_AFTER_MS;

/**
 * Where the marker lives: beside the SHARED git directory, not inside the
 * worktree the pass is about to create.
 *
 * `git rev-parse --git-common-dir` is the shared `.git` even when it is asked
 * from inside a linked worktree, where plain `.git` is a file pointing
 * somewhere else. That matters because the claim happens in the main checkout
 * and the hand-off happens inside the pass's worktree — a path that resolved
 * differently in those two places would write one marker and clear another,
 * which is worse than having none at all.
 */
function markerPath(gitCommonDir) {
  return path.join(String(gitCommonDir || '.git'), MARKER_FILE);
}

/**
 * What one claim records, READING a marker back off disk.
 *
 * `at` IS read, by the scheduled reconcile, which has no other way to tell a
 * dead pass from a slow one (see LIVE_CLAIM_GRACE_MS). `pid` is not read by
 * anything and must not be: it belongs to the claim process, not the pass.
 * It stays because it is what turns a confusing file into a legible one when
 * somebody finds it by hand at 3am.
 *
 * THIS FUNCTION MUST NOT INVENT A DATE (found in review, 2026-09-04). It used
 * to finish `at: at || new Date().toISOString()`, which is correct for a
 * WRITE and catastrophic for a READ: every scheduled run is a fresh process,
 * so a marker with no `at` was stamped with "now" on each pass and read as
 * "claimed 0 min ago" forever. The ticket was left in "Building" every single
 * run, for a week if need be, and the `undated` branch below — the one that
 * exists to say COULD NOT TELL out loud — could never be reached through the
 * real path. That is a silent guess standing exactly where the loud one was
 * specified, and it disabled the backstop in the case the scheduled repair
 * exists for (the runner dead, so no next pass to run the `pass` seat).
 *
 * The clock belongs at the WRITE site instead: `newClaimRecord` below.
 */
function claimRecord({ task, skill, at, pid }) {
  return {
    task: String(task || ''),
    skill: String(skill || ''),
    at: at == null ? null : String(at),
    pid: Number.isFinite(Number(pid)) ? Number(pid) : null,
  };
}

/**
 * What one claim records, WRITING it — the same shape, with the clock read
 * once, here, at the moment the claim is actually made.
 *
 * Separate from `claimRecord` on purpose: those are two different jobs that
 * shared one function and one default, and the default that a write needs is
 * the one a read must never have. Keeping the stamp here means a marker on
 * disk either carries the time it was claimed or carries nothing — and
 * "nothing" reaches `undated` and says so, instead of being quietly refreshed
 * into "just now" by whoever happens to read it.
 */
function newClaimRecord({ task, skill, pid, at = new Date().toISOString() }) {
  return claimRecord({ task, skill, at, pid });
}

/**
 * Read a marker back, or null.
 *
 * A FILE THAT CANNOT BE PARSED IS NOT "NO CLAIM". Returning null for corrupt
 * JSON would silently drop the ticket it names, which is the failure this
 * whole module exists to prevent — so it is reported as unreadable and the
 * caller says so rather than proceeding as if the deck were clear
 * (DOCTRINE 3.11).
 */
function readMarker(file, { readFile = (f) => fs.readFileSync(f, 'utf8'), exists = fs.existsSync } = {}) {
  if (!exists(file)) return { found: false, record: null, why: '' };
  let text;
  try {
    text = readFile(file);
  } catch (err) {
    return { found: true, record: null, why: `the marker could not be read (${err?.message || err})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { found: true, record: null, why: 'the marker is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || !String(parsed.task || '').trim()) {
    return { found: true, record: null, why: 'the marker names no task' };
  }
  return { found: true, record: claimRecord(parsed), why: '' };
}

/** "1.5 hours", for a message a person reads at 3am. */
function humanMs(ms) {
  const mins = Math.round(Number(ms) / 60000);
  if (!Number.isFinite(mins)) return 'an unknown time';
  if (mins < 90) return `${mins} min`;
  return `${(mins / 60).toFixed(1)} hours`;
}

/**
 * What to do about the marker the last pass left, given the ticket's status
 * NOW and WHO IS ASKING (`trigger`, see TRIGGER_PASS above). The decision,
 * separated from the doing, so every branch is testable.
 *
 *   nothing      no marker: the last pass handed its ticket on. The normal case.
 *   unreadable   a marker exists and could not be understood, or the status
 *                could not be read. Say so; act on nothing, because acting
 *                would mean guessing which ticket.
 *   resolved     the ticket has moved on by itself. Clear the marker quietly —
 *                this is what a pass that hit `ship` but died before clearing
 *                looks like, and it is not a fault.
 *   in-flight    SCHEDULED caller only: the ticket is in "Building" and the
 *                last sign of life on it — the claim, or the last activity on
 *                the ticket, whichever is newer — is younger than the grace,
 *                so a pass is very likely still on it. Leave it exactly where
 *                it is and say why.
 *   undated      SCHEDULED caller only: the ticket is in "Building" and the
 *                claim carries no readable date, so its age cannot be
 *                established. NOT a hand-back — "could not tell" is never a
 *                licence to move a ticket (DOCTRINE 3.11).
 *   handback     the ticket is STILL in "Building" and nothing is working on
 *                it. This is the defect. Hand it back.
 *
 * The fail-safe direction, stated once: a ticket repaired late is loud and
 * visible in the queue; a ticket built twice is silent and expensive. Those
 * are not symmetric, so every branch that cannot PROVE the pass is dead leaves
 * the ticket alone.
 */
function reconcileDecision({
  marker,
  status,
  trigger = TRIGGER_PASS,
  nowMs = Date.now(),
  lastActivityMs = null,
  graceMs = LIVE_CLAIM_GRACE_MS,
} = {}) {
  if (!marker || !marker.found) return { action: 'nothing', reason: 'no pass left a claim behind' };
  if (!marker.record) return { action: 'unreadable', reason: marker.why || 'the marker could not be understood' };

  const task = marker.record.task;
  const now = String(status || '').trim().toLowerCase();

  // The status could not be read. NOT a hand-back: moving a ticket on a
  // reading we did not take is how a live build gets yanked out from under a
  // pass that is genuinely running.
  if (!now) {
    return { action: 'unreadable', task, reason: `the status of ${task} could not be read, so nothing was moved` };
  }
  if (now !== 'building') {
    return { action: 'resolved', task, status: now, reason: `${task} is "${now}" — the pass handed it on` };
  }

  // Only the pass seat may infer death from the status alone, because only
  // there does a new pass starting mean the old one ended. Note the test is
  // for the SAFE seat, not the conservative one: an unrecognised trigger — a
  // typo, a future caller that forgot — lands in the scheduled branch and
  // leaves live work alone.
  if (String(trigger) === TRIGGER_PASS) {
    return {
      action: 'handback',
      task,
      reason: `${task} is still "Building" and the pass that claimed it is gone — nothing claims from Building, so it would sit there forever`,
    };
  }

  const claimedAtMs = Date.parse(marker.record.at);
  if (!Number.isFinite(claimedAtMs)) {
    return {
      action: 'undated',
      task,
      reason: `${task} is "Building" and its claim carries no readable date (${JSON.stringify(marker.record.at)}), `
        + 'so there is no way to tell a dead pass from a slow one — nothing was moved',
    };
  }

  // THE SAME CLOCK THE SWEEP USES, not just the same number (found in review,
  // 2026-09-04). The grace is borrowed from `pipelinePause.STRANDED_AFTER_MS`,
  // but that constant means "90 minutes of no activity ON THE TICKET"
  // (`classifyTicket` measures `now - date_updated`), while the marker's `at`
  // is written once at the claim and never refreshed. Borrowing the number
  // without the measurement left the two free to disagree anyway: the `marker`
  // and `stranded` steps of ONE `npm run repair` run could reach opposite
  // conclusions about the same ticket, and a pass that was demonstrably alive
  // at minute 91 — it had just commented — was judged dead.
  //
  // So the age is measured from the LATEST evidence of life: the claim, or the
  // last thing that happened on the ticket, whichever is newer. The claim is
  // the floor, so a caller that cannot supply the activity clock gets exactly
  // the old behaviour rather than a worse one.
  //
  // It cuts the safe way. Ticket activity that is not the pass — Dane leaving
  // a comment on a stranded ticket — defers the SCHEDULED repair by another
  // grace, and that is the cheap direction: a stranded ticket somebody is
  // typing on is not the silent case, and the next pass's `pass` seat still
  // repairs it at once.
  const activityMs = Number(lastActivityMs);
  const lastSignMs = Number.isFinite(activityMs) ? Math.max(claimedAtMs, activityMs) : claimedAtMs;
  const age = Number(nowMs) - lastSignMs;
  const claimAge = Number(nowMs) - claimedAtMs;
  const alsoActive = lastSignMs > claimedAtMs;

  // A claim stamped in the future is a clock disagreeing with itself, not
  // evidence of anything. It reads as young, which is the direction that
  // leaves work alone.
  if (!(age > Number(graceMs))) {
    return {
      action: 'in-flight',
      task,
      ageMs: age,
      claimAgeMs: claimAge,
      reason: `${task} was claimed ${humanMs(Math.max(claimAge, 0))} ago by ${marker.record.skill || 'a loop'}`
        + (alsoActive ? `, and something last happened on it ${humanMs(Math.max(age, 0))} ago` : '')
        + `, inside the ${humanMs(graceMs)} a pass may legitimately take — a pass is very likely still building it`,
    };
  }

  return {
    action: 'handback',
    task,
    ageMs: age,
    claimAgeMs: claimAge,
    reason: `${task} is still "Building" ${humanMs(claimAge)} after it was claimed`
      + (alsoActive ? ` and ${humanMs(age)} after anything last happened on it` : '')
      + `, past the ${humanMs(graceMs)} `
      + 'any pass has ever needed — nothing claims from Building, so it would sit there forever',
  };
}

/**
 * WHO ACTUALLY MOVED THE TICKET, and what to type to watch it happen again.
 *
 * The hand-back note used to say "the next loop-build pass" and print
 * `npm run clickup -- pass-reconcile` whatever the seat, so a scheduled
 * revocation credited a pass that never ran — `npm run repair` on the relay's
 * idle wake did — and handed the reader a command that is a DIFFERENT PROGRAM:
 * without `--scheduled` it is the pass seat, status-only, no grace at all.
 *
 * `sweptTicketNote`'s own comment block already names this class of thing —
 * "a trail that names the wrong actor is the defect, not a wording preference"
 * (DOCTRINE 2.5/2.6) — and records being fixed for it twice. This is the third,
 * and it is a function this time so the two seats cannot drift apart again.
 *
 * The seat test is the SAFE one, matching `reconcileDecision`: only an exact
 * `pass` gets the pass wording, because only an exact `pass` gets the pass
 * decision. An unrecognised trigger is judged as scheduled, so it must be
 * described as scheduled too — a note that disagrees with the branch that
 * wrote it is the same defect one layer down.
 */
function handbackActor(trigger, { skill = '' } = {}) {
  if (String(trigger) === TRIGGER_PASS) {
    return {
      by: `the next ${skill || 'loop'} pass`,
      command: 'npm run clickup -- pass-reconcile',
    };
  }
  return {
    by: 'npm run repair (scheduled) on the relay\'s idle wake',
    command: 'npm run clickup -- pass-reconcile --scheduled',
  };
}

/**
 * The line the pass prints about what it found. It is deliberately loud on
 * `handback`: that line is the only evidence in the runner log that a previous
 * pass dropped its ticket, and a defect nobody can see is a defect nobody
 * fixes.
 */
function reconcileMessage(decision, { destination = '' } = {}) {
  if (!decision) return '';
  switch (decision.action) {
    case 'nothing':
      return 'No claim was left behind by the previous pass.';
    case 'resolved':
      return `Cleared a stale claim marker — ${decision.reason}.`;
    case 'unreadable':
    case 'undated':
      return `COULD NOT TELL: ${decision.reason}. Nothing was moved; the marker is left in place.`;
    case 'in-flight':
      return `LEFT ALONE — ${decision.reason}. The claim stands.`;
    case 'handback':
      return `THE PREVIOUS PASS DROPPED ITS TICKET — ${decision.reason}. `
        + `Handed back to ${destination || 'the claim line'}.`;
    default:
      return `Unrecognised reconcile action "${decision.action}" — nothing was done.`;
  }
}

/**
 * Exit code for the standalone command.
 *
 *   0  nothing to do, a stale marker cleared, or a LIVE claim deliberately
 *      left alone — all three are "the deck is as it should be"
 *   1  a hand-back was needed and could not be completed
 *   2  a marker exists and could not be understood, the status could not be
 *      read, or a claim's age could not be established — "could not tell",
 *      which must never read as 0
 *   3  a hand-back was performed. A normal outcome, and NOT 0, because the
 *      caller (and the log) should be able to see that a previous pass failed
 *      to finish without reading prose.
 *
 * `in-flight` is 0 and not 3 on purpose: nothing was repaired and nothing is
 * wrong. It is the ordinary state of a machine that is building something, and
 * `npm run repair` reads 3 as news worth posting to the bus — a bus message
 * every half hour saying "a build is in progress" is the noise every sentinel
 * here is built to avoid.
 */
function reconcileExitCode({ action, ok = true } = {}) {
  if (action === 'unreadable' || action === 'undated') return 2;
  if (action === 'handback') return ok ? 3 : 1;
  return 0;
}

module.exports = {
  MARKER_FILE,
  TRIGGER_PASS,
  TRIGGER_SCHEDULED,
  LIVE_CLAIM_GRACE_MS,
  markerPath,
  claimRecord,
  newClaimRecord,
  readMarker,
  reconcileDecision,
  handbackActor,
  reconcileMessage,
  reconcileExitCode,
};
