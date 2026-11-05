'use strict';

const { operatorName } = require('./substrateConfig.js');

const { BANNER_LABEL } = require('./operatorCard.js');
const { normalizeCommand } = require('./mergeOnComment');
const { FALLBACK_TASK_NAME } = require('./busFallback.js');
const { mergeDestination } = require('./nextSlice.js');

/**
 * bus-relay's decision table: which lists it watches, and what a fresh
 * operator comment DOES on each one. Pulled out of clickup_direct.mjs so the
 * rules are testable without a network.
 *
 * COMMENT-DRIVEN HANDBACK (2026-08-19, task 86bbh9g7k). Before this, a
 * comment from the operator on a "Needs your input" Loop Queue ticket
 * changed nothing: the relay only watched the Agent Response list, and even
 * where it watched, it only *notified* — no status moved, so no loop ever
 * picked the answer up. Both halves bit on 2026-08-19: two answered tickets
 * sat parked for hours until a human session went looking.
 *
 * The doctrine rule "no loop ever takes a ticket out of Needs your input"
 * still holds — that rule exists so a loop cannot quietly reclaim its OWN
 * escalation. Here the trigger is a fresh comment from the operator himself:
 * the comment is the release, the relay is his hands. No fresh comment, no
 * move — handbackTarget() below is that rule in code.
 */

/**
 * The standing watch list. Ids come in as parameters (they live in env /
 * constants at the call site) so this table stays a pure description.
 *
 * ORDER IS LOAD-BEARING, AND THE MERGE-CAPABLE LIST GOES FIRST (2026-09-03,
 * task 86bbugakw). The relay spends one request per open ticket to read its
 * comments, and ClickUp allows ~100 per minute across the whole company's
 * token. Agent Response held 92 open tickets and is never drained, so with it
 * first the allowance was gone before the sweep reached the Loop Queue — the
 * only list carrying `merge: true`.
 *
 * The relay then failed every 10-minute pass for SIXTEEN HOURS: `requests this
 * pass: 97`, then `100`, then HTTP 429. Merge-on-comment was dead the whole
 * time (Dane commented `merge` on 86bbjt1b4 at 11:17am and nothing acted on
 * it), Lane A halted fail-safe on every pass, and with nothing merging the WIP
 * cap filled and the build loop declined every pass saying "the merge side is
 * the bottleneck". Open work went 38 -> 63 in seven days with every gate green.
 *
 * Reordering does not FIX the budget — the incremental scan (86bbugbay), the
 * 429 retry (86bbugbym) and the shared budget (86bbugcdb) do that. It makes the
 * failure land on the list that can afford it: a notify-only sweep that stops
 * short delays a bus message, where a merge sweep that stops short strands
 * shipped work behind an unread comment. Those are not the same cost, so when
 * the budget runs out it should run out on Agent Response.
 */
function defaultWatches({ agentResponseList, loopQueueList }) {
  // Loop Queue FIRST — see the note above. `mergeEnabled` is the property that
  // matters, not the label: whichever watch can merge must not be last.
  return [
    {
      list: loopQueueList,
      label: 'Loop Queue',
      statuses: ['needs your input', 'ready to launch'],
      // An answer on "needs your input" returns the ticket to the machine.
      // "ready to launch" is deliberately absent from the handback table:
      // that status waits on a MERGE, not a reply, so no comment moves it
      // by handback. Since 2026-08-21 (task 86bbjd5nn) a comment there CAN
      // still end the wait — but only by being an explicit merge command
      // from the operator himself, and only through the merge path below,
      // which checks the PR is open, reviewed and green first.
      handback: { 'needs your input': 'Queued' },
      merge: true,
    },
    {
      list: agentResponseList,
      label: 'Agent Response',
      statuses: ['pending response', 'responding'],
      // Notify-only, as it has been since PR #340.
      handback: {},
      merge: false,
    },
  ];
}

/**
 * WAS THIS PASS COMPLETE, AND IF NOT, WHICH LIST DID IT NOT FINISH?
 * (2026-09-03, task 86bbugdv9.)
 *
 * The relay already reported what it could not check — but it reported it as
 * TICKETS, and that is the wrong unit. On 2026-09-03 a pass that had entirely
 * failed to sweep the merge-capable list printed this:
 *
 *     bus-relay: 0 relayed, 0 handed back, 0 merged, ... 3 could not be checked.
 *     Could not fully verify:
 *       - 86bbjt1b4 (Panel sweep 8/15...): could not read comments
 *
 * Three ticket ids read as three minor gaps. The truth was "the merge lane did
 * not run", and one of those three ids was carrying Dane's own `merge` command,
 * described as an unread comment rather than as an unperformed merge. The pass
 * happened sixteen hours in a row and nobody could tell from its own output.
 *
 * The precedent is `npm run throughput`, which gives one of four verdicts and
 * never two, and says UNKNOWN when it could not take a reading. CLAUDE.md
 * states the rule it embodies: "alive but useless" never renders as healthy,
 * and neither does "could not tell". This is that rule at LIST granularity.
 *
 * Pure, so a test can reach every branch without a network.
 *
 * `sweeps` is one entry per watch: { label, merge, complete, why }.
 */
function sweepVerdict(sweeps) {
  const list = Array.isArray(sweeps) ? sweeps : [];
  if (!list.length) {
    // No sweep at all is not a clean pass. It is the absence of evidence, and
    // the whole point of this function is that those must not look alike.
    return {
      complete: false,
      mergeLaneRan: false,
      exitCode: 1,
      line: 'INCOMPLETE — no list was swept at all, so nothing can be concluded about either one.',
    };
  }
  const unfinished = list.filter((s) => !s.complete);
  const mergeSweep = list.find((s) => s.merge);
  const mergeLaneRan = Boolean(mergeSweep && mergeSweep.complete);

  if (!unfinished.length) {
    return {
      complete: true,
      mergeLaneRan,
      exitCode: 0,
      line: `COMPLETE — swept ${list.length} list(s) in full: ${list.map((s) => s.label).join(', ')}.`,
    };
  }

  const named = unfinished
    .map((s) => `${s.label}${s.merge ? ' (the merge-capable list)' : ''}${s.why ? ` — ${s.why}` : ''}`)
    .join('; ');

  // The merge-capable list gets its own sentence, in the words that say what it
  // COSTS rather than what failed. "Could not read comments" is a mechanism; a
  // merge command going unread is the consequence, and the consequence is the
  // thing a reader needs at 2am.
  const mergeWarning = unfinished.some((s) => s.merge)
    ? ' Merge commands on that list were NOT read this pass, so an authorization may be sitting unacted on.'
    : '';

  return {
    complete: false,
    mergeLaneRan,
    exitCode: 1,
    line: `INCOMPLETE — did not finish ${named}.${mergeWarning}`,
  };
}

