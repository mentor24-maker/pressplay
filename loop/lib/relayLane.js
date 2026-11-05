'use strict';

/**
 * relayLane — the pure decisions of Spirality's relay pass that are NOT
 * already in mergeOnComment.
 *
 * WHY THIS EXISTS (2026-10-13, task 86bchpkxz). Dane wrote "merge PR #4" on
 * a Ready to launch ticket at 9:23 AM and nothing read it for four hours:
 * Spirality ran only loop-build and loop-review, and neither one merges.
 * `mergeOnComment` already decides WHETHER his word authorizes a merge
 * (mergeDecision) and whether GitHub will allow it (githubGate). What was
 * missing is the hands: a pass that reads the queue, carries those decisions
 * out, and writes the record back. That pass is the `relay` command in
 * scripts/clickup.mjs; the parts of it that can be decided without a network
 * live here, so each is tested without ClickUp or GitHub.
 *
 * Four small questions:
 *
 *   1. What do the threaded replies under one of his comments say about an
 *      earlier pass's answer?            → markerBookkeeping
 *   2. After the merge, Live or Queued?  → mergeDestination
 *   3. What does `gh pr view` need to be asked for, so githubGate can read
 *      every field it looks at?          → PR_VIEW_FIELDS
 *   4. His reply on a `Needs your input` ticket: move it, and where?
 *                                        → handbackAnswer, handbackPlan
 *   5. A PR his word cannot merge because it conflicts: file a catch-up
 *      ticket, or is one already on file? → conflictFilingPlan
 *   6. His close word on a `Ready to launch` ticket: is its work merged,
 *      so it goes to Live, or does the relay say why not? → closePlan
 *
 * Nothing here merges, posts, or reads a config. Every product-specific value
 * (the operator's id, the merge phrases, the repository) reaches the relay
 * through the project config at the door, never through this file.
 */

const { latestMergeMarker, countMergeRefusals } = require('./mergeOnComment');
const {
  answerAwaitingHandback, handbackDestination, isCloseCommand, latestCloseRefusal,
  repliesShowHandbackDone, repliesShowHandbackFailure,
} = require('./busRelayPlan.js');
const { NEXT_SLICE_RE, mergeDestination } = require('./nextSlice.js');
const { findConflictTicket, shouldFileConflictTicket } = require('./conflictWork.js');
const { REWORK, QUEUED, IN_PROGRESS_STATUSES, DISPLAY, statusOf } = require('./loopStatuses.js');

/**
 * The statuses in which a filed catch-up ticket is still work a loop will do
 * (SP-100): Rework and Queued the build loop claims, Building and In review a
 * pass is moving. Anywhere else (Ready to launch, Needs your input, Live) the
 * catch-up already landed or is parked on Dane, and no loop will touch it
 * again, so a conflict that persists is a NEW conflict and needs new work.
 */
const CATCH_UP_WORKED_STATUSES = Object.freeze([REWORK, QUEUED, ...IN_PROGRESS_STATUSES]);

/**
 * Every field githubGate reads, plus the three the relay itself needs (url,
 * headRefOid, mergedAt). Asking for fewer would make the gate answer "cannot
 * tell" for a field it was never given; asking here, in one list, is what
 * keeps the dry run and the real pass reading the same pull request.
 */
const PR_VIEW_FIELDS = Object.freeze([
  'state', 'isDraft', 'mergeable', 'mergeStateStatus', 'reviewDecision',
  'statusCheckRollup', 'url', 'headRefOid', 'mergedAt', 'number', 'headRefName',
]);

/**
 * Read one operator comment's reply thread into the bookkeeping mergeDecision
 * wants: is this authorization spent (a terminal marker), or was it refused,
 * and if so for what reason, when, and how many times for that reason?
 *
 * Copied from the loop body of StarCaster's bus-relay (scripts/
 * clickup_direct.mjs), where it was inline and untested; the rules are
 * mergeOnComment's, read through its own parser so the writer and the reader
 * cannot drift.
 */
