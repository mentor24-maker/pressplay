/**
 * The two traces a ticket must carry, and the readers that check them.
 *
 *   PR opened: <url>              written by loop-build (`pr-opened`)
 *   Human-hours estimate: <N>     its optional second line (`--human-hours`, SP-78)
 *   REVIEW: PASSED — <why>        written by loop-review (`verdict --pass`)
 *   REVIEW: sent back to Rework — <why>              (`verdict --fail`)
 *
 * One writer and one reader per shape, in this file, so the text a command
 * writes and the text the gate reads can never drift apart. Adapted from
 * StarCaster's loopTrail.js and mergeOnComment.js.
 */

import { isMachineComment } from './machineComment.mjs';
import { bodyNamesTicket as namesTicket } from '../../lib/clickupTicketLink.js';
import { humanHoursLine } from '../../lib/humanHours.js';

export const ESCALATE_AT_ROUND = 4;

const PR_LINE = /PR opened:\s*(https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+))/i;
const VERDICT_LINE = /^\s*REVIEW:\s*(PASSED|sent back to Rework)\b/i;

export function prOpenedComment(prUrl, extra, { humanHours } = {}) {
  const tail = String(extra || '').trim();
  const hours = humanHours == null ? '' : `\n${humanHoursLine(humanHours)}`;
  return `PR opened: ${prUrl}${hours}${tail ? `\n\n${tail}` : ''}`;
}

export function verdictComment(passed, note) {
  const tail = String(note || '').trim();
  const head = passed ? 'REVIEW: PASSED' : 'REVIEW: sent back to Rework';
  return `${head}${tail ? ` — ${tail}` : ''}`;
}

export function commentsReadable(json) {
  return Array.isArray(json && json.comments);
}

/** Newest first, by ClickUp's millisecond date. */
export function newestFirst(comments) {
  return (comments || []).slice().sort((a, b) => (Number(b && b.date) || 0) - (Number(a && a.date) || 0));
}

/** The newest "PR opened:" line on a ticket, parsed. */
export function findPullRequest(comments) {
  for (const c of newestFirst(comments)) {
    const m = PR_LINE.exec(String((c && c.comment_text) || ''));
    if (m) return { url: m[1], owner: m[2], repo: m[3], number: Number(m[4]), commentId: String(c.id) };
  }
  return null;
}

export function prTrailLanded(comments, prNumber) {
  const found = findPullRequest(comments);
  if (!found) return { ok: false, why: 'no "PR opened: <url>" line is readable on the ticket' };
  if (Number(found.number) !== Number(prNumber)) {
    return { ok: false, why: `the newest "PR opened:" line on the ticket points at PR #${found.number}, not #${prNumber}` };
  }
  return { ok: true, why: '', pr: found };
}

/**
 * Does a PR body link back to its ticket? The ClickUp link (/t/<id> and
 * /t/<workspace>/<id>) or the tracker's own <trackerUrl>/tickets/<id>. One
 * definition, lib/clickupTicketLink.js, which the review gate reads too, so
 * the command that records a PR and the gate that judges it cannot disagree
 * (SP-32). `opts` is `{ tracker, trackerPrefix, trackerUrl }`; omitted, the
 * project config's.
 */
export function bodyNamesTicket(body, taskId, opts) {
  return namesTicket(body, taskId, '', opts);
}

export function isReviewVerdict(text) {
  return VERDICT_LINE.test(String(text || ''));
}

export function isReviewPassed(text) {
  const m = VERDICT_LINE.exec(String(text || ''));
  return Boolean(m && /^passed$/i.test(m[1]));
}

/** Ready to launch is refused unless the NEWEST verdict on the ticket is a PASS. */
export function readyToLaunchGate(comments) {
  const verdict = newestFirst(comments).find((c) => isReviewVerdict(c && c.comment_text));
  if (!verdict) {
    return { ok: false, why: 'no review verdict has been recorded on this ticket — loop-review has not passed it' };
  }
  if (!isReviewPassed(verdict.comment_text)) {
    return { ok: false, why: 'the most recent review verdict on this ticket is not a PASS' };
  }
  return { ok: true, why: '', verdictId: String(verdict.id) };
}

/** How many send-backs the ticket already carries. */
export function sendBackRounds(comments) {
  return (comments || []).filter((c) => isReviewVerdict(c && c.comment_text) && !isReviewPassed(c.comment_text)).length;
}

/** The round number the NEXT send-back would be. */
export function nextRound(comments) {
  return sendBackRounds(comments) + 1;
}

/** Three send-backs mean the spec is wrong, not the build: a fourth goes to Dane. */
export function wouldEscalate(comments) {
  return nextRound(comments) >= ESCALATE_AT_ROUND;
}

/** One line per earlier send-back, for the escalation card. */
export function roundSummaryLines(comments) {
  const sent = newestFirst(comments).filter((c) => isReviewVerdict(c && c.comment_text) && !isReviewPassed(c.comment_text)).reverse();
  return sent.map((c, i) => {
    const text = String(c.comment_text || '').replace(/^\s*REVIEW:\s*sent back to Rework\s*(—|-)?\s*/i, '').split('\n')[0].trim();
    return `round ${i + 1}: ${text || '(no reason recorded)'}`;
  });
}

/**
 * Is the newest comment on the ticket Dane's own word? The loops post under
 * his seat, so authorship alone cannot answer it: a comment carrying the
 * machine marker is a loop's, whatever account posted it.
 */
export function operatorSpokeLast(comments, operatorId) {
  const newest = newestFirst(comments)[0];
  if (!newest) return false;
  if (isMachineComment(newest.comment_text)) return false;
  return String(newest.user && newest.user.id) === String(operatorId);
}
