'use strict';

/**
 * Where the ticket goes once its pull request is merged.
 *
 * `Live` is the answer unless the ticket's description says, on a line of
 * its own, that another slice is still to come:
 *
 *   Next slice: the Needs your input hand-back, once busRelayPlan arrives
 *
 * That line is the ONE convention. "Next slice: none" (or "done") reads as
 * no next slice. A sentence in prose ("the ticket returns to Queued after
 * each slice") is deliberately not read: the relay moves a ticket on a
 * declaration, never on an inference from how a paragraph was worded, and
 * the build pass that narrows a description to one slice is the pass that
 * writes the line (loop-build SKILL.md, "offer named slices").
 *
 * A `Queued` ticket is claimed by the next build pass, so the line is what
 * keeps a sliced ticket moving without anyone dragging it back by hand.
 *
 * TWO READERS, ONE RULE (task 86bcrvwam). The relay's merge path reads this
 * right before it merges, and busRelayPlan's `handbackDestination` reads it
 * when an answered `Needs your input` ticket's last PR is already merged —
 * the state of every multi-slice ticket asked a question between slices.
 * It lives in its own file because relayLane already requires busRelayPlan,
 * so busRelayPlan cannot require relayLane back.
 */
const NEXT_SLICE_RE = /^[ \t]*(?:[-*]\s+)?(?:\*\*)?next slice(?:\*\*)?\s*:\s*(.*?)\s*$/im;
const NO_NEXT_SLICE = new Set(['', 'none', 'done', 'no', 'n/a', '-']);

function mergeDestination(description) {
  const m = NEXT_SLICE_RE.exec(String(description || ''));
  if (!m) return { status: 'Live', why: 'no "Next slice:" line in the description' };
  const rest = String(m[1] || '').replace(/[.!]+$/, '').trim();
  if (NO_NEXT_SLICE.has(rest.toLowerCase())) {
    return { status: 'Live', why: `the description's "Next slice:" line says ${JSON.stringify(rest || 'nothing')}` };
  }
  return { status: 'Queued', why: `the description says more remains — "Next slice: ${rest}"` };
}

module.exports = { NEXT_SLICE_RE, NO_NEXT_SLICE, mergeDestination };