function markerBookkeeping(replies) {
  const marker = latestMergeMarker(replies);
  if (!marker) return { marker: null, handled: false, refused: null, refusedAt: '', refusedCount: 0 };
  if (marker.kind === 'refused') {
    return {
      marker,
      handled: false,
      refused: marker.reason,
      refusedAt: marker.at || '',
      refusedCount: countMergeRefusals(replies, marker.reason),
    };
  }
  return { marker, handled: true, refused: null, refusedAt: '', refusedCount: 0 };
}

/**
 * Fold one comment's bookkeeping into the maps mergeDecision takes. Returns
 * the same object it was given, mutated, so a caller can build the maps in a
 * loop with no second copy of the key-stringing rule.
 */
function recordBookkeeping(books, commentId, keeping) {
  const id = String(commentId);
  if (keeping.handled) books.handled.add(id);
  if (keeping.refused != null) {
    books.refused.set(id, keeping.refused);
    books.refusedAt.set(id, keeping.refusedAt);
    books.refusedCount.set(id, keeping.refusedCount);
  }
  return books;
}

function emptyBooks() {
  return { handled: new Set(), refused: new Map(), refusedAt: new Map(), refusedCount: new Map() };
}

/**
 * THE HAND-BACK: where an answered `Needs your input` ticket goes
 * (task 86bchpkxz, slice 2).
 *
 * The rules are busRelayPlan's, unchanged: the newest machine-written
 * question card is the question, his newest comment after it is the answer,
 * a hold-by-hand marker newer than the card withholds the move, an answer
 * already carrying the `[bus-relay-handback-done]` reply is spent, and
 * `handbackDestination` reads the answer ("close it") and then the ticket's
 * PR to pick `Queued`, `Rework` or `Live`. Two questions, because the second
 * needs a read the first decides whether to spend:
 *
 *   handbackAnswer(...)  which of his comments, if any, answers the card?
 *   handbackPlan(...)    given that answer's reply thread and the PR's
 *                        state, what does this pass do?
 *
 * WHERE THIS DIFFERS FROM STARCASTER, on purpose. StarCaster's bus-relay
 * relays his words to a party line and moves the ticket only on an answer
 * that was DELIVERED there (or receipted). Spirality has no party line: the
 * ticket is the only place his answer goes, and the loops read it there, so
 * an answer on the ticket is delivered by being written. The other half of
 * StarCaster's rule does not carry over: on a ticket with NO card it moves on
 * any comment relayed for the first time, and "first time" is a relay marker
 * Spirality never writes. Without it an old comment and a new one look the
 * same, so a ticket with no card is reported and left where it is — the
 * narrow mistake (a session moves it by hand) instead of the generous one
 * (a loop takes a ticket out of his status on something he said last week).
 * Spirality's `ask` always writes a card, so this is the hand-parked case.
 */
const HANDBACK_WATCH = { label: 'Loop Queue', handback: { 'needs your input': 'Queued' } };

function handbackAnswer({ comments, operatorId, isMachine }) {
  return answerAwaitingHandback({ comments, operatorId, isMachine, delivered: () => true });
}

/**
 * @param status        the ticket's status now
 * @param verdict       handbackAnswer()'s result
 * @param answerReplies the reply thread under verdict.answer (read only when
 *                      verdict.state is 'answered'; otherwise ignored)
 * @param pr            null for no `PR opened:` line, else { number, state }
 *                      with state '' and a `why` when it could not be read
 * @param description   the ticket's description; its "Next slice:" line
 *                      decides Live or Queued when the PR is already merged
 * @returns { act, target, why, failureNoted }
 *          act: 'move' | 'waiting' | 'held' | 'no-card' | 'handled' | 'skip' | 'cannot-tell'
 */
function handbackPlan({ status, verdict, answerReplies, pr, description }) {
  const quiet = (act, why) => ({ act, target: null, why, failureNoted: false });
  const state = verdict && verdict.state;
  if (state === 'hand-held') return quiet('held', 'a "HELD BY HAND" note is newer than the question card — the session driving it moves it');
  if (state === 'no-question') {
    return quiet('no-card', 'there is no machine-written question card on this ticket, so no reply can be told apart from an older one — a session must move it');
  }
  if (state === 'none') return quiet('waiting', 'no reply of his is newer than the question card');
  if (state !== 'answered') return quiet('cannot-tell', `the answer could not be read (${state || 'no verdict'})`);
  if (repliesShowHandbackDone(answerReplies)) {
    return quiet('handled', 'his newest answer was already acted on — the ticket was parked here again by hand, so it stays');
  }
  const plan = handbackDestination(
    HANDBACK_WATCH, status, true, pr || null, verdict.answer && verdict.answer.comment_text, description,
  );
  return { ...plan, failureNoted: repliesShowHandbackFailure(answerReplies) };
}

