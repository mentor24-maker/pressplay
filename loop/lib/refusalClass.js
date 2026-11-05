'use strict';

/**
 * refusalClass — every reason the merge step can refuse for, classified
 * TERMINAL or TRANSIENT at the point it is raised.
 *
 * WHY THIS EXISTS (2026-09-03, task 86bbtqpxd). Ticket 86bbqw49y sat in
 * Ready to launch for twelve hours with its work already merged and live,
 * because the thing reporting on it said, twenty-five times, that no looking
 * was required. Every refusal carried the same closing paragraph:
 *
 *   Your approval is still standing — you do not have to say "merge" again.
 *   Every later pass re-checks this ticket, so the moment the reason above
 *   is dealt with it goes through on its own.
 *
 * That paragraph is TRUE of "checks are red" and FALSE of "the PR is already
 * merged". Two thirds of the refusals on that ticket were of the second kind:
 * reasons no later pass could ever clear, wearing a promise that one would.
 * Then the dedup went quiet and the ticket said nothing at all.
 *
 * This is the same shape as the zero-checks deadlock (`docs/DOCTRINE.md`,
 * merge-guard): **the reassurance is what hides the refusal that can never
 * clear.** A refusal repeating forever is at least visible; a refusal
 * repeating forever while promising it is temporary actively recruits the
 * reader into not investigating.
 *
 * THE RULE. A refusal reason is classified where it is RAISED, never inferred
 * later from its wording — wording drifts, and a classifier reading prose
 * would be a second definition of the answer sitting next to the first. Every
 * reason names a code from `REFUSAL_CODES`; every code has an entry here;
 * there is NO DEFAULT. `classifyRefusal` throws on a code it does not know,
 * and `refusalClass.test.js` fails if a code exists without an entry, if an
 * entry exists without a code, or if a `refuse` site in mergeOnComment.js
 * raises without one.
 *
 * THREE CLASSES, NOT TWO:
 *
 *   'transient' — the reason can stop being true, and when it does a later
 *                 pass merges on the operator's original word. This is the
 *                 only class allowed to promise the approval carries over.
 *   'terminal'  — the reason will never stop being true on its own. Somebody
 *                 has to do something, and the message says who and what.
 *   'unknown'   — the gate could not tell. Treated as TERMINAL for messaging:
 *                 a reader who cannot be told to wait must be told to look
 *                 (DOCTRINE 3.11 — "could not check" is never a pass).
 *
 * NAMING THE ACTOR IS PART OF THE CLASSIFICATION (`docs/DOCTRINE.md` §2.5).
 * A terminal message that says "this needs to be dealt with" has named
 * nobody, which is how the twelve hours happened. Every terminal entry's
 * `needs` sentence names `an agent session` or `Dane` out loud, and a test
 * greps for exactly that.
 */

/**
 * The codes, as an object so a typo is `undefined` rather than a silently
 * unknown string. Nothing outside this file invents a code.
 */
const { operatorName } = require('./substrateConfig.js');
const REFUSAL_CODES = Object.freeze({
  // --- raised by mergeDecision, against the ticket's own comments
  noReviewVerdict: 'no-review-verdict',
  reviewNotPassed: 'review-not-passed',
  authorizationPredatesVerdict: 'authorization-predates-verdict',
  noPrRecorded: 'no-pr-recorded',

  // --- raised by githubGate, against `gh pr view`
  prAlreadyMerged: 'pr-already-merged',
  prNotOpen: 'pr-not-open',
  prIsDraft: 'pr-is-draft',
  checksRed: 'checks-red',
  noChecksAtAll: 'no-checks-at-all',
  unstableCannotTell: 'unstable-cannot-tell',
  blockedByNamedRule: 'blocked-by-named-rule',
  blockedCannotTell: 'blocked-cannot-tell',
  githubReportsDraft: 'github-reports-draft',
  unreadableMergeState: 'unreadable-merge-state',

  // --- raised by the relay itself (scripts/clickup_direct.mjs)
  reviewGateCannotRerun: 'review-gate-cannot-rerun',
  reviewGateRerunUnresolved: 'review-gate-rerun-unresolved',
  mergeCommandFailed: 'merge-command-failed',
});

const REFUSAL_CLASSES = Object.freeze(['transient', 'terminal', 'unknown']);

/**
 * The table. `kind` is the classification; `needs` is the sentence a terminal
 * or unknown refusal says INSTEAD of the standing-approval paragraph, and it
 * must name who acts.
 *
 * A transient entry carries no `needs` on purpose: its message already ends
 * with the truthful promise, and a second "here is what to do" would be the
 * reader's cue to act on something that is already being handled.
 */
