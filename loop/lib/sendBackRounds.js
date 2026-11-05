'use strict';

/**
 * sendBackRounds — how many times has this ticket been sent back, and is the
 * loop stuck?
 *
 * WHY THIS EXISTS (2026-08-25, task 86bbmg2tq). Dane, watching a ticket bounce
 * to `Queued` for the third time: "I would think tasks would never go back to
 * queue except for situations involving dependencies or time delays."
 *
 * He was pointing at a real modelling problem. `Queued` holds two different
 * things — work nobody has started, and work that was built, reviewed, and
 * handed back with notes — and from the board they are identical. That
 * conflation is not cosmetic: it DEADLOCKED the build loop the same day
 * (86bbm4zwd), because the WIP cap counts open PRs and three of those PRs
 * belonged to tickets sitting in `Queued` for rework, so the cap was blocking
 * the only thing that could close them.
 *
 * He chose the lighter of two fixes: carry the distinction in the Loop note,
 * NOT in a new ClickUp status. (Statuses live on the list, and that dialog has
 * burned this project before.) So:
 *
 *   1. A send-back's Loop note says which round it is and why, in one clause:
 *      `↩ round 3 — three docs now contradict the change (12:28pm)`
 *   2. On what would be round 4, the review pass escalates to Dane instead of
 *      sending back again. Three rounds means the SPEC was wrong, not the
 *      builder; a fourth pass at the same ticket is the system failing to
 *      notice it is stuck. Ticket 86bbk2fuh proved it — it asked to change one
 *      number, turned out to touch four other records, and every round found
 *      something genuinely new.
 *
 * The round is DERIVED, never stored: counted from the verdict comments the
 * loop already writes. No new state means no new state to fall out of sync
 * (the same reasoning as loopTrail — one shape, one writer, one reader).
 */

const { isReviewVerdict, isReviewPassed } = require('./mergeOnComment.js');

/**
 * The round at which the loop stops sending back and asks Dane instead.
 * Four, not three: two rounds is ordinary and healthy — this week's send-backs
 * caught a tenancy hole and an inverted safety property, and escalating those
 * would have spent his attention on work the loop was handling correctly.
 */
const ESCALATE_AT_ROUND = 4;

/**
 * Is this comment a send-back?
 *
 * Defined as "a review verdict that is not a PASS" rather than by matching the
 * send-back wording directly, so this can never drift from the two shapes
 * mergeOnComment already arbitrates. There are exactly two verdicts a loop
 * writes (loopTrail.verdictComment): `REVIEW: PASSED` and
 * `REVIEW: sent back to Rework` (`…to Queued` before 2026-08-31, task
 * 86bbr1u9v — the wording changed with the status, and neither reader parses
 * the destination, so the older rounds still count). Anything else that calls
 * itself a REVIEW verdict and is not a pass is, for counting purposes, a round
 * the ticket did not survive — which is the honest reading.
 */
function isSendBack(text) {
  return isReviewVerdict(text) && !isReviewPassed(text);
}

/** ClickUp's date fields arrive as strings; missing dates sort oldest. */
function commentDate(c) {
  return Number((c && c.date) || 0);
}

/**
 * The reason clause out of a send-back verdict, as the review pass wrote it.
 *
 * `verdictComment(false, note)` renders `REVIEW: sent back to Rework — <note>`
 * and the note may run to several lines (it is read from a body file). Only
 * the first line is a reason; the rest is the detail that belongs in the
 * ticket, not on a one-line board column.
 */
function reasonOf(text) {
  const firstLine = String(text || '').split('\n').find((l) => l.trim()) || '';
  const dash = firstLine.indexOf('—');
  const tail = dash >= 0 ? firstLine.slice(dash + 1) : '';
  return tail.trim().replace(/\s+/g, ' ');
}

/**
 * Every send-back on this ticket, oldest first, each stamped with the round it
 * was. Oldest-first because round 1 is the first thing that happened, and a
 * caller summarising the history for Dane reads it in that order.
 */
function sendBacks(comments) {
  return (comments || [])
    .filter((c) => isSendBack(c && c.comment_text))
    .sort((a, b) => commentDate(a) - commentDate(b))
    .map((c, i) => ({
      round: i + 1,
      id: String(c.id ?? ''),
      date: commentDate(c),
      reason: reasonOf(c.comment_text),
      text: String(c.comment_text || ''),
    }));
}

/** How many send-backs are already recorded on this ticket. */
function priorSendBackCount(comments) {
  return sendBacks(comments).length;
}

/**
 * The round a send-back written RIGHT NOW would be. Prior send-backs + 1, so a
 * ticket that has never been sent back is round 1 — never round 0, and never a
 * marker on a ticket that has not been sent back at all.
 */
function nextRound(comments) {
  return priorSendBackCount(comments) + 1;
}

/**
 * The round of the send-back most recently recorded — for the caller stamping
 * the Loop note AFTER the verdict has been written, which is the order the
 * review pass runs in (verdict, then status, then note). Zero means no
 * send-back is on the ticket yet, which is a broken trail, not a round.
 */
function currentRound(comments) {
  return priorSendBackCount(comments);
}

/**
 * Would sending back again mean asking Dane instead? True from round 4 on.
 * `>=`, not `===`: an override or a hand-written verdict must not let a ticket
 * slip PAST the threshold and be quietly un-guarded from then on.
 */
function wouldEscalate(comments) {
  return nextRound(comments) >= ESCALATE_AT_ROUND;
}

/**
 * The history, one line per round, for the escalation card.
 *
 * Criterion 4 of the ticket, verbatim: "A card that says 'this has failed three
 * times' without saying what they were is not actionable." So each line names
 * what that round found. A round whose verdict carried no reason says so out
 * loud rather than rendering an empty bullet.
 */
function roundSummaryLines(comments) {
  return sendBacks(comments).map(
    (s) => `Round ${s.round}: ${s.reason || '(the verdict recorded no reason)'}`
  );
}

/**
 * How long a Loop note may be. ClickUp's short-text custom field takes 255
 * characters; a longer value is refused by the API, and the stamp verifies by
 * read-back, so an over-long note fails the pass rather than silently
 * truncating. Kept here beside the composer that has to respect it.
 */
const LOOP_NOTE_MAX = 255;

/**
 * Fit a reason into whatever room is left, and say so with an ellipsis.
 * The ROUND is never what gets cut — it is the part that carries the meaning
 * ("this is the third time"), and the reason is the part a reader can go get
 * in full from the ticket.
 */
function truncateReason(reason, room) {
  const text = String(reason || '').trim().replace(/\s+/g, ' ');
  if (room <= 0) return '';
  if (text.length <= room) return text;
  if (room <= 1) return '…';
  return `${text.slice(0, room - 1).trimEnd()}…`;
}

module.exports = {
  ESCALATE_AT_ROUND,
  LOOP_NOTE_MAX,
  isSendBack,
  reasonOf,
  sendBacks,
  priorSendBackCount,
  nextRound,
  currentRound,
  wouldEscalate,
  roundSummaryLines,
  truncateReason,
};
