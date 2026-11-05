'use strict';

/**
 * waitsOn — "this ticket builds on that one", declared once, read by the claim.
 *
 * WHY THIS FILE EXISTS (2026-10-27, task 86bctfun6). The build loop takes the
 * oldest Queued ticket, whatever it builds on. So a plan whose steps depend on
 * each other could only be filed one wave at a time, each wave after the one
 * before had merged, and Dane looked for the tracker plan's tickets in the
 * Loop Queue and found most of them missing. A ticket may now say what it waits
 * on, and the claim leaves it alone until that ticket is closed.
 *
 * The declaration is a line of its own in the description:
 *
 *   Waits on: 86bctbf46
 *   Waits on: https://app.clickup.com/t/86bctbf46, 86bctbw76
 *
 * Any letter case; one or more ticket ids or ticket links, separated by commas;
 * a list marker, quote or bold around the marker is fine (`- **Waits on:** x`).
 * Prose that merely mentions waiting does nothing: a ticket is held back by a
 * declaration, never by how a paragraph was worded (the same rule as
 * `Next slice:` in relayLane.js).
 *
 * A bare id is safe here although clickupTicketLink.js refuses one in a PR
 * body: there the id had to be picked out of free prose, here it sits after a
 * marker that names it. A bare id is also what the tracker that replaces
 * ClickUp will use (docs/TRACKER_MVP.md), so the line works on either.
 *
 * ClickUp's own dependency feature is not used for the same reason.
 */

const LINK = String.raw`https?:\/\/app\.clickup\.com\/t\/(?:\d+\/)?([a-z0-9]+)\/?`;
// A token is one of: a bare id, a link, a link in <angle brackets>, or a
// markdown link `[text](link)`. Anything else on the line is NOT guessed at.
const LINK_TOKEN_RE = new RegExp(String.raw`^(?:<?${LINK}>?|\[[^\]]*\]\(${LINK}\))$`, 'i');
const BARE_ID_RE = /^[a-z0-9][a-z0-9-]*$/i;
// A line of its own, which may sit in a quote (`> `), a list item (`- `,
// `* `, `+ `, `1. `) and/or bold or italic around the marker
// (`**Waits on:**`): loop-spec writes descriptions as bullet lists, and the
// markdown text keeps the bullets.
const WAITS_ON_LINE_RE = /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+[.)])[ \t]+)?[*_]{0,2}waits on:[*_]{0,2}(.*)$/gim;

/**
 * What a description declares it waits on: `ids` (lowercased, in order, no
 * repeats) and `unparsed`, every piece of a `Waits on:` line that is not a
 * ticket id or link. An unparsed piece must hold the ticket back, never be
 * dropped: "Waits on: aaa1 and bbb2" read as "nothing" claims it early.
 */
function readWaitsOn(description) {
  const ids = [];
  const unparsed = [];
  for (const m of String(description || '').matchAll(WAITS_ON_LINE_RE)) {
    const rest = m[1].trim();
    if (!rest.replace(/[`*_.\s]/g, '')) { unparsed.push('(nothing named)'); continue; }
    for (const raw of rest.split(',')) {
      const token = raw.trim().replace(/^[`*_]+|[`*_.]+$/g, '');
      if (!token) continue;
      const link = LINK_TOKEN_RE.exec(token);
      const id = link ? (link[1] || link[2]) : (BARE_ID_RE.test(token) ? token : '');
      if (!id) unparsed.push(token);
      else if (!ids.includes(id.toLowerCase())) ids.push(id.toLowerCase());
    }
  }
  return { ids, unparsed };
}

/** Every ticket a description says it waits on, lowercased, in order, no repeats. */
function waitsOn(description) {
  return readWaitsOn(description).ids;
}

/**
 * The text both `queue --claimable` and `claim` read the line from: the
 * markdown description when the ticket carries one (it keeps bullets, bold
 * and backticks), else the plain one. One source, so the two can never
 * disagree about what a ticket waits on.
 */
function waitsOnText(ticket) {
  return ticket?.markdown_description ?? ticket?.description ?? '';
}

/**
 * Why a ticket is held back, one line per reason, given what is known about
 * each prerequisite: `lookup(id)` returns 'open', 'closed' or 'unreadable'.
 * A prerequisite is held for wherever it lives, in this list or another.
 * `unreadable` is set when any reason is a failed read (claim exits 1 on it).
 */
function holdReasons(ticket, lookup) {
  const { ids, unparsed } = readWaitsOn(waitsOnText(ticket));
  const reasons = unparsed.map((t) => `its Waits on: line names "${t}", which is not a ticket id or link`);
  let unreadable = false;
  for (const id of ids) {
    const state = lookup(id);
    if (state === 'closed') continue;
    if (state === 'open') reasons.push(`waits on ${id} (still open)`);
    else { reasons.push(`waits on ${id} (could not be read)`); unreadable = true; }
  }
  return { reasons, unreadable };
}

module.exports = {
  readWaitsOn,
  waitsOn,
  waitsOnText,
  holdReasons,
};