/**
 * The comments on a ticket that are ACTUALLY the operator's word.
 *
 * Two conditions, and the second one is not optional (task 86bbqx2xe). The
 * loops post under Dane's own API token, so a card a machine wrote comes back
 * from ClickUp carrying HIS user id. Filtering on the id alone, which is what
 * this did until 2026-09-01, meant the relay read its own `ask` card as a
 * fresh answer from him: it relayed the card to the bus as "Dane replied" and
 * handed the ticket out of `Needs your input` ten minutes after it had been
 * escalated to him.
 *
 * A comment whose text could not be read is NOT counted as his. An unread
 * comment is an unknown, and the one thing it must never do is release an
 * escalation on the strength of something nobody looked at.
 */
function operatorComments(comments, { operatorId, isMachine } = {}) {
  if (!Array.isArray(comments)) return [];
  const machine = typeof isMachine === 'function' ? isMachine : () => false;
  return comments.filter((c) => {
    if (Number(c?.user?.id) !== Number(operatorId)) return false;
    return !machine(c.comment_text);
  });
}

/**
 * THE ESCALATION CARD — the comment that IS the question.
 *
 * `ask` is the only way a ticket reaches `Needs your input` (a bare `status`
 * move refuses on its own), and every card it writes ends in the banner
 * `operatorCard.js` draws. That banner is therefore the one durable mark on a
 * ticket saying "the machine asked something here", which is what lets a later
 * pass order the trail: anything of Dane's AFTER the newest card is an answer
 * to it, and anything before it belonged to an earlier round.
 *
 * Matched on the label with its trailing space trimmed off, because the label
 * is drawn with one and a round trip through ClickUp is not guaranteed to keep
 * it. The `#` rule around it is deliberately NOT part of the test: ClickUp
 * escapes markdown punctuation on the way back out, so a rule can return as
 * `\#\#\#...` and a matcher reading it would fail on exactly the tickets it
 * was written for.
 *
 * THIS IS THE BANNER TEST AND NOTHING ELSE — authorship is a SEPARATE question
 * and the caller owes it (2026-09-07, round 1 review). The banner is just text,
 * so a comment of Dane's that QUOTES the card above his reply matched here, and
 * the quote is newer than the card it quotes. `answerAwaitingHandback` then
 * anchored the question on HIS OWN comment, found nothing of his after it, and
 * returned `none`: the relay handed nothing back — a regression against the old
 * fresh-only rule, which would have moved it — while `lib/staleAnswer.js` filed
 * the same ticket as healthy. Stranded, with the watchdog saying all-clear.
 *
 * So `answerAwaitingHandback` requires a card to be MACHINE-WRITTEN, through
 * the same `isMachine` predicate it filters his answers with. One predicate,
 * asked once, which makes the two sets disjoint by construction: a comment can
 * never be both the question and the answer to it.
 */
const ESCALATION_BANNER = BANNER_LABEL.trim();

function isEscalationCard(text) {
  if (text == null) return false;
  return String(text).includes(ESCALATION_BANNER);
}

/**
 * THE HOLD — "Dane is working this ticket by hand; do not put it back in the
 * queue" (2026-10-03, task 86bccgp8q).
 *
 * The MaxOne erase ticket (86bbvr0zf) was parked in `Needs your input` while
 * he drove it from his own fast-track session, and the relay handed it back to
 * `Queued` on every comment he left there — "Done(?)" mid-task at 11:34am, then
 * his answer to the very card that said "leave it here" at 1:51pm. A build pass
 * claimed it at 11:57am, four minutes after his session started scanning the
 * drive. Nothing on the trail could say "held by hand", so this is that thing:
 * a machine comment (`ask --hand-held`, or `hold-by-hand` on its own), matched
 * on its FIRST line and honoured only when machine-written, so Dane quoting it
 * is never a hold.
 */
const HAND_HELD_MARKER = 'HELD BY HAND —';

function handHeldText({ at, by } = {}) {
  return `${HAND_HELD_MARKER} ${operatorName()} is working this ticket in his own session${by ? ` (${by})` : ''}.\n\n`
    + 'The bus relay still passes his comments on, but it will NOT put this ticket back in the queue. '
    + 'He, or the session he is driving, moves it when the work is done. '
    + 'A newer question card from a loop ends the hold.'
    + `${at ? `\n\n(held at ${at})` : ''}`;
}

function isHandHeldMarker(text) {
  if (text == null) return false;
  const first = String(text).split('\n').map((l) => l.trim()).find(Boolean) || '';
  return first.replace(/\\/g, '').startsWith(HAND_HELD_MARKER);
}

/** Epoch ms of a ClickUp comment, or 0 when it has no usable date. */
function commentAt(comment) {
  const at = Number(comment && comment.date);
  return Number.isFinite(at) && at > 0 ? at : 0;
}

