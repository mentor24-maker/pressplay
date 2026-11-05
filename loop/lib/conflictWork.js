'use strict';

const { CODES: CATCH_UP_CODES } = require('./branchCatchUp.js');
const { operatorName } = require('./substrateConfig.js');

/**
 * conflictWork — turning a merge conflict into work somebody actually picks up.
 *
 * WHY THIS EXISTS (2026-08-30, task 86bbq0fh8). When the merge step hit a real
 * conflict it did two things: it commented on the ticket telling Dane his
 * approval still stood and he need not act, and it posted `MERGE BLOCKED` to
 * the bus asking for an agent session to resolve the conflict and push.
 *
 * Nothing consumes bus messages. No session polls that channel and turns "a
 * session needs to resolve this" into claimed work, so the request went into
 * an empty room while the ticket comment beside it described a process already
 * underway. Ticket 86bbmfc15 (PR #434) sat that way from 2026-08-26 to
 * 2026-08-29. Dane found it himself and asked why nothing had happened. Every
 * relay pass in those three days logged `MERGE HANDED OFF (unchanged, nothing
 * posted)` and `0 merged` — the correct quiet behaviour once a hand-off
 * exists. The system worked as designed and the design had a hole.
 *
 * Dane picked option C on 2026-08-30: **file it into the Loop Queue.** On a
 * conflict the merge step files an ordinary `Queued` ticket — "resolve the
 * conflict on branch X for ticket Y" — into the same list the build loop
 * already drains every pass. No new consumer, because the consumer exists and
 * is already running on a timer. He is not interrupted, and the work is
 * visible on the board like everything else.
 *
 * Two rules this module exists to keep (vault `doctrine/TERMINOLOGY.md`,
 * ratified 2026-08-29):
 *
 *   - A hand-off names which of the two it needs — a person (a human being)
 *     or an agent session. A hand-off that cannot name a specific waiting
 *     actor does not get to imply one. Passive voice is the tell, and is
 *     itself the defect.
 *   - If nothing is going to pick the work up, the message says so.
 *
 * So `filed` is not decoration here. It is the named actor, and the notice
 * builder in mergeOnComment.js reads it to decide which promise the body is
 * allowed to make. No ticket filed means no actor, which means no promise.
 */

/**
 * The ONE shape a filed conflict ticket is recorded in, and the only shape
 * `findConflictTicket` will read back. Same discipline as `PR opened:` in
 * loopTrail.js — the writer and the reader share one definition, so a trail
 * the next pass cannot act on is a trail this module refuses to call written.
 */
const CONFLICT_TICKET_TRAIL = 'CONFLICT TICKET FILED:';

/** Anchored on the PR number so a REBUILT PR files its own ticket rather than
 *  matching the one filed for the PR before it. */
const CONFLICT_TICKET_RE = /CONFLICT TICKET FILED:\s*PR\s*#(\d+)\s*—\s*(\S+)/i;

/** How long a conflict may sit filed-but-unresolved before the pass stops
 *  being quiet about it. Twenty-four hours: the build loop runs on a timer
 *  measured in tens of minutes, so a day of nothing means the queue is not
 *  draining this ticket and somebody should know. Three days must be
 *  impossible; one pass of noise per day is the price. */
const STALE_HAND_OFF_MS = 24 * 60 * 60 * 1000;

/**
 * How many times one merge may fail for the SAME reason before the pass stops
 * being quiet about it — regardless of how little time has passed.
 *
 * WHY ATTEMPTS AND NOT ONLY AGE (2026-09-06, task 86bbvr0j5). Dane's call,
 * after PR #628 failed to merge five times in ninety minutes while every
 * surface stayed silent: "maybe the system can notice them sooner". The age
 * rule above was written for a hand-off nobody had picked up, where a day of
 * nothing is the signal. It is the wrong instrument for a merge that IS being
 * retried and IS failing every time — the clock barely moves, and the thing
 * going wrong is the repetition, not the wait.
 *
 * Three, because two is a coincidence a later pass often clears on its own
 * (a lost push race, GitHub answering stale), and by the fourth Dane is
 * reading identical comments and wondering why nothing has noticed. It is a
 * FLOOR on noise, not a promise of silence before it: the age rule still fires
 * independently for a hand-off that is not retrying at all.
 */
const MERGE_ATTEMPT_ALARM = 3;