// A `needs` that names the operator is a getter, read when the sentence is
// written rather than when this file loads: the name is config, and the config
// is the working directory's (review of task 86bcgmnpy).
const REFUSAL_REASONS = Object.freeze({
  [REFUSAL_CODES.noReviewVerdict]: {
    kind: 'transient',
    // loop-review runs on a timer and writes the verdict this is waiting for.
  },
  [REFUSAL_CODES.reviewNotPassed]: {
    kind: 'transient',
    // The send-back goes to Rework, the build loop drains it, review passes it.
  },
  [REFUSAL_CODES.authorizationPredatesVerdict]: {
    kind: 'terminal',
    get needs() { return `That merge command belongs to an earlier round of this ticket and cannot release the current one — no later pass changes that. **${operatorName()}** has to say "merge" again on the current review verdict, if he still wants it merged. This step will not ask again.`; },
  },
  [REFUSAL_CODES.noPrRecorded]: {
    kind: 'terminal',
    needs: 'Nothing on this ticket points at a PR, so this step has nothing to act on, and no later pass can invent one. **An agent session** has to record the PR (`npm run clickup -- pr-opened --task <id> --pr <url>`), or say whether one exists at all. This step will not ask again.',
  },

  [REFUSAL_CODES.prAlreadyMerged]: {
    kind: 'terminal',
    get needs() { return `This PR is merged; the work is live. There is nothing left for this step to do and no later pass will do anything either. This ticket needs moving to Live — **an agent session or ${operatorName()}**, not this step. This step will not ask again.`; },
  },
  [REFUSAL_CODES.prNotOpen]: {
    kind: 'terminal',
    needs: 'A closed PR never reopens on its own, so no later pass will merge this. **An agent session** has to reopen it, open a replacement and record it with `npm run clickup -- pr-opened`, or park the ticket. This step will not ask again.',
  },
  [REFUSAL_CODES.prIsDraft]: {
    kind: 'transient',
    // Marking it ready clears it and the next pass merges on the same word.
  },
  [REFUSAL_CODES.checksRed]: {
    kind: 'transient',
    // A push that fixes them clears it; the next pass merges.
  },
  [REFUSAL_CODES.noChecksAtAll]: {
    kind: 'terminal',
    needs: 'A PR with no checks stays that way — GitHub creates a check run for a push, not for waiting, so no later pass will find one. **An agent session** has to push a commit to the branch (`git commit --allow-empty -m "Nudge GitHub into creating a check run"`) so the checks exist to be read. This step will not ask again.',
  },
  [REFUSAL_CODES.unstableCannotTell]: {
    kind: 'unknown',
    get needs() { return `This step could not work out which check GitHub is unhappy about, so it cannot say whether waiting would help. **An agent session or ${operatorName()}** has to read the PR's checks on GitHub and decide. This step will not ask again.`; },
  },
  [REFUSAL_CODES.blockedByNamedRule]: {
    kind: 'transient',
    // GitHub named the rule; satisfying it clears the refusal.
  },
  [REFUSAL_CODES.blockedCannotTell]: {
    kind: 'unknown',
    get needs() { return `GitHub did not name the rule it is holding the merge on, so this step cannot say whether a later pass would clear it. **An agent session or ${operatorName()}** has to open the PR and read what GitHub is blocking on. This step will not ask again.`; },
  },
  [REFUSAL_CODES.githubReportsDraft]: {
    kind: 'transient',
    // Same as prIsDraft, read off mergeStateStatus rather than isDraft.
  },
  [REFUSAL_CODES.unreadableMergeState]: {
    kind: 'unknown',
    needs: 'GitHub reported a merge state this step does not know how to read, so it cannot say whether a later pass would clear it, and it will not guess in the merging direction. **An agent session** has to read the PR and either merge it by hand or teach this gate the value. This step will not ask again.',
  },

  [REFUSAL_CODES.reviewGateCannotRerun]: {
    kind: 'transient',
    // The next pass tries the re-run again from the top.
  },
  [REFUSAL_CODES.reviewGateRerunUnresolved]: {
    kind: 'transient',
    // Documented as re-decidable in reviewGate.afterRerunDecision.
  },
  [REFUSAL_CODES.mergeCommandFailed]: {
    kind: 'transient',
    // `gh pr merge` failing once says nothing about the next attempt.
  },
});

/**
 * The classification for a code. THROWS on anything not in the table — there
 * is deliberately no default, because a default is how an unclassified reason
 * would inherit whichever promise happened to be cheapest to write.
 */
function classifyRefusal(code) {
  const entry = REFUSAL_REASONS[code];
  if (!entry) {
    throw new Error(
      `unclassified merge refusal reason ${JSON.stringify(code)} — every reason must be raised with a code from `
      + 'REFUSAL_CODES and classified terminal/transient/unknown in REFUSAL_REASONS '
      + '(scripts/builder/refusalClass.js). There is no default.',
    );
  }
  return entry;
}

/**
 * Does this refusal SPEAK as terminal? Both 'terminal' and 'unknown' do: a
 * reader who cannot be told to wait must be told to look. Only 'transient'
 * may carry the standing-approval promise.
 */
function speaksAsTerminal(code) {
  return classifyRefusal(code).kind !== 'transient';
}

/** The sentence a terminal/unknown refusal says instead of the promise. */
function refusalNeeds(code) {
  return classifyRefusal(code).needs || '';
}

module.exports = {
  REFUSAL_CODES,
  REFUSAL_CLASSES,
  REFUSAL_REASONS,
  classifyRefusal,
  speaksAsTerminal,
  refusalNeeds,
};