/**
 * IS AN ANSWER FROM DANE SITTING ON THIS TICKET WITH NOTHING HAVING MOVED?
 *
 * WHY THIS EXISTS (2026-09-06, task 86bbvr4w3). The hand-back used to fire on
 * ONE trigger and one only: a comment relayed to the party line *during this
 * pass*. That trigger is not repeatable. Relaying writes a permanent dedup
 * marker, so every later pass reads the comment as already relayed, computes
 * `fresh = 0`, and hands nothing back — for ever.
 *
 * On 2026-09-06 the 09:46 pass relayed Dane's answer on 86bbv8nvy, ran out of
 * ClickUp request budget between the relay and the move, and reported the
 * failure honestly into a bus post that the same rate limit then skipped. The
 * ticket was stranded in `Needs your input` permanently: the only event that
 * could release it had already happened and could never happen again. He found
 * it himself three and a half hours later.
 *
 * So the trigger moves from "what happened in this pass" to "what is true of
 * the ticket" — state that is re-derivable on every later pass, which is the
 * whole of the fix. Two facts, both read off the trail:
 *
 *   1. The newest escalation card is the QUESTION. Dane's newest comment after
 *      it is the ANSWER. Nothing before the card can release the ticket,
 *      which is what stops an answer from an earlier round releasing a fresh
 *      escalation if a marker write is ever lost.
 *   2. That answer must have been DELIVERED — relayed to the party line, or
 *      receipted on the ticket. That gate is unchanged and not weakened: a
 *      ticket must never move on an answer nobody ever got. What changes is
 *      that "delivered" is now read from the durable marker as well as from
 *      this pass's own success.
 *
 * NO CARD MEANS NO ANSWER TO THE QUESTION — `no-question`, never `answered`.
 * A ticket parked by hand, or one whose card has fallen off the newest page of
 * comments, gives no way to tell an answer from something he said last week,
 * and handing such a ticket back on the strength of an old comment is a worse
 * failure than the one being fixed. The caller keeps the old fresh-only
 * behaviour there, and `lib/staleAnswer.js` reports it as CANNOT TELL.
 *
 * @param comments   the ticket's comments (one page is enough — the card and
 *                   the answer are both recent by construction)
 * @param operatorId Dane's ClickUp user id
 * @param isMachine  (text) => boolean, so a machine card under his token is
 *                   never mistaken for his word (see operatorComments)
 * @param delivered  optional (comment) => boolean. Omit it to ask only
 *                   "has he answered?", which is what the report needs.
 * @param handled    optional (comment) => boolean: does this answer already
 *                   carry the marker a COMPLETED hand-back writes? An answer
 *                   that does is spent, so a ticket re-parked by hand is left
 *                   where he put it.
 * @returns { state, answer, answerAt, questionAt, delivered }
 *          state: 'answered' | 'handled' | 'hand-held' | 'none' | 'no-question'
 *          delivered: true/false, or null when no test was supplied
 */
function answerAwaitingHandback({ comments, operatorId, isMachine, delivered, handled } = {}) {
  const all = Array.isArray(comments) ? comments : [];
  // A card must be MACHINE-WRITTEN as well as carry the banner — the same
  // predicate `operatorComments` filters his answers with, so no comment can
  // be both the question and an answer to it. Without `isMachine` nothing can
  // be a card at all, which falls through to `no-question`: the old fresh-only
  // rule at the relay and CANNOT TELL in the report, both safe.
  const machine = typeof isMachine === 'function' ? isMachine : () => false;
  const questionAt = all
    .filter((c) => isEscalationCard(c && c.comment_text) && machine(c && c.comment_text))
    .reduce((newest, c) => Math.max(newest, commentAt(c)), 0);

  const answers = operatorComments(all, { operatorId, isMachine })
    .filter((c) => commentAt(c) > questionAt);

  // HELD BY HAND (2026-10-03, task 86bccgp8q). A hold marker newer than the
  // newest card says Dane is working this ticket in his own session, so an
  // answer to the card is a step in HIS work, not a release to the loops. His
  // words are still relayed; only the move is withheld. Scoped to the card it
  // follows: a later ordinary `ask` posts a newer card and the hold lapses.
  //
  // Read BEFORE the no-card return (round-1 review): a ticket parked by hand
  // with `status --no-card` carries no card at all, and it is the hold's main
  // customer. Checked after, the hold was ignored there and the relay fell
  // back to its fresh-comment rule — re-queuing on his next word while
  // `hold-by-hand` had just printed that it would not.
  const heldAt = all
    .filter((c) => isHandHeldMarker(c && c.comment_text) && machine(c && c.comment_text))
    .reduce((newest, c) => Math.max(newest, commentAt(c)), 0);
  if (heldAt && heldAt >= questionAt) {
    const answer = answers.length
      ? answers.reduce((newest, c) => (commentAt(c) > commentAt(newest) ? c : newest))
      : null;
    return { state: 'hand-held', answer, answerAt: answer ? commentAt(answer) : 0, questionAt, delivered: null };
  }

  if (!questionAt) {
    return { state: 'no-question', answer: null, answerAt: 0, questionAt: 0, delivered: null };
  }

  if (!answers.length) {
    return { state: 'none', answer: null, answerAt: 0, questionAt, delivered: null };
  }

  // His NEWEST word after the question. Newest rather than oldest because the
  // hand-back is a move made on the strength of what he last said: releasing
  // the ticket while his most recent sentence had reached nobody is the very
  // thing the delivery gate exists to prevent.
  const answer = answers.reduce((newest, c) => (commentAt(c) > commentAt(newest) ? c : newest));
  // ALREADY ACTED ON, so this ticket is parked on purpose (2026-09-07, round 1
  // review). The authorization above is a property of the ticket with no memory
  // of the move ever having been made, so a ticket answered, released, and then
  // re-parked in `Needs your input` BY HAND still satisfies "delivered answer
  // newer than the newest card" — and the relay would move it straight back out
  // and strip his assignment inside ten minutes. The old fresh-only rule left
  // such a ticket alone, and `Needs your input` is a status only Dane may be
  // taken out of, on the strength of a comment he wrote FOR IT.
  //
  // So a completed hand-back writes its own durable marker on the answer, and
  // an answer carrying one is spent: `handled`, never `answered`. If that write
  // fails the behaviour degrades to exactly what it was before this paragraph —
  // it can cost a re-release, never a stranding.
  if (typeof handled === 'function' && handled(answer)) {
    return { state: 'handled', answer, answerAt: commentAt(answer), questionAt, delivered: null };
  }
  return {
    state: 'answered',
    answer,
    answerAt: commentAt(answer),
    questionAt,
    delivered: typeof delivered === 'function' ? Boolean(delivered(answer)) : null,
  };
}

/**
 * May the receipt for THIS relayed comment name a hand-back destination?
 *
 * WHY (2026-10-03, task 86bccgp8q). The receipt used to name the watch's
 * target for every fresh comment it relayed, before anything had decided
 * whether that comment releases the ticket. At 10:37am an unstamped sweep note
 * posted BEFORE the card was relayed as Dane's, and its receipt said "This
 * ticket is being returned to Queued" — a move `answerAwaitingHandback` then
 * correctly declined. The trail claimed a re-queue that never happened.
 *
 * So the receipt names the move only when this comment is the one that makes
 * it: the answer to the newest card, or — with no card on the trail — any
 * fresh comment, which is the old rule the hand-back still applies there.
 * Otherwise null, and the note says nothing about where the ticket goes.
 *
 * @param verdict   answerAwaitingHandback()'s result for the ticket
 * @param commentId the comment being relayed
 * @param target    where the watch would move the ticket
 */