/**
 * THE ONE PREDICATE (2026-08-31, task 86bbq80j5).
 *
 * `gate.action === 'conflict'` is GitHub's answer, and GitHub's answer about a
 * branch is often minutes stale. What THIS machine found when it tried the
 * merge itself is the `localVerdict`, and there are THREE answers it can
 * give — not two:
 *
 *   'real-conflict'   — the branches genuinely changed the same lines.
 *                       Somebody has to decide what the merged file says.
 *   'no-overlap'      — the local merge really did come back clean. A lost
 *                       push race, or GitHub answering about a state it has
 *                       not caught up with. Nothing to resolve; the next pass
 *                       retries and it clears itself.
 *   'could-not-check' — the check never ran. Wrong repo, failed fetch, no
 *                       scratch worktree, a merge result that failed its own
 *                       ancestor proof. NO FINDING WAS MADE.
 *
 * WHY THREE AND NOT TWO (review round 2, 2026-08-31). The first fix collapsed
 * the last two into one bucket called 'unknown' and then wrote copy for it
 * that asserted a finding. On a `FETCH_FAILED` verdict the ticket comment said
 * *"this machine could not check whether that is true"* while the bus post,
 * seconds later, said *"this machine found no overlap between the branch and
 * main. Nothing needs resolving and nobody needs to claim it."* One says it
 * could not look; the other stands the room down on the strength of a look it
 * never took — the same two-comments-200ms-apart shape this ticket exists to
 * remove, arriving in the one place Dane reads.
 *
 * It cost a second way too: `WRONG_REPO` is what the relay gets for EVERY
 * conflicting PR in a repo whose checkout is not on that machine — the queue
 * carries `repo:normie`, `repo:pulse` and `repo:vault`. Deterministically,
 * every pass, forever. Read as self-healing, that filed nothing and told the
 * room nobody needed to claim it, when in fact nothing had been checked and no
 * retry from that machine could ever succeed.
 *
 * So a finding is only ever claimed when a finding was actually made, and the
 * two decisions that matter — file a ticket? name which actor? — read ONE
 * function. They cannot drift, because there is only one answer to read.
 *
 * The original incident this predicate was written for is still the reason it
 * gates filing at all: on 2026-08-30 the merge step filed a resolution ticket
 * on `gate.action` alone, while the hand-off comment built moments later read
 * the verdict and correctly promised the next pass would merge it (PR #444,
 * ticket 86bbmmv7t). The filed ticket — "Resolve the merge conflict on PR
 * #444" — described clearing conflict markers that did not exist.
 * `git merge-tree` on that pair exited 0.
 */
const VERDICT_KINDS = Object.freeze({
  REAL_CONFLICT: 'real-conflict',
  NO_OVERLAP: 'no-overlap',
  COULD_NOT_CHECK: 'could-not-check',
});

/**
 * Every outcome `catchUpBranchLocally` can return, and which of the three
 * answers it is. Exhaustive on purpose, and a test fails if a code is added to
 * branchCatchUp without a decision here — the whole defect above was a default
 * bucket quietly absorbing cases nobody had thought about.
 *
 *   CLEAN / PUSH_FAILED  the merge itself succeeded with nothing to resolve.
 *                        PUSH_FAILED is the 2026-08-30 lost push race: clean
 *                        merge, the push lost a race with another session.
 *                        Both are genuine findings of no overlap.
 *   REAL_CONFLICT        git said the files overlap. A finding, the other way.
 *   WRONG_REPO           this checkout is not that repo. Nothing was tried.
 *   FETCH_FAILED         no fresh refs, so nothing could be merged.
 *   WORKTREE_FAILED      no scratch tree, so nothing could be merged.
 *   NOT_ANCESTOR         a merge that does not contain main is a result this
 *                        module refuses to vouch for. The push was correctly
 *                        withheld, and so is the finding.
 */
const CATCH_UP_VERDICTS = Object.freeze({
  [CATCH_UP_CODES.CLEAN]: { kind: VERDICT_KINDS.NO_OVERLAP },
  [CATCH_UP_CODES.PUSH_FAILED]: { kind: VERDICT_KINDS.NO_OVERLAP },
  [CATCH_UP_CODES.REAL_CONFLICT]: { kind: VERDICT_KINDS.REAL_CONFLICT },
  [CATCH_UP_CODES.WRONG_REPO]: { kind: VERDICT_KINDS.COULD_NOT_CHECK, permanent: true },
  [CATCH_UP_CODES.FETCH_FAILED]: { kind: VERDICT_KINDS.COULD_NOT_CHECK },
  [CATCH_UP_CODES.WORKTREE_FAILED]: { kind: VERDICT_KINDS.COULD_NOT_CHECK },
  [CATCH_UP_CODES.NOT_ANCESTOR]: { kind: VERDICT_KINDS.COULD_NOT_CHECK },
});

/**
 * Turn what `catchUpBranchLocally` returned into the verdict the rest of this
 * module reads. Lives here, beside the predicate, rather than inline at the
 * call site: the code-to-answer table IS the decision, and a copy of it in
 * clickup_direct.mjs is a second place for it to drift.
 *
 * `permanent` travels with WRONG_REPO because the copy has to say it. Every
 * other could-not-check might work on the next pass; that one will not, from
 * this machine, ever.
 */