/**
 * THE CLOSE WORD ON A `Ready to launch` TICKET (2026-10-31, SP-68).
 *
 * The hand-back above reads answers only on `Needs your input`. SP-64, a
 * catch-up ticket with no PR of its own, sat in Ready to launch after the PR
 * it unstuck merged, and its card could only tell Dane to move it to Live
 * himself, which the page cannot do. So his close word there is read too,
 * on the hand-back's own rules: the newest machine card is the question, a
 * "HELD BY HAND" note newer than it withholds the move, and an answer that
 * already carries the done marker is spent.
 *
 * One rule more, because Ready to launch is a status that waits on a merge:
 * the ticket goes to Live only when its work IS merged. That is its own PR,
 * or, with none of its own, the PR it was filed to unstick (the `- PR:` line
 * of a catch-up ticket's description). Anything else is said once, as a
 * reply under his word, and the word stays good for the pass after the merge.
 *
 * @param verdict       handbackAnswer()'s result for the ticket
 * @param answerReplies the reply thread under verdict.answer
 * @param ownPr         null for no `PR opened:` line, else { number, state }
 *                      (state '' with a `why` when it could not be read)
 * @param unstuckPr     the same shape for the PR it was filed to unstick, or
 *                      null; read only when there is no PR of its own
 * @returns { act, target, why, pending }
 *          act: 'not-close' (no close word to act on: the merge step decides)
 *             | 'move' | 'refuse' | 'refused-quiet' | 'cannot-tell'
 *          pending (on a refusal): true only while the PR is still open, the
 *          one case where a later merge can still close it
 */
function closePlan({ verdict, answerReplies, ownPr, unstuckPr }) {
  const pass = (why) => ({ act: 'not-close', target: null, why });
  const state = verdict && verdict.state;
  if (state === 'hand-held') return pass('a "HELD BY HAND" note is newer than the question card');
  if (state !== 'answered') return pass('no answer of his is newer than the question card');
  if (!isCloseCommand(verdict.answer && verdict.answer.comment_text)) return pass('his newest answer is not a close word');
  if (repliesShowHandbackDone(answerReplies)) return pass('his close word was already acted on');

  const pr = ownPr || unstuckPr || null;
  const which = pr ? `PR #${pr.number || '?'}` : '';
  const whose = ownPr ? `its own ${which}` : `${which}, the pull request this ticket was filed to unstick,`;
  let refusal;
  let pending = false;
  if (!pr) {
    refusal = 'this ticket has no pull request of its own and names none it was filed to unstick, so nothing shows its work is merged';
  } else {
    const prState = String(pr.state || '').trim().toUpperCase();
    if (prState === 'MERGED') {
      return { act: 'move', target: 'Live', why: `your answer says to close it, and ${whose} is merged` };
    }
    if (!prState) {
      return {
        act: 'cannot-tell', target: null,
        why: `${which} could not be read (${pr.why || 'reason unknown'}), so whether its work is merged is unknown — left in Ready to launch`,
      };
    }
    pending = prState === 'OPEN';
    refusal = pending
      ? `${whose} is still open, so its work is not live yet`
      : `${whose} was closed without merging, so its work never landed`;
  }
  const said = latestCloseRefusal(answerReplies);
  if (said === refusal) return { act: 'refused-quiet', target: null, why: `${refusal} (already said)`, pending };
  return { act: 'refuse', target: null, why: refusal, pending };
}