function receiptTargetFor({ verdict, commentId, target } = {}) {
  if (!target || !verdict) return null;
  if (verdict.state === 'no-question') return target;
  if (verdict.state === 'answered' && verdict.answer && String(verdict.answer.id) === String(commentId)) return target;
  return null;
}

/** Where a task should be moved once its operator answer has been delivered —
 *  or null for "do not touch it".
 *
 *  `authorized` used to be the count of comments relayed THIS RUN, which made
 *  the move a one-shot event that a crash could destroy for good (see
 *  `answerAwaitingHandback` for the incident). It is now a durable verdict:
 *  "there is a delivered answer to the newest question, and the ticket is
 *  still parked". Falsy means do nothing, exactly as before — the doctrine
 *  checkpoint that no loop takes a ticket out of `Needs your input` without
 *  his word is unchanged; only its evidence is now re-readable. */
function handbackTarget(watch, taskStatus, authorized) {
  if (!authorized) return null;
  const byStatus = watch.handback || {};
  return byStatus[String(taskStatus || '').toLowerCase()] || null;
}

/**
 * AN ANSWER THAT SAYS "CLOSE IT" (2026-09-14, task 86bc08xx5).
 *
 * The `needs your input` watch released every answered ticket to `Queued`
 * without reading the answer. On 2026-09-14 ticket 86bbwmumk was already fixed
 * on main; a build pass escalated "NEEDED FROM DANE: Close this ticket", he
 * answered "close it", and the relay put it back at the top of the claim line —
 * where the next build pass claimed it again and spent a whole pass
 * re-verifying a fix to close it by hand.
 *
 * NARROW ON PURPOSE. Getting this wrong in the generous direction closes a
 * ticket he meant to keep open; getting it wrong in the narrow direction is
 * today's behaviour, merely wasteful. So the WHOLE answer, once the editor's
 * formatting and trailing punctuation are stripped (the same normalizeCommand
 * `merge` uses), must be one of these — never a sentence that contains one.
 *
 * Deliberately NOT here: "done" and "nothing to do". Both are what he writes
 * after doing the thing a card asked HIM to do ("ran the SQL — done"), which
 * means carry on, not close.
 */
const CLOSE_PHRASES = [
  'close',
  'close it',
  'close this',
  'close this ticket',
  'close the ticket',
  'close it please',
  'please close it',
  'please close',
  'yes close it',
  'yes, close it',
  'ok close it',
  'ok, close it',
  'closed',
];

/**
 * THE WORD AN INTAKE CARD ASKS FOR (2026-11-02, SP-86).
 *
 * Every card loop-intake posts says reply "go" to queue the spec as written.
 * Any reply to an intake card already queues it (the hand-back above), so
 * this is not a command the relay matches; it is the one word the ticket
 * page's Go button posts, kept here beside the close words so the page never
 * spells it.
 */
const GO_PHRASE = 'go';

function isCloseCommand(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  return CLOSE_PHRASES.includes(normalizeCommand(text));
}

/**
 * WHERE an answered ticket GOES — read off the ticket, not off a flat map.
 * (2026-09-08, task 86bbw596q.)
 *
 * `handbackTarget` above answers "may this watch release this status at all,
 * and where does a ticket with nothing built behind it go" — that is the
 * doctrine checkpoint and the ordinary case, and neither changes here. What it
 * could not answer is where a ticket whose work is ALREADY BUILT goes, because
 * it reads nothing about the ticket: every answered `Needs your input` ticket
 * went to `Queued`, unconditionally.
 *
 * `Queued` is a status `loop-build` claims from. So on 2026-09-07 ticket
 * 86bbw4dch — merged as PR #650, its last step a SQL file for Dane to run —
 * was answered ("Success. No rows returned"), handed back to `Queued`, and sat
 * there as claimable work with its pull request already merged and its branch
 * already deleted. An operator session caught it in minutes. Unwatched, a build
 * pass claims it, `build-start` finds a PR trail for a branch GitHub deleted at
 * merge, and the pass is in undefined territory having already moved live work
 * to `Building`. The claim itself cannot catch this — it guards on status,
 * which is exactly what makes it atomic.
 *
 * The repo already held the same judgement in another voice:
 * `npm run clickup -- migrate-rework` exists to move tickets that are `Queued`
 * WITH AN OPEN PR into `Rework`, because a queued ticket with a branch behind it
 * is a ticket a build pass will misread. A merged PR is further along still and
 * was landing in the same wrong place.
 *
 * `pr` is this ticket's own `PR opened:` trail, already resolved by the caller:
 *
 *   null / undefined        no trail — nothing was ever built. `Queued`, as before.
 *   { state: 'MERGED' }     the work is live. `Live`, which is where the relay's
 *                           own merge path already puts a merged ticket — and by
 *                           that path's own rule (`mergeDestination`), so a
 *                           description whose "Next slice:" line names more
 *                           work goes to `Queued` instead. A multi-slice
 *                           ticket's last PR is always the previous slice's,
 *                           already merged, so without this any question asked
 *                           between slices closed the ticket (2026-10-26,
 *                           86bcgmnpy, task 86bcrvwam).
 *   { state: 'OPEN' }       the branch behind it IS the work. `Rework` — the
 *                           status `migrate-rework` already says this belongs in.
 *   { state: 'CLOSED' }     abandoned without merging; GitHub deleted the branch,
 *                           so there is nothing to continue. `Queued`, to rebuild.
 *   { state: '' , why }     the state could NOT be read. Act 'cannot-tell': the
 *                           ticket is left exactly where it is and the caller
 *                           reports it, because "could not check" must never
 *                           read as "clear" (DOCTRINE 3.11) and the wrong guess
 *                           here is the very bug this function exists to stop.
 *
 * `description` is the ticket's description (markdown or plain). Read only
 * when the PR is merged; absent, it reads as "no Next slice: line".
 *
 * Returns `{ act, target, why }`. `act` is 'move' (target is set), 'skip'
 * (this watch does not release this status, or nothing authorized it) or
 * 'cannot-tell' (a reading failed — say so, move nothing).
 */