function verdictFromCatchUp(local) {
  if (!local || !local.code) return null;
  // No default bucket. An unrecognised code is a code nobody decided about,
  // and the safe answer to "did you check?" is always "no".
  const mapped = CATCH_UP_VERDICTS[local.code] || { kind: VERDICT_KINDS.COULD_NOT_CHECK };
  return { ...mapped, code: local.code, reason: local.reason };
}

function conflictVerdictKind(localVerdict) {
  // `localVerdict === null` IS A DELIBERATE CHOICE, not a fallthrough
  // (criterion 4 of task 86bbq80j5, revisited in review round 2). Null means
  // no verdict was produced at all, and the only remaining way that happens is
  // a dry run, which never attempts the catch-up. "Nothing was checked" is
  // exactly what could-not-check means, so that is what it reads as.
  //
  // It used to read as the self-healing answer, which made a dry run claim a
  // finding it had not made and quietly under-report stalled hand-offs: an
  // unfiled, actor-less real conflict came out of the dry run looking calm.
  // A dry run files nothing either way, so this costs nothing and the
  // diagnostic stops being more confident than the real pass.
  //
  // The other case that used to land here — the local catch-up SUCCEEDED and
  // pushed, and GitHub's re-read still said conflict — is no longer null. The
  // merge step carries that CLEAN verdict through, so the textbook stale
  // answer is now a stated 'no-overlap' rather than an absence.
  if (!localVerdict) return VERDICT_KINDS.COULD_NOT_CHECK;
  if (localVerdict.kind) {
    return Object.values(VERDICT_KINDS).includes(localVerdict.kind)
      ? localVerdict.kind
      : VERDICT_KINDS.COULD_NOT_CHECK;
  }
  // The legacy boolean. `true` is a finding; `false` never distinguished "no
  // overlap" from "did not look", so it fails to the answer that claims
  // nothing.
  return localVerdict.realConflict ? VERDICT_KINDS.REAL_CONFLICT : VERDICT_KINDS.COULD_NOT_CHECK;
}

/** Did this machine find a genuine overlap? The only condition under which the
 *  copy may say the two branches changed the same lines. */
function isRealOverlap(localVerdict) {
  return conflictVerdictKind(localVerdict) === VERDICT_KINDS.REAL_CONFLICT;
}

/**
 * Did this machine actually look, and find nothing to resolve? The ONLY
 * condition under which any message is allowed to say "no overlap was found"
 * and stand the room down. Everything else either found an overlap or found
 * out nothing.
 */
function isSelfHealing(localVerdict) {
  return conflictVerdictKind(localVerdict) === VERDICT_KINDS.NO_OVERLAP;
}

/** Was the question left unanswered? Not a finding — the absence of one. */
function couldNotCheck(localVerdict) {
  return conflictVerdictKind(localVerdict) === VERDICT_KINDS.COULD_NOT_CHECK;
}

/** Will this verdict be the same on every future pass from this machine?
 *  True only for the wrong-repo case, and the copy has to say so out loud —
 *  "the next pass retries" is a false promise when no retry can ever work. */
function isPermanent(localVerdict) {
  return Boolean(localVerdict && localVerdict.permanent) && couldNotCheck(localVerdict);
}

/**
 * THE ONE VOCABULARY (2026-08-31, task 86bbq80j5, review round 3).
 *
 * The three-way answer above reached the hand-off comment and stopped there.
 * Four other surfaces still asked a TWO-way question — they branched on the
 * actor (`later-pass` or not), which cannot tell "this machine looked and
 * found an overlap" apart from "this machine never looked at all". So a
 * `WRONG_REPO` verdict produced a hand-off comment saying *"Whether there is
 * anything to resolve is still unknown"* directly above a link to a ticket
 * titled *"Resolve the merge conflict on PR #501"*, whose acceptance criteria
 * told its builder to clear conflict markers. That is the 2026-08-30 PR #444
 * defect word for word, reproduced one level down — and it is deterministic,
 * because `WRONG_REPO` is what the relay machine returns for EVERY conflicting
 * PR on a `repo:normie`, `repo:pulse` or `repo:vault` ticket, every pass.
 *
 * So the nouns live in ONE table, keyed by the one verdict kind. A surface
 * cannot describe a verdict as something the verdict did not say, because no
 * surface holds its own words any more. Adding a verdict kind without giving
 * it a full entry here fails a test.
 *
 * The `real-conflict` column is the wording that shipped before any of this,
 * kept byte-for-byte: review rounds 2 and 3 both verified those bodies against
 * `main` as evidence the fixes had not disturbed the case that was always
 * right. That is a property worth keeping rather than a coincidence to spend.
 */