/**
 * THE CONFLICT HAND-OFF: file a catch-up ticket, or is one already on file?
 * (task 86bctbev9).
 *
 * Dane wrote "merge" on PR #12 and PR #13 on 2026-10-27; both conflicted with
 * `main`, and the relay posted a hand-off saying filing the resolution "did
 * not succeed" — when no filing had been attempted at all. Nothing picked
 * either up. The contract says a conflict files a `Queued` ticket for the
 * build loop; this is the decision half of that, conflictWork's rules
 * unchanged.
 *
 * The relay runs every ten minutes and a conflict can last a day, so the one
 * thing this must never do is file twice for one conflict. Two places can
 * show a filing, read in this order:
 *
 *   1. the newest `CONFLICT TICKET FILED: PR #<n>` trail on the waiting
 *      ticket (findConflictTicket) — the record the relay writes after filing;
 *   2. an open ticket in the queue with exactly the name a filing would use —
 *      the case where the ticket was created but the trail comment did not
 *      post, so the next pass records it instead of filing a second one.
 *
 * A filing counts only while a loop still works it (SP-100). On 2026-11-02
 * PR #64's first catch-up ticket SP-90 was built, reviewed and parked in
 * Ready to launch; six minutes later PR #66 merged and #64 conflicted again.
 * The trail was read by PR number alone, so every pass for five hours said
 * "SP-90 already on file" while nothing could ever build it. So the trail's
 * ticket status is an input: in a worked status it is on file; in any other
 * status a new ticket is filed (`refiledFrom` names the old one); and when
 * its status could not be read the answer is `cannot-tell`, never "on file".
 *
 * @param comments    the waiting ticket's comments, newest first
 * @param prNumber    the conflicting PR
 * @param queueTasks  the open tickets in the Loop Queue (the pass's list read)
 * @param ticketName  conflictTicketName(...) for this PR
 * @param localVerdict the local conflict check, or null when none ran
 * @param filedStatus the status of the ticket the newest trail names, or
 *                    null/'' when it could not be read
 * @returns { act: 'none' | 'already-filed' | 'file' | 'cannot-tell', filed, recorded, refiledFrom }
 *          `filed` is { id, url } when one is on file (or, on cannot-tell,
 *          the one that could not be read); `recorded` says whether the
 *          trail comment already names it; `refiledFrom` is { id, url,
 *          status } when an earlier catch-up left the loop's statuses.
 */
function conflictFilingPlan({ comments, prNumber, queueTasks, ticketName, localVerdict, filedStatus }) {
  if (!shouldFileConflictTicket(localVerdict)) return { act: 'none', filed: null, recorded: false, refiledFrom: null };
  const trail = findConflictTicket(comments, prNumber);
  let refiledFrom = null;
  if (trail) {
    const filed = { id: trail.id, url: trail.url };
    const status = statusOf(String(filedStatus || ''));
    if (!status) return { act: 'cannot-tell', filed, recorded: true, refiledFrom: null };
    if (CATCH_UP_WORKED_STATUSES.includes(status)) return { act: 'already-filed', filed, recorded: true, refiledFrom: null };
    refiledFrom = { ...filed, status: DISPLAY[status] || status };
  }
  const twin = (queueTasks || []).find((t) => t && t.name === ticketName
    && CATCH_UP_WORKED_STATUSES.includes(statusOf(t))
    && !(refiledFrom && String(t.id).toLowerCase() === String(refiledFrom.id).toLowerCase()));
  if (twin) return { act: 'already-filed', filed: { id: String(twin.id), url: twin.url }, recorded: false, refiledFrom };
  return { act: 'file', filed: null, recorded: false, refiledFrom };
}

/**
 * One line per ticket, the shape the dry run and the real pass both print,
 * so a reader comparing the two logs sees the same words. `outcome` is the
 * relay's own vocabulary; `detail` is the reason in plain words.
 */
function relayLine({ task, status, outcome, detail }) {
  const name = task && task.name ? ` "${task.name}"` : '';
  const id = task && task.id ? task.id : '?';
  return `${id}\t${status || '?'}\t${outcome}\t${detail}${name}`;
}

module.exports = {
  PR_VIEW_FIELDS,
  NEXT_SLICE_RE,
  markerBookkeeping,
  recordBookkeeping,
  emptyBooks,
  mergeDestination,
  handbackAnswer,
  handbackPlan,
  closePlan,
  CATCH_UP_WORKED_STATUSES,
  conflictFilingPlan,
  relayLine,
};