function handbackDestination(watch, taskStatus, authorized, pr, answerText, description) {
  const unbuilt = handbackTarget(watch, taskStatus, authorized);
  if (!unbuilt) return { act: 'skip', target: null, why: '' };
  // His answer, read BEFORE the trail: "close it" is an instruction about the
  // ticket, and the trail only answers where unfinished work belongs.
  if (isCloseCommand(answerText)) {
    const open = pr && String(pr.state || '').trim().toUpperCase() === 'OPEN';
    return {
      act: 'move',
      target: 'Live',
      why: open
        ? `your answer says to close it — note PR #${pr.number || '?'} is still open and was not touched`
        : 'your answer says to close it',
    };
  }
  if (!pr) {
    return {
      act: 'move',
      target: unbuilt,
      why: 'nothing has been built for this ticket (no "PR opened:" line on it)',
    };
  }
  const which = pr.number ? `PR #${pr.number}` : 'its pull request';
  const state = String(pr.state || '').trim().toUpperCase();
  if (state === 'MERGED') {
    const next = mergeDestination(description);
    if (next.status !== 'Live') {
      return { act: 'move', target: next.status, why: `${which} is already merged, but ${next.why}` };
    }
    return { act: 'move', target: 'Live', why: `${which} is already merged — this work is live` };
  }
  if (state === 'OPEN') {
    return { act: 'move', target: 'Rework', why: `${which} is still open — the branch behind it is the work` };
  }
  if (state === 'CLOSED') {
    return {
      act: 'move',
      target: unbuilt,
      why: `${which} was closed without merging — there is nothing to continue`,
    };
  }
  return {
    act: 'cannot-tell',
    target: null,
    why: `${which} is on this ticket's trail but its state could not be read`
      + ` (${pr.why || 'reason unknown'}), so where this ticket belongs is unknown`
      + ` — it is left in "${taskStatus}" rather than risking a build loop claiming merged work`,
  };
}

/**
 * THE FAILED HAND-BACK, WRITTEN WHERE THE NEXT PASS CAN SEE IT.
 *
 * The retry above does not depend on this note — it is derived from the trail,
 * which is the point of criterion 4: a bus post that the rate limit swallows
 * must not be the only record. This is the evidence half. A reader landing on
 * the ticket cold sees why it did not move and when, rather than an answer
 * followed by silence.
 *
 * Deliberately NOT prefixed `[bus-relay]`: that exact prefix is the dedup
 * marker the relay reads as "this comment was already relayed", and a note
 * that accidentally claimed delivery would drop a real bus message for good.
 * `[bus-relay-handback]` shares the family the machine-comment tag matches
 * and none of the prefix the dedup check reads.
 */
const HANDBACK_FAILURE_MARKER = '[bus-relay-handback]';

/**
 * THE COMPLETED HAND-BACK, WRITTEN WHERE THE NEXT PASS CAN SEE IT.
 *
 * The other half of the failure note above, and the reason both exist: this
 * whole fix decides what to do from the TICKET's trail, so anything the trail
 * cannot say is a thing no later pass can know. "The move already happened" is
 * one of those, and without it a hand-parked ticket is dragged back out of
 * `Needs your input` within ten minutes (see `answerAwaitingHandback`).
 *
 * `[bus-relay-handback-done]`, distinct from BOTH neighbours by construction:
 * it does not start with `[bus-relay]`, the dedup prefix that would falsely
 * claim delivery and drop a real bus message, and it does not start with
 * `[bus-relay-handback]` either — the failure marker ends in `]` where this
 * one carries `-done`, so `startsWith` tells them apart and a completed move
 * can never read as a failed one.
 */
const HANDBACK_DONE_MARKER = '[bus-relay-handback-done]';

function handbackDoneText({ target, at } = {}) {
  // A close is not a hand-back to the machines, and saying it was would be the
  // receipt lying about the one thing he asked for (task 86bc08xx5).
  const what = String(target || '').toLowerCase() === 'live'
    ? `Your answer was delivered and this ticket was closed (moved to "${target}"), as you asked.\n\n`
    : `Your answer was delivered and this ticket was returned to "${target}", so it is back with the machines.\n\n`;
  return `${HANDBACK_DONE_MARKER} ${what}`
    + 'This note is what stops a later pass acting on the same answer twice — park the ticket here '
    + `again and it will be left where you put it.${at ? ` (Automatic — bus-relay, ${at}.)` : ''}`;
}

/**
 * THE THREE THINGS A REPLY THREAD CAN SAY, read in ONE place.
 *
 * The relay reads these off replies it already has in hand; `stale_answer.mjs`
 * reads them off a fetch of its own. Two `startsWith` calls written twice are
 * two definitions that drift silently in the direction of "nothing found",
 * which reads as healthy — so they live here and both callers ask.
 */
function repliesSay(replies, marker) {
  return (Array.isArray(replies) ? replies : [])
    .some((r) => String((r && r.comment_text) || '').startsWith(marker));
}

/** Was the comment this thread hangs off relayed to the party line? */
const repliesShowRelayed = (replies) => repliesSay(replies, BUS_RELAY_MARKER);

/** Did a hand-back on this answer already COMPLETE? */
const repliesShowHandbackDone = (replies) => repliesSay(replies, HANDBACK_DONE_MARKER);

/** Has a failed hand-back on this answer already been noted on the ticket? */
const repliesShowHandbackFailure = (replies) => repliesSay(replies, HANDBACK_FAILURE_MARKER);

function handbackFailureText({ target, status, why, at } = {}) {
  const where = status ? `"${status}"` : 'the status it was already in';
  return `${HANDBACK_FAILURE_MARKER} Your answer was delivered, but returning this ticket to `
    + `"${target}" FAILED (${why || 'reason unknown'}), so it is still parked in ${where}.\n\n`
    + 'Nothing is lost: the next relay pass re-derives this from the trail above and tries the move '
    + `again.${at ? ` (Automatic — bus-relay, ${at}.)` : ''}`;
}

/**
 * A CLOSE WORD THE RELAY COULD NOT ACT ON YET (2026-10-31, SP-68).
 *
 * On a Ready to launch ticket his close word moves it to Live only once its
 * work is merged (relayLane's `closePlan`). Until then the relay says why,
 * once, as a reply under his word, and leaves the ticket where it is. The
 * word stays unspent: the pass after the PR merges closes it.
 *
 * `[bus-relay-close-refused]`, apart from both hand-back markers by
 * construction: it starts with neither `[bus-relay]` (the dedup prefix) nor
 * `[bus-relay-handback`, so it can never read as a delivery, a completed
 * move or a failed one. The reason is the first line after the marker, so a
 * later pass can tell "already said" from "the reason changed".
 */
const CLOSE_REFUSED_MARKER = '[bus-relay-close-refused]';