const WORK_VOCABULARY = Object.freeze({
  [VERDICT_KINDS.REAL_CONFLICT]: Object.freeze({
    /** The filed ticket's title. */
    ticketName: (prNumber, where) => `Resolve the merge conflict on PR #${prNumber}${where}`,
    /** What the hand-off comment calls the work when it points at that ticket. */
    handOver: 'Resolving it',
    /** The same, as a sentence opener on the original ticket. */
    filedWork: (prNumber) => `Resolving the conflict on PR #${prNumber}`,
    /** The banner a stalled hand-off wears on the bus. */
    stallHeadline: 'CONFLICT STILL UNRESOLVED',
    /** What the stalled line says is being waited on. */
    stallWhat: (prNumber) => `PR #${prNumber} has been waiting on a conflict resolution`,
    /** Why an aged hand-off is news, when a ticket IS on file. */
    stallWhy: (filed, age) => `conflict ticket ${filed.id} has been open ${age} without clearing this conflict`,
    /** Why a REPEATEDLY failing merge is news, whatever the clock says. */
    stallWhyAttempts: (filed, tries) => `this merge has now failed ${tries} times for the same conflict${filed ? `, and conflict ticket ${filed.id} has not cleared it` : ', and nothing is on file to clear it'}`,
    /** How the end-of-pass summary counts it. */
    summaryCount: (n) => `${n} conflict(s) STILL UNRESOLVED`,
  }),
  [VERDICT_KINDS.NO_OVERLAP]: Object.freeze({
    // UNREACHABLE THROUGH THE FILING GATE, and written truthfully anyway.
    // `shouldFileConflictTicket` returns false here, so no ticket is ever
    // filed off a proven no-overlap — a test pins that. These two entries
    // exist so that a future caller which reaches them cannot be handed a
    // sentence claiming a conflict nobody found; the whole class of defect
    // in this ticket is copy that outran its verdict.
    ticketName: (prNumber, where) => `Check why PR #${prNumber}${where} has not merged — no overlap was found`,
    handOver: 'Retrying it',
    filedWork: (prNumber) => `Retrying the merge of PR #${prNumber}`,
    stallHeadline: 'MERGE STILL NOT CLEARED',
    stallWhat: (prNumber) => `PR #${prNumber} was expected to clear itself`,
    stallWhy: (filed, age) => `no overlap was found, so every pass has been retrying the catch-up on its own — and it has not cleared in ${age}`,
    stallWhyAttempts: (filed, tries) => `no overlap was found, so every pass has retried the catch-up on its own — and it has now failed ${tries} times, which is no longer a stale answer clearing itself`,
    summaryCount: (n) => `${n} merge(s) STILL NOT CLEARED`,
  }),
  [VERDICT_KINDS.COULD_NOT_CHECK]: Object.freeze({
    // NOT "resolve" and NOT "conflict" — nothing has been established. The
    // work is to find out, and only then to act on the answer.
    ticketName: (prNumber, where) => `Find out why PR #${prNumber}${where} will not merge`,
    handOver: 'Finding out',
    filedWork: (prNumber) => `Finding out why PR #${prNumber} will not merge`,
    stallHeadline: 'MERGE STILL BLOCKED — THE CHECK NEVER RAN',
    stallWhat: (prNumber) => `PR #${prNumber} has been waiting for somebody to find out whether it conflicts at all`,
    stallWhy: (filed, age) => `ticket ${filed.id} has been open ${age} and nobody has established whether there is a conflict at all`,
    stallWhyAttempts: (filed, tries) => `this merge has now been blocked ${tries} times and the check has never once run, so nobody has established whether there is a conflict at all${filed ? ` — ticket ${filed.id} is on file` : ', and nothing is on file to find out'}`,
    summaryCount: (n) => `${n} merge(s) NEVER CHECKED`,
  }),
});

/** The words this verdict is entitled to. The ONE lookup — every surface goes
 *  through here rather than branching on an actor it cannot read the kind off
 *  of. */
function verdictCopy(localVerdict) {
  return WORK_VOCABULARY[conflictVerdictKind(localVerdict)];
}

/**
 * WHO ACTS NEXT — asked once, in one place (review round 3).
 *
 * The notice used to compute this inline and hand the answer down as a string,
 * which made `actor` the only thing the stall surfaces could see. Two values
 * of it (`loop-queue`, `nobody`) each cover two different verdicts, so those
 * surfaces were reading a two-valued shadow of a three-valued answer and
 * guessing the rest. Now every one of them takes the `localVerdict` itself and
 * derives BOTH facts from these two functions, so "who acts" and "what was
 * found" can never come apart: there is only one place either is decided.
 *
 *   'later-pass' — a proven no-overlap. The next relay pass retries and it
 *                  clears itself. A real actor with no ticket behind it.
 *   'loop-queue' — a ticket is on file; the build loop drains that list.
 *   'nobody'     — filing failed. Nothing is going to pick this up, and the
 *                  copy has to say so rather than reach for the passive voice.
 */
