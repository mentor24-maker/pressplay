'use strict';

/**
 * humanHours — the build loop's estimate of how long a human programmer would
 * have taken over a finished pull request, written once and read once.
 *
 * WHY THIS EXISTS (2026-11-01, SP-78). Dane asked for a report of how many
 * human programmer hours the loops' work equals (SP-74, "Reporting section").
 * Nothing recorded it, so `pr-opened --human-hours <N>` now adds one line to
 * the `PR opened:` comment:
 *
 *   PR opened: https://github.com/<owner>/<repo>/pull/<n>
 *   Human-hours estimate: <N>
 *
 * The writer (`humanHoursLine`) and the reader (`findHumanHours`) live here
 * together so the shape cannot drift. The reader finds the comment through
 * `mergeOnComment.findPullRequest`, the same reader the merge step uses, so
 * "the newest PR opened comment" means the same comment everywhere. A ticket
 * rebuilt onto a second PR counts that PR's estimate, not the first one's.
 */

const { findPullRequest } = require('./mergeOnComment.js');

/** The most hours one pull request may claim; more means the slice was too big. */
const HUMAN_HOURS_MAX = 200;

const LINE_LABEL = 'Human-hours estimate:';
const LINE_RE = /^\s*Human-hours estimate:\s*(\d+(?:\.\d+)?)\s*$/im;

/**
 * Check a `--human-hours` value: a number of hours, whole or half, more than
 * 0 and at most HUMAN_HOURS_MAX. Returns { ok, hours } or { ok: false, why }.
 */
function parseHumanHours(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
    return { ok: false, why: `"${text}" is not a number of hours (use e.g. 6 or 2.5)` };
  }
  const hours = Number(text);
  if (!(hours > 0)) return { ok: false, why: 'the estimate must be more than 0 hours' };
  if (hours > HUMAN_HOURS_MAX) {
    return { ok: false, why: `the estimate must be at most ${HUMAN_HOURS_MAX} hours (a bigger job should have been split)` };
  }
  if (!Number.isInteger(hours * 2)) {
    return { ok: false, why: 'the estimate is in whole or half hours (e.g. 6 or 2.5)' };
  }
  return { ok: true, hours };
}

/** The one line `findHumanHours` reads. */
function humanHoursLine(hours) {
  return `${LINE_LABEL} ${hours}`;
}

/**
 * The estimate recorded on a ticket, or null when there is none: no
 * `PR opened:` comment, or the newest one carries no estimate line.
 */
function findHumanHours(comments) {
  const pr = findPullRequest(comments);
  if (!pr) return null;
  const comment = (comments || []).find((c) => String(c && c.id) === pr.commentId);
  const m = LINE_RE.exec(String((comment && comment.comment_text) || ''));
  if (!m) return null;
  const parsed = parseHumanHours(m[1]);
  return parsed.ok ? parsed.hours : null;
}

module.exports = {
  HUMAN_HOURS_MAX,
  parseHumanHours,
  humanHoursLine,
  findHumanHours,
};