function closeRefusedText({ why, at, pending = true } = {}) {
  const next = pending
    ? 'Your close word still stands: the first relay pass after its work is merged moves it to Live.'
    : 'No merge is coming that would show its work landed, so your close word cannot move it. To finish '
      + 'it, tell a session to close it by hand, or reply here with what should happen instead.';
  return `${CLOSE_REFUSED_MARKER} Not closed yet: ${why}.\n\n`
    + `This ticket stays where it is. ${next}${at ? ` (Automatic — bus-relay, ${at}.)` : ''}`;
}

/** The reason the newest close refusal under his word gave, or null for none. */
function latestCloseRefusal(replies) {
  const said = (Array.isArray(replies) ? replies : [])
    .map((r) => String((r && r.comment_text) || ''))
    .filter((t) => t.startsWith(CLOSE_REFUSED_MARKER));
  if (!said.length) return null;
  const m = /^Not closed yet: (.*)\.$/m.exec(said.at(-1).slice(CLOSE_REFUSED_MARKER.length).trim());
  return m ? m[1] : '';
}

/** May this watch act on a merge command? Ad-hoc `--list` runs are
 *  notify-only by construction (see clickup_direct.mjs), so a hand-typed
 *  list id can never merge anything — same reasoning as handback. */
/** One relay interval. The overlap must be at least as long as the gap
 *  between passes, or a comment can land in the blind spot between them. */
const DEFAULT_OVERLAP_MS = 600 * 1000;

/**
 * WHICH TICKETS COST A COMMENT READ THIS PASS (2026-09-03, task 86bbugbay).
 *
 * The relay's cost is not the list fetch — that is one request per 100
 * tickets. It is the per-ticket comment read, and the reply read behind each
 * operator comment. With 104 open tickets on Agent Response a pass spent
 * 114-115 requests against ClickUp's ~100-per-minute allowance, so every pass
 * was rate-limited partway through and finished INCOMPLETE. An incomplete
 * pass cannot run Lane A (standing condition 4), so the auto-merge lane
 * halted 271 passes in a row and had never once merged. The starvation was
 * the cause; the refusal was correct.
 *
 * So: a ticket nobody has touched since the last completed pass cannot have a
 * new comment on it. Measured 2026-09-03 on task 86bbqpwfa — a task's
 * `date_updated` equals its newest comment's timestamp to the millisecond, so
 * recency is a sound proxy for "might have something to say".
 *
 * THE NON-GOAL THE TICKET ASKED US TO DECIDE, decided here and deliberately
 * NOT applied to every watch: a MERGE-CAPABLE watch reads every ticket in its
 * statuses regardless of recency. Three things there are re-decided from
 * scratch on every pass and would break if a quiet ticket went unread:
 *
 *   1. A refused merge command is re-decided every pass (task 86bbjt18r) — a
 *      refusal is a snapshot of a moment, not a verdict. PR #558 sat refused
 *      for exactly this reason on 2026-09-03: CI had not finished inside the
 *      merge step's wait. The ticket then goes quiet, and a recency filter
 *      would mean the retry that was promised never happens.
 *   2. Lane A's candidates are Ready-to-launch tickets that must be announced,
 *      left an hour and then merged. Going quiet for an hour is the NORMAL
 *      path through that lane, not a reason to stop looking at it.
 *   3. The auto-merge kill switch may have been set on any ticket.
 *
 * That watch is small — the Loop Queue at 'needs your input' and 'ready to
 * launch' held one open ticket on the day this was written, against Agent
 * Response's 104. The saving comes from the big notify-only list, and the
 * correctness comes from not touching the small merge-capable one.
 */
function ticketsToRead({ watch, tasks, mark, overlapMs = DEFAULT_OVERLAP_MS }) {
  const all = Array.isArray(tasks) ? tasks : [];
  // A merge-capable watch is never filtered — see 1-3 above.
  if (mergeEnabled(watch)) {
    return { read: all, skipped: 0, reason: 'merge-capable watch — every ticket read regardless of recency' };
  }
  // Cold start: no mark, so nothing is known to be unchanged. Read everything
  // and SAY so, rather than relaying nothing and looking healthy.
  if (!Number.isFinite(mark) || mark <= 0) {
    return { read: all, skipped: 0, reason: 'no stored high-water mark (cold start) — reading every ticket' };
  }
  // The overlap is a correctness requirement, not a safety margin. A comment
  // posted WHILE a pass is running, on a ticket that pass had already read,
  // is older than the mark the pass goes on to write — so a cutoff of exactly
  // `mark` would skip it forever. One pass interval back covers it.
  const cutoff = mark - overlapMs;
  const read = all.filter((t) => Number(t.date_updated) > cutoff);
  return {
    read,
    skipped: all.length - read.length,
    reason: `updated since ${new Date(cutoff).toISOString()} (mark minus a ${Math.round(overlapMs / 1000)}s overlap)`,
  };
}

/**
 * The mark to store for a list after a pass, or null to leave the old one.
 *
 * A partial pass must NOT advance the mark: the tickets it never reached
 * would fall behind the cutoff and their comments would be skipped forever.
 * That is the same "silently relaying nothing" failure the cold-start branch
 * above guards, arrived at from the other direction.
 *
 * The stamp is the time the pass STARTED, never the time it finished. A pass
 * takes tens of seconds; a comment posted during it would sit before a
 * finish-time mark and be missed on the next pass — the overlap would have to
 * absorb it, and an overlap doing two jobs hides when one of them is wrong.
 */
function markAfterPass({ complete, startedAt, previous }) {
  if (!complete) return { mark: previous ?? null, advanced: false, why: 'the pass did not complete this list — the mark stays where it was so the next pass re-reads the window' };
  return { mark: startedAt, advanced: true, why: 'the list was read in full' };
}

function mergeEnabled(watch) {
  return Boolean(watch && watch.merge);
}

/**
 * DELIVERY (2026-08-23, task 86bbjxew2). The handback gate above is right:
 * a ticket must not move on an answer that was never delivered. But it used
 * to be wired to a single chat POST, and on 2026-08-23 every chat write in
 * the workspace returned HTTP 400 for sixteen hours. The answers themselves
 * were never at risk — they are comments on the tickets, which is where the
 * loops read them from — but the RECEIPT was unavailable, so nothing moved:
 * 23 comments and 5 handbacks parked behind one surface.
 *
 * So the gate stays and the target moves. "Delivered" now means the message
 * reached somewhere durable: the party line, or failing that a short receipt
 * comment on the ticket the message concerns. Task comments were the most
 * reliable write in this API throughout that outage.
 */

/** The dedup marker prefix. Exported so the text a pass WRITES and the
 *  "already relayed" check that READS it can never drift apart. */