function conflictActor({ localVerdict, filed }) {
  if (isSelfHealing(localVerdict)) return 'later-pass';
  return filed ? 'loop-queue' : 'nobody';
}

/**
 * May the merge step file a Loop Queue ticket for this conflict?
 *
 * Everything except a proven no-overlap. A real conflict needs somebody to
 * decide what the merged file says; a check that could not run needs somebody
 * to find out WHY, and on 2026-08-31 that half was the regression — a
 * conflicting PR in another repo went from "filed, with a named actor" to
 * "nothing filed, and the bus told the room nobody needed to claim it".
 *
 * This is the SAME function `conflictHandOffNotice` reads to pick its actor,
 * which is what makes the ticket and the promise unable to name two different
 * people. One answer, read twice.
 */
function shouldFileConflictTicket(localVerdict) {
  return !isSelfHealing(localVerdict);
}

/**
 * The comment written on the ORIGINAL ticket, recording where the work now
 * lives — and calling that work what it actually is (review round 3). It said
 * "Resolving the conflict" for every verdict, including the ones where no
 * conflict had been established, which is the sentence the reader believes
 * before they ever click through to the ticket.
 *
 * The trail line above it is machine-read by `findConflictTicket` and does not
 * vary: one shape, written and read by this module, as in loopTrail.js.
 */
function conflictTicketFiledComment({ id, url, prNumber, localVerdict, refiledFrom = null }) {
  const work = verdictCopy(localVerdict).filedWork(prNumber);
  // A second conflict on the same PR (SP-100): say the first catch-up landed
  // and main moved again, so the reader knows why there is a new ticket.
  const again = refiledFrom
    ? ` The earlier catch-up, ticket ${refiledFrom.id}, was finished (it is in ${refiledFrom.status}), but \`main\` moved again and PR #${prNumber} conflicts again, so this is new work.`
    : '';
  return `${CONFLICT_TICKET_TRAIL} PR #${prNumber} — ${url}\n\n${work} is now ticket ${id} in the Loop Queue, which the build loop drains every pass.${again} This ticket stays in Ready to launch and needs nothing from you.`;
}

/**
 * Has a conflict ticket already been filed for this PR? Idempotency lives
 * here rather than in the caller because the merge step runs every pass: a
 * conflict that persists for a day would otherwise file twenty-four identical
 * tickets into the queue the build loop is trying to drain.
 */
function findConflictTicket(comments, prNumber) {
  for (const c of comments || []) {
    const m = CONFLICT_TICKET_RE.exec(String((c && c.comment_text) || ''));
    if (!m) continue;
    if (Number(m[1]) !== Number(prNumber)) continue;
    const url = m[2].replace(/[.,)]+$/, '');
    const id = url.split('/').filter(Boolean).pop();
    return { id, url, prNumber: Number(m[1]) };
  }
  return null;
}

/**
 * The filed ticket's name. Says the branch, because that is what the session
 * picking it up has to check out — and says the right VERB, which is the
 * defect review round 3 sent this back for. A ticket titled "Resolve the merge
 * conflict on PR #501" filed off a verdict that never looked sends its builder
 * hunting for conflict markers that may not exist, under a hand-off comment
 * two clicks away saying the question is still open.
 */
function conflictTicketName({ pr, branch, localVerdict }) {
  return verdictCopy(localVerdict).ticketName(pr.number, branch ? ` (${branch})` : '');
}

/**
 * The filed ticket's description. Written for the build loop that will claim
 * it: what is wrong, which branch, what "done" is, and — the part the bus post
 * never carried — that Dane's merge word is already given and must not be
 * asked for again.
 */
function conflictTicketBody({ task, pr, branch, localVerdict, commentId }) {
  // Three answers, three sentences. The middle one used to swallow the third:
  // a ticket filed off a `PUSH_FAILED` said the machine "could not check" when
  // it had checked and found nothing, and a ticket filed off `WRONG_REPO` says
  // it could not check, which is the truth. Only a real overlap gets to claim
  // the branches changed the same lines.
  const what = isRealOverlap(localVerdict)
    ? `This branch and \`main\` have both changed the same lines — ${localVerdict.reason}`
    : isSelfHealing(localVerdict)
      ? `GitHub called it a conflict, but the relay machine merged it here with no overlap at all — ${localVerdict.reason}`
      : localVerdict
        ? `GitHub called it a conflict and the relay machine could not check whether that is true — ${localVerdict.reason}${isPermanent(localVerdict) ? '. This will never clear from that machine on its own: it is the wrong checkout, so every future pass returns the same answer' : ''}`
        : 'GitHub reported that the branch conflicts with newer work on `main`, and no local check was attempted.';

  // THE JOB THIS TICKET IS ASKING FOR, and it is not the same job for all
  // three verdicts (review round 3, the blocking finding). "Resolve the
  // overlap by hand" was printed unconditionally — so a ticket filed because
  // the check could NOT run told its builder to clear markers whose existence
  // had never been established, while the comment that linked to it said the
  // question was still open. Deterministic for every `repo:normie`,
  // `repo:pulse` and `repo:vault` conflict, because that is `WRONG_REPO`.
  //
  // The real-overlap branch is the wording that shipped, unchanged.
  const where = branch || 'the branch';
  const realOverlap = isRealOverlap(localVerdict);
  const scope = realOverlap
    ? `Catch \`${where}\` up with \`main\`, resolve the overlap by hand, and push. Nothing else — this is not a licence to change what the PR does.`
    : `FIRST find out whether \`${where}\` and \`main\` actually conflict — the relay machine never established that. Then act on the answer: if they do overlap, resolve it by hand and push; if they do not, catch the branch up and push. Nothing else — this is not a licence to change what the PR does.${isPermanent(localVerdict) ? ` Do this on a machine that HAS a checkout of that repo; the relay machine does not, which is why the question is still open.` : ''}`;
  const criteria = realOverlap
    ? [`- [ ] The branch merges cleanly into \`main\` (\`git merge origin/main\` on the branch, no conflict markers left anywhere)`]
    : [
      `- [ ] The question is answered OUT LOUD first: run \`git merge-tree --write-tree origin/main origin/${where}\` (exit 0 means git found nothing to resolve) and say in a comment what it found`,
      `- [ ] The branch merges cleanly into \`main\` — resolve an overlap only if there turns out to be one; no conflict markers left anywhere`,
    ];

  return [
    '## What is wrong',
    '',
    what,
    '',
    `The merge step never resolves a conflict blind (task 86bbjd5nn, binding), so it filed this instead of guessing. This ticket IS the agent session the old bus post used to ask an empty room for (task 86bbq0fh8).`,
    '',
    '## The branch',
    '',
    `- PR: ${pr.url}`,
    branch ? `- Branch: \`${branch}\`` : '- Branch: read it off the PR.',
    `- Waiting ticket: ${task.url} — "${task.name}"`,
    '',
    '## Scope',
    '',
    scope,
    '',
    '## Acceptance criteria',
    '',
    ...criteria,
    '- [ ] Only ordinary pushes — merge `origin/main` in, never rebase-and-force (`docs/DOCTRINE.md` §6.6)',
    `- [ ] CI is green on PR #${pr.number}`,
    `- [ ] Nothing on ${task.url} is changed — its status stays Ready to launch`,
    '',
    `## Do NOT ask ${operatorName()} to say "merge" again`,
    '',
    `He already authorized it (his comment ${commentId} on ${task.url}). The merge marker there is re-decidable, so the next relay pass merges it on that original word the moment this branch is clean and green. Asking twice is the failure task 86bbk0g4u removed.`,
    '',
    '## How to test',
    '',
    `1. \`gh pr view ${pr.number} --json mergeable,mergeStateStatus\` — mergeable, not CONFLICTING.`,
    `2. \`npm run clickup -- bus-relay --dry-run --only-task ${task.id}\` — it must say it would merge, not hand off.`,
  ].join('\n');
}

/**
 * The PR a catch-up ticket was filed to unstick, read off the `- PR:` line
 * conflictTicketBody writes under "## The branch", as { url, owner, repo,
 * number }, or null when the description has no such line (SP-68). Read
 * here, beside the writer, so the two cannot drift apart. Such a ticket has
 * no PR of its own: its work lands when that PR merges.
 */