const BUS_RELAY_MARKER = '[bus-relay]';

/** What counts as delivered, given how each surface answered, and — when the
 *  answer is "not delivered" — the honest one-line reason WHY, which the
 *  caller prints verbatim.
 *
 *  That `why` is a decision, not a string: review finding, 2026-08-24. The
 *  caller used to hard-code "the party line failed and so did the receipt
 *  comment" for every undelivered case, including the case where no receipt
 *  was ever attempted. During a real outage that line appeared for every
 *  Agent Response comment and told the reader task comments were failing too
 *  — the opposite of the truth, and the opposite of what this very file's
 *  outage write-up says to conclude. Chat is still preferred; the fallback is
 *  a fallback, not a second channel. */
function deliveryVerdict({
  chatOk, handsBack, receiptAttempted, receiptPosted, receiptOk, receiptStatus,
  alarmTicketAttempted, alarmTicketOk, alarmTicketWhy,
} = {}) {
  if (chatOk) return { ok: true, via: 'chat' };

  // A ticket receipt only DELIVERS on a watch that hands the ticket back.
  //
  // Review finding, 2026-08-23, and it is the one that matters. Of the three
  // watches, only one has a handback target:
  //
  //   Agent Response, fresh comment   -> no target
  //   Loop Queue, "ready to launch"   -> no target
  //   Loop Queue, "needs your input"  -> Queued        <- the only one
  //
  // The ticket's own reasoning for the fallback — "the answer is already a
  // comment on the ticket, which is where every loop reads it from" — is only
  // true for that last one. On the other two NOTHING reads the ticket: the
  // party line IS the delivery. Counting a receipt there would post a note to
  // Dane on a ticket he is already looking at, write the permanent dedup
  // marker, and drop the bus message for good once chat recovered.
  //
  // Before this feature those two cases retried every pass until the bus took
  // them. Turning a self-healing retry into silent permanent loss is the exact
  // shape of bug this ticket exists to remove, so: no handback, no delivery.
  //
  // THE UNDELIVERED ALARMS TICKET IS NOT THAT RECEIPT (2026-09-14, task
  // 86bc0mxv0). Everything above is about a note on the SAME ticket, which
  // nothing reads. The standing "Undelivered alarms" ticket is a different
  // place, one Dane reads, and the message is kept there whole — so nothing is
  // lost when chat recovers, which was the whole objection. It is the rule
  // #678 and #689 already set for the relay's own alarms. Without it, every
  // comment he left on a Ready to launch ticket failed every relay pass while
  // chat was refused: 18 of 40 passes exited 1 on 2026-09-14, the relay read
  // QUIET for 5h40m, and each pass said merge commands were not read.
  if (!handsBack && alarmTicketOk) return { ok: true, via: 'alarm-ticket' };
  if (!handsBack) {
    if (alarmTicketAttempted) {
      return {
        ok: false,
        via: 'none',
        why: `the "${FALLBACK_TASK_NAME}" ticket refused it too (${alarmTicketWhy || 'reason unknown'})`,
      };
    }
    return {
      ok: false,
      via: 'none',
      why: receiptAttempted
        ? 'a receipt was written, but this watch hands nothing back — only the party line delivers here'
        : 'no receipt was attempted, because this watch hands nothing back — only the party line delivers here',
    };
  }

  if (receiptOk) return { ok: true, via: 'ticket' };
  if (!receiptAttempted) return { ok: false, via: 'none', why: 'no receipt was attempted' };
  if (!receiptPosted) {
    return { ok: false, via: 'none', why: `the fallback receipt comment also failed (HTTP ${receiptStatus == null ? '?' : receiptStatus})` };
  }
  return { ok: false, via: 'none', why: 'the fallback receipt reported HTTP 200 but could not be read back' };
}

/** The dedup marker's text. Same PREFIX whichever surface was used, so the
 *  existing "already relayed" check still matches either one; the words
 *  after it differ so a human reading the trail later can see which surface
 *  carried the message. Nothing delivered means nothing to mark — null, and
 *  the comment is retried next pass. */
function relayMarkerText({ via, channel, at } = {}) {
  if (via === 'chat') return `${BUS_RELAY_MARKER} sent to channel ${channel} at ${at}`;
  if (via === 'ticket') return `${BUS_RELAY_MARKER} chat unavailable, receipted on the ticket at ${at}`;
  if (via === 'alarm-ticket') return `${BUS_RELAY_MARKER} chat unavailable, saved on the "${FALLBACK_TASK_NAME}" ticket at ${at}`;
  return null;
}

/** The fallback comment itself. A RECEIPT, not a re-quote: Dane's words are
 *  already on this ticket, one comment up. What is missing without this is
 *  the acknowledgement that they were read and acted on. */
const RECEIPT_FINGERPRINT = 'Your answer was read and picked up.';

function receiptText({ why, target, at } = {}) {
  // Past tense for what is certain, present for what is under way — never the
  // future. Review finding, 2026-08-23: the first version announced "this
  // ticket is going back to Queued" BEFORE the move was attempted, so a failed
  // PUT left the ticket sitting in "Needs your input" carrying a comment
  // saying otherwise. The failure was always reported in `unchecked`, but the
  // untrue note stayed on the ticket.
  //
  // A receipt is only ever written on a watch that hands the ticket back, so
  // `target` is always set by the time this is called.
  const move = !target ? ''
    : String(target).toLowerCase() === 'live'
      ? ' This ticket is being closed, as you asked.'
      : ` This ticket is being returned to ${target}.`;
  return `${RECEIPT_FINGERPRINT}${move} The party line is unavailable right now (${why || 'reason unknown'}), so this note is the record instead.

${receiptSignature(at)}`;
}

/** The receipt's own signature line, carrying the moment it was written.
 *
 *  The timestamp is not decoration — it is what makes ONE receipt findable.
 *  Review finding, 2026-08-24: the read-back searched every comment on the
 *  task for RECEIPT_FINGERPRINT, which is a constant, so a leftover receipt
 *  from an earlier outage "verified" a fresh POST that never stuck — the exact
 *  case the read-back was added to catch. */
function receiptSignature(at) {
  return at ? `(Automatic — bus-relay, ${at}.)` : '(Automatic — bus-relay.)';
}

/** Is this comment the receipt we just wrote — not merely *a* receipt?
 *
 *  Two independent handles, either of which is enough: the id ClickUp returned
 *  from the POST, and the ISO instant folded into the signature line. The id is
 *  exact; the timestamp survives a response shape that carries no id. Both are
 *  unique to this write, which a bare fingerprint never was. */