function unstuckPullRequest(description) {
  const text = String(description || '').replace(/\r\n?/g, '\n');
  const at = text.search(/^##\s+The branch\s*$/m);
  if (at === -1) return null;
  const section = text.slice(at).split('\n').slice(1);
  const end = section.findIndex((l) => /^##\s/.test(l));
  const m = /^\s*[-*]\s+PR:\s+(https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+))\b/m
    .exec((end === -1 ? section : section.slice(0, end)).join('\n'));
  return m ? { url: m[1], owner: m[2], repo: m[3], number: Number(m[4]) } : null;
}

/** "3 days", "26 hours", "40 minutes" — plain enough for a report line. */
function ageText(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 'an unknown time';
  const mins = Math.floor(n / 60000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Should this pass stay quiet about a hand-off it has already posted?
 *
 * The quiet path is the RIGHT behaviour — re-deriving the same answer every
 * pass says nothing new — and it is also exactly where the three days of
 * silence lived. So quiet is now conditional on there being a named actor and
 * on that actor being recent enough to still be plausible:
 *
 *   - no ticket filed          -> never quiet. Nothing is going to pick it up.
 *   - filed, under threshold   -> quiet. It is in the queue the loop drains.
 *   - filed, over threshold    -> not quiet. A day of no progress is news.
 *
 * `at` is the ISO timestamp off the merge marker the earlier pass wrote; an
 * unreadable or missing one counts as stalled, on the same fail-safe reasoning
 * as everywhere else here — "nobody is working on it" and "I cannot tell" look
 * identical, and only one of them is safe to sit on.
 *
 * `actor` (2026-08-31, task 86bbq80j5) is the notice's own answer to "who acts
 * next". It matters because `later-pass` is a NAMED, REAL actor with no ticket
 * behind it: the verdict said there is no overlap to resolve, so the next relay
 * pass retries the catch-up and it clears itself. Reading that as "no ticket,
 * therefore nobody" would nag the bus every ten minutes about a branch that is
 * healing on its own — the false-alarm class this ticket exists to remove. It
 * still stalls on AGE: a self-healing hand-off that has not healed in a day is
 * news, and the sentence says which of the two it is. Any other actor — and an
 * absent one — keeps the original filed-ticket rule, which fails toward noise.
 */
function handOffStalled({ at, now, filed, localVerdict, attempts }) {
  const actor = conflictActor({ localVerdict, filed });
  const tries = Number(attempts);
  // ATTEMPTS ARE CHECKED BEFORE ANYTHING THAT CAN RETURN (task 86bbvr0j5).
  // Placed after either guard below it would be unreachable in exactly the
  // case it exists for: a marker whose timestamp cannot be read already
  // returns stalled, and the age rule returns NOT stalled for everything
  // younger than a day — which is every repeated merge failure worth catching.
  // The count is the one signal that does not depend on the clock at all.
  if (Number.isFinite(tries) && tries >= MERGE_ATTEMPT_ALARM) {
    return {
      stalled: true,
      why: verdictCopy(localVerdict).stallWhyAttempts(filed, tries),
      ageMs: Number.isFinite(Date.parse(String(at || ''))) ? Number(now) - Date.parse(String(at || '')) : null,
      attempts: tries,
    };
  }
  if (!filed && actor !== 'later-pass') {
    return { stalled: true, why: 'no conflict ticket has been filed, so nothing is going to pick this up', ageMs: null, attempts: tries || 0 };
  }
  const then = Date.parse(String(at || ''));
  if (!Number.isFinite(then)) {
    return { stalled: true, why: 'the hand-off carries no readable timestamp, so its age cannot be checked', ageMs: null, attempts: tries || 0 };
  }
  const ageMs = Number(now) - then;
  if (ageMs < STALE_HAND_OFF_MS) return { stalled: false, ageMs, attempts: tries || 0 };
  // THE ACTOR DECIDES THE SENTENCE, NOT `filed` (review round 2).
  // `filed` records what a PAST pass found; `actor` is what THIS pass found,
  // and they can disagree: a real conflict files a ticket, the build loop
  // pushes a catch-up, and the next pass finds no overlap left while GitHub is
  // still stale. Reading `filed` there produced "was expected to clear itself"
  // beside "conflict ticket 86bbq6bam has been open 25 hours without clearing
  // this conflict" — two actors, one sentence, again.
  //
  // A self-healing hand-off that has not healed is still news; what it is NOT
  // is a conflict somebody is failing to resolve.
  // THE VERDICT DECIDES THE SENTENCE (review round 3). It read `actor`, which
  // is two-valued here — so a hand-off whose check never ran was described as
  // "a conflict ticket ... without clearing this conflict", naming a conflict
  // nobody had found. Three verdicts, three sentences, all from one table.
  return { stalled: true, why: verdictCopy(localVerdict).stallWhy(filed, ageText(ageMs)), ageMs, attempts: tries || 0 };
}

/**
 * The line a stalled hand-off puts in the pass report and on the bus. Names
 * the actor, or says plainly that there is not one.
 *
 * IT READS THE ACTOR, NOT `filed` (2026-08-31, task 86bbq80j5, review round 1).
 * Every other branch of the hand-off was converted to read the notice's actor;
 * this one was missed, and it is the branch that reaches the BUS. Before the
 * filing gate existed, `filed` was a safe stand-in for the actor here — a
 * conflict hand-off always had a ticket unless filing had actually failed, so
 * "NOT filed anywhere" was true whenever it printed. The gate created a second
 * way for `filed` to be null: the self-healing one, where the verdict found no
 * overlap and the actor is the next relay pass. Reaching this line down that
 * path produced one sentence naming two actors —
 *
 *     PR #444 has been waiting on a conflict resolution — NOT filed anywhere
 *     — no actor exists for it. no overlap was found, so every pass has been
 *     retrying the catch-up on its own — and it has not cleared in 25 hours.
 *
 * — which is the exact failure shape of the two comments 200ms apart that this
 * whole ticket exists to remove, arriving in the one place Dane actually
 * reads. `filed` still discriminates the other two actors; `later-pass` gets
 * its own clause, and it agrees with the `why` beside it.
 */
function stalledHandOffLine({ task, pr, filed, stalled, localVerdict }) {
  const selfHealing = isSelfHealing(localVerdict);
  // Three, not two (review round 3): "waiting on a conflict resolution" was
  // printed for a verdict that never looked for one.
  const what = verdictCopy(localVerdict).stallWhat(pr.number);
  // FOUR cases, because `filed` and `actor` are answers to different questions
  // and both can be true at once (review round 2). A ticket filed by an
  // earlier pass does not become "the actor" just because it is still open —
  // if this pass found no overlap, nothing is left for it to resolve, and the
  // line has to say both facts rather than pick whichever reads first.
  const who = selfHealing
    ? (filed
      ? `the earlier ticket ${filed.url} is still open, but this pass found no overlap left to resolve`
      : 'no ticket, and none is needed')
    : (filed
      ? `filed as ${filed.url}`
      : 'NOT filed anywhere — no actor exists for it');
  return `${task.id} ("${task.name}"): ${what} — ${who}. ${stalled.why}.`;
}

/**
 * The banner the bus post wears above that line. Actor-aware for the same
 * reason the line is: "CONFLICT STILL UNRESOLVED" over a body that says no
 * overlap was ever found is the contradiction one word higher up. A
 * self-healing hand-off that has not healed IS news — it just is not a
 * conflict, and calling it one sends a reader looking for markers to clear.
 */
function stalledHandOffHeadline({ localVerdict }) {
  return verdictCopy(localVerdict).stallHeadline;
}

/**
 * The same word problem one surface across: the END-OF-PASS summary, which
 * printed `CONFLICTS STILL UNRESOLVED` directly above the very lines saying no
 * overlap was found and every pass is retrying (review round 2, item 4).
 *
 * A pass can stall several hand-offs of different kinds at once, so this reads
 * all their actors rather than one. Mixed is a real case and gets its own
 * wording — collapsing it either way would be the same overstatement or
 * understatement the per-line banner was fixed for.
 */
function stalledSummaryHeadline(kinds) {
  const list = Array.isArray(kinds) ? kinds : [];
  // It read actors, where everything-but-`later-pass` was "a conflict" — so a
  // pass that stalled only on checks it could not run announced CONFLICTS
  // STILL UNRESOLVED above lines saying nothing had been checked (round 3).
  const real = list.includes(VERDICT_KINDS.REAL_CONFLICT);
  const never = list.includes(VERDICT_KINDS.COULD_NOT_CHECK);
  const healing = list.includes(VERDICT_KINDS.NO_OVERLAP);
  if (real && (never || healing)) return 'MERGES STILL NOT CLEARED — SOME ARE CONFLICTS, SOME ARE NOT';
  if (real) return 'CONFLICTS STILL UNRESOLVED';
  if (never && healing) return 'MERGES STILL NOT CLEARED — SOME WERE NEVER CHECKED';
  if (never) return 'MERGES STILL BLOCKED — THE CHECK NEVER RAN';
  return 'MERGES STILL NOT CLEARED';
}

/** The one-line clause in the pass summary, counting the two kinds apart so
 *  neither is described as the other. Empty at zero, as before. */
function stalledSummaryClause(kinds) {
  const list = Array.isArray(kinds) ? kinds : [];
  // Counted apart, in the fixed order real / never-checked / deferred, so no
  // group is ever described as one of the others. Each count is worded by the
  // same table the per-line banner reads.
  const order = [VERDICT_KINDS.REAL_CONFLICT, VERDICT_KINDS.COULD_NOT_CHECK, VERDICT_KINDS.NO_OVERLAP];
  const parts = order
    .map((kind) => [kind, list.filter((k) => k === kind).length])
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => WORK_VOCABULARY[kind].summaryCount(n));
  return parts.length ? `, ${parts.join(', ')}` : '';
}

module.exports = {
  CONFLICT_TICKET_TRAIL,
  VERDICT_KINDS,
  CATCH_UP_VERDICTS,
  verdictFromCatchUp,
  conflictVerdictKind,
  isRealOverlap,
  isSelfHealing,
  couldNotCheck,
  isPermanent,
  WORK_VOCABULARY,
  verdictCopy,
  conflictActor,
  shouldFileConflictTicket,
  CONFLICT_TICKET_RE,
  STALE_HAND_OFF_MS,
  MERGE_ATTEMPT_ALARM,
  conflictTicketFiledComment,
  findConflictTicket,
  conflictTicketName,
  conflictTicketBody,
  unstuckPullRequest,
  ageText,
  handOffStalled,
  stalledHandOffLine,
  stalledHandOffHeadline,
  stalledSummaryHeadline,
  stalledSummaryClause,
};