function isThisReceipt(comment, { id, at } = {}) {
  if (!comment) return false;
  if (id != null && String(comment.id) === String(id)) return true;
  const text = String(comment.comment_text || '');
  return Boolean(at && text.includes(RECEIPT_FINGERPRINT) && text.includes(receiptSignature(at)));
}

/**
 * Where a failed bus post gets reported. Two buckets, and the difference is
 * whether anybody was actually told:
 *
 *   'skipped'   — cosmetic. The message reached a durable surface anyway, or
 *                 (merge step) its real explanation was already written onto
 *                 the ticket by the caller. Gets its own summary heading and
 *                 does NOT fail the run.
 *   'unchecked' — nobody was told. Still "could not fully verify", still
 *                 exits 1. The gate is re-pointed, never weakened.
 */
/* ------------------------------------------------------------------------ *
 * Breaking the party line on purpose (task 86bbjzg83, Dane's option B).
 *
 * PR #414 gave the relay a fallback: chat first, then a receipt comment on
 * the ticket, and the handback fires if either landed. What it could not give
 * was a way to WATCH that happen. The fallback only runs during a vendor
 * outage, which is the worst possible moment to discover a bug in it, and the
 * one command that sounds like a rehearsal — `bus-relay --dry-run` — returns
 * before deliverToBus() is ever called.
 *
 * So: a switch that fails every party-line write without sending a request,
 * and a dry-run that stops short-circuiting when it is on.
 * ------------------------------------------------------------------------ */

/** What a simulated party-line failure reports as its `why`. It says
 *  "simulated" in the string itself, deliberately: this text travels into the
 *  run report and into the receipt comment's body, and a reader finding it in
 *  a log six months from now must not mistake a rehearsal for an outage. */
const SIMULATED_BUS_WHY = 'HTTP 000 — SIMULATED by --simulate-bus-failure (no request was sent)';

/** May `--simulate-bus-failure` run? Only inside `--dry-run`.
 *
 *  Outside dry-run the switch would not be a rehearsal, it would be sabotage
 *  with permanent consequences: a forced chat failure sends the relay down the
 *  real fallback, which posts a real receipt comment saying the party line is
 *  unavailable and then writes the real, permanent dedup marker recording that
 *  the message was carried by the ticket. Chat would have been fine the whole
 *  time. The bus message is then dropped for good — the marker means "already
 *  relayed" forever — and the ticket's trail now lies about an outage that
 *  never happened.
 *
 *  That is the exact shape of loss #414 was written to remove, so the guard
 *  refuses rather than warns. Returns { ok, why } — `why` is printed verbatim.
 */
function simulationGuard({ simulate, dryRun } = {}) {
  if (!simulate) return { ok: true, why: '' };
  if (dryRun) return { ok: true, why: '' };
  return {
    ok: false,
    why: [
      '--simulate-bus-failure requires --dry-run.',
      '',
      'Without it this is not a rehearsal. Forcing the party line to fail sends the',
      'relay down its real fallback, which would post a real receipt comment claiming',
      'an outage that is not happening, then write the permanent "already relayed"',
      'marker against it — dropping the real bus message for good and leaving a trail',
      'that lies. Nothing was run.',
      '',
      'Try:  npm run clickup -- bus-relay --dry-run --simulate-bus-failure',
    ].join('\n'),
  };
}

/** One line per relayed comment in a simulated pass, so the rehearsal is
 *  readable rather than inferred. `verdict` is deliveryVerdict()'s own answer
 *  — this only renders it. `target` is the status the watch would move to, or
 *  null on a notify-only watch.
 *
 *  The failure explanation prefers `reason` (deliveryVerdict's account of why
 *  nothing was delivered) over `why` (the chat failure). Keeping those two
 *  apart was a review finding on #414: printing the chat error alone says
 *  "HTTP 000" and leaves out the part that actually explains the outcome —
 *  that this watch hands nothing back, so a receipt would deliver nothing. */
function simulationLine({ verdict, target } = {}) {
  const v = verdict || {};
  if (v.ok && v.via === 'ticket') {
    return `  SIMULATION — party line down: delivered by receipt on the ticket; hand-back to "${target}" WOULD fire`;
  }
  if (v.ok && v.via === 'alarm-ticket') {
    return `  SIMULATION — party line down: delivered by saving it on the "${FALLBACK_TASK_NAME}" ticket; no hand-back (this watch hands nothing back)`;
  }
  if (v.ok && v.via === 'chat') {
    // Unreachable while simulating (chat always fails), but a verdict of
    // "chat" here would mean the simulation did not take effect — say so
    // rather than printing a success line that reads as a passing rehearsal.
    return '  SIMULATION — reported delivery via chat, which the simulation should have made impossible. Treat this run as INVALID.';
  }
  const explain = v.reason || v.why;
  const why = explain ? ` — ${explain}` : '';
  return `  SIMULATION — party line down: NOT delivered${why}; nothing marked relayed, no hand-back`;
}

function busFailureBucket({ delivered, cosmetic } = {}) {
  return delivered || cosmetic ? 'skipped' : 'unchecked';
}

module.exports = {
  operatorComments,
  defaultWatches,
  sweepVerdict,
  ESCALATION_BANNER,
  isEscalationCard,
  HAND_HELD_MARKER,
  handHeldText,
  isHandHeldMarker,
  commentAt,
  answerAwaitingHandback,
  receiptTargetFor,
  handbackTarget,
  handbackDestination,
  isCloseCommand,
  CLOSE_PHRASES,
  GO_PHRASE,
  CLOSE_REFUSED_MARKER,
  closeRefusedText,
  latestCloseRefusal,
  HANDBACK_FAILURE_MARKER,
  handbackFailureText,
  HANDBACK_DONE_MARKER,
  handbackDoneText,
  repliesShowRelayed,
  repliesShowHandbackDone,
  repliesShowHandbackFailure,
  mergeEnabled,
  ticketsToRead,
  markAfterPass,
  DEFAULT_OVERLAP_MS,
  BUS_RELAY_MARKER,
  RECEIPT_FINGERPRINT,
  receiptSignature,
  isThisReceipt,
  deliveryVerdict,
  relayMarkerText,
  receiptText,
  busFailureBucket,
  SIMULATED_BUS_WHY,
  simulationGuard,
  simulationLine,
};
