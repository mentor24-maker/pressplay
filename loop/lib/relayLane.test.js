'use strict';

/**
 * relayLane tests, and the three acceptance scenarios of task 86bchpkxz run
 * through the SAME decision chain the `relay` command uses (mergeDecision,
 * then githubGate), with fixtures standing in for ClickUp and GitHub:
 *
 *   1. "merge it" from the operator on a Ready to launch ticket with a green,
 *      mergeable PR → merge.
 *   2. A merge phrase on a ticket whose PR is red, conflicting or unreviewed
 *      → no merge, and the reason names the gate.
 *   3. A comment that is not exactly a merge phrase ("merge PR #4") → nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PR_VIEW_FIELDS, markerBookkeeping, recordBookkeeping, emptyBooks, mergeDestination, relayLine,
} = require('./relayLane.js');
const { mergeDecision, githubGate, MERGE_MARKER } = require('./mergeOnComment.js');
const { stampMachineComment } = require('./machineComment.js');

const OPERATOR = 48012725;
const AGENT = 99999999;

let nextId = 1;
function c(t, userId, text) {
  return { id: String(nextId++), date: String(1000 + t), user: { id: userId }, comment_text: text };
}
const PR_URL = 'https://github.com/mentor24-maker/spirality/pull/4';
const prOpened = (t) => c(t, AGENT, `PR opened: ${PR_URL}`);
const reviewPassed = (t) => c(t, AGENT, 'REVIEW: PASSED — verified independently.');
const reviewFailed = (t) => c(t, AGENT, 'REVIEW: sent back to Rework — the test steps do not pass.');

const green = [{ __typename: 'CheckRun', name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const red = [{ __typename: 'CheckRun', name: 'verify', status: 'COMPLETED', conclusion: 'FAILURE' }];
const greenPr = { state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: green };

function decide(comments, status = 'Ready to launch', books = emptyBooks()) {
  return mergeDecision({ status, comments, operatorId: OPERATOR, ...books });
}

// --------------------------------------------------- acceptance scenarios

test('ACCEPTANCE 1: "merge it" on a green, mergeable PR merges in one pass', () => {
  const d = decide([prOpened(1), reviewPassed(2), c(3, OPERATOR, 'merge it')]);
  assert.equal(d.act, 'merge');
  assert.equal(d.pr.number, 4);
  assert.equal(githubGate(greenPr).action, 'merge');
});

test('ACCEPTANCE 2a: a merge phrase on a RED PR is refused, and the reason names the checks', () => {
  const d = decide([prOpened(1), reviewPassed(2), c(3, OPERATOR, 'merge')]);
  assert.equal(d.act, 'merge');
  const g = githubGate({ ...greenPr, statusCheckRollup: red });
  assert.equal(g.action, 'refuse');
  assert.match(g.reason, /checks are red: verify/);
  assert.ok(g.refusalCode, 'a refusal carries the code the notice is classified by');
});

test('ACCEPTANCE 2b: a merge phrase on a CONFLICTING PR is not merged, and the reason says conflict', () => {
  const d = decide([prOpened(1), reviewPassed(2), c(3, OPERATOR, 'ship it')]);
  assert.equal(d.act, 'merge');
  const g = githubGate({ ...greenPr, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  assert.equal(g.action, 'conflict');
  assert.match(g.reason, /CONFLICTING/);
});

test('ACCEPTANCE 2c: a merge phrase on an UNREVIEWED ticket is refused before GitHub is asked', () => {
  const noVerdict = decide([prOpened(1), c(3, OPERATOR, 'approve')]);
  assert.equal(noVerdict.act, 'refuse');
  assert.match(noVerdict.reason, /no review verdict/);

  const sentBack = decide([prOpened(1), reviewFailed(2), c(3, OPERATOR, 'approve')]);
  assert.equal(sentBack.act, 'refuse');
  assert.match(sentBack.reason, /not a PASS/);

  const stale = decide([prOpened(1), c(2, OPERATOR, 'merge'), reviewPassed(3)]);
  assert.equal(stale.act, 'refuse');
  assert.match(stale.reason, /predates/);
});

test('ACCEPTANCE 2d: a merge phrase on a ticket that is not Ready to launch does nothing', () => {
  const d = decide([prOpened(1), reviewPassed(2), c(3, OPERATOR, 'merge')], 'In review');
  assert.equal(d.act, 'ignore');
});

test('ACCEPTANCE 3: "merge PR #4" is not a merge phrase — nothing happens, nothing is posted', () => {
  for (const words of ['merge PR #4', 'merge #4', 'please merge', 'merge it when green', 'Merge PR #4.']) {
    const d = decide([prOpened(1), reviewPassed(2), c(3, OPERATOR, words)]);
    assert.equal(d.act, 'ignore', words);
    assert.match(d.reason, /no unhandled merge command/, words);
  }
});

test('a machine-posted "merge" never authorizes: the stamp makes it more than the phrase', () => {
  const d = decide([prOpened(1), reviewPassed(2), c(3, OPERATOR, stampMachineComment('merge'))]);
  assert.equal(d.act, 'ignore');
});

// ------------------------------------------------------ marker bookkeeping

const reply = (t, text) => ({ id: String(nextId++), date: String(1000 + t), comment_text: stampMachineComment(text) });

test('no replies: nothing handled, nothing refused', () => {
  assert.deepEqual(markerBookkeeping([]), { marker: null, handled: false, refused: null, refusedAt: '', refusedCount: 0 });
  assert.deepEqual(markerBookkeeping(undefined).handled, false);
});

test('a merged marker spends the authorization forever', () => {
  const k = markerBookkeeping([reply(1, `${MERGE_MARKER} merged PR #4 at 2026-10-13T20:00:00.000Z — 2026-10-13T20:00:00.000Z`)]);
  assert.equal(k.handled, true);
  assert.equal(k.refused, null);
});

test('a refused marker is re-decided: the reason, its time and its count come back', () => {
  const k = markerBookkeeping([
    reply(1, `${MERGE_MARKER} refused: checks are red: verify (FAILURE) — 2026-10-13T20:00:00.000Z`),
    reply(2, `${MERGE_MARKER} refused: checks are red: verify (FAILURE) — 2026-10-13T20:10:00.000Z`),
  ]);
  assert.equal(k.handled, false);
  assert.equal(k.refused, 'checks are red: verify (FAILURE)');
  assert.equal(k.refusedAt, '2026-10-13T20:10:00.000Z');
  assert.equal(k.refusedCount, 2);
});

test('the NEWEST marker decides: a refusal after a merge is not read back as merged', () => {
  const k = markerBookkeeping([
    reply(2, `${MERGE_MARKER} refused: checks are red: verify (FAILURE) — 2026-10-13T20:10:00.000Z`),
    reply(1, `${MERGE_MARKER} merged PR #4 at x — 2026-10-13T20:00:00.000Z`),
  ]);
  assert.equal(k.handled, false);
  assert.equal(k.refused, 'checks are red: verify (FAILURE)');
});

test('a prior refusal for the SAME reason quiets the decision; a different reason does not', () => {
  const comments = [prOpened(1), reviewFailed(2), c(3, OPERATOR, 'merge')];
  const auth = comments[2];
  const books = recordBookkeeping(emptyBooks(), auth.id, markerBookkeeping([
    reply(4, `${MERGE_MARKER} refused: the most recent review verdict is not a PASS — 2026-10-13T20:00:00.000Z`),
  ]));
  const quiet = decide(comments, 'Ready to launch', books);
  assert.equal(quiet.act, 'ignore');
  assert.match(quiet.reason, /already refused for the same reason/);

  const other = recordBookkeeping(emptyBooks(), auth.id, markerBookkeeping([
    reply(4, `${MERGE_MARKER} refused: checks are red: verify (FAILURE) — 2026-10-13T20:00:00.000Z`),
  ]));
  const loud = decide(comments, 'Ready to launch', other);
  assert.equal(loud.act, 'refuse');
  assert.equal(loud.priorRefusal, 'checks are red: verify (FAILURE)');
});

test('a spent authorization is skipped, so a merged PR is never re-decided', () => {
  const comments = [prOpened(1), reviewPassed(2), c(3, OPERATOR, 'merge')];
  const books = recordBookkeeping(emptyBooks(), comments[2].id, markerBookkeeping([
    reply(4, `${MERGE_MARKER} merged PR #4 at x — 2026-10-13T20:00:00.000Z`),
  ]));
  assert.equal(decide(comments, 'Ready to launch', books).act, 'ignore');
});

// -------------------------------------------------------- merge destination

test('no "Next slice:" line: the ticket closes as Live', () => {
  assert.equal(mergeDestination('## Goal\n\nShip the thing.\n').status, 'Live');
  assert.equal(mergeDestination('').status, 'Live');
  assert.equal(mergeDestination(null).status, 'Live');
});

test('a "Next slice:" line with content sends the ticket back to Queued for the next build pass', () => {
  const d = mergeDestination('## Slices\n\nSlice 1 is this PR.\n\nNext slice: the Needs your input hand-back, once busRelayPlan arrives.\n');
  assert.equal(d.status, 'Queued');
  assert.match(d.why, /Next slice: the Needs your input hand-back/);
});

test('the line is read whole-line and case-insensitively, with list and bold markers allowed', () => {
  assert.equal(mergeDestination('- **Next slice:** slice 3').status, 'Queued');
  assert.equal(mergeDestination('NEXT SLICE: slice 3').status, 'Queued');
});

test('"Next slice: none" (or done) means no next slice — Live', () => {
  for (const rest of ['none', 'None.', 'done', 'n/a', '']) {
    assert.equal(mergeDestination(`Next slice: ${rest}`).status, 'Live', rest);
  }
});

test('prose about slices is NOT a declaration: only the line moves a ticket', () => {
  const prose = 'The ticket returns to `Queued` after each slice merges, until slice 3 is in.';
  assert.equal(mergeDestination(prose).status, 'Live');
});

// ---------------------------------------------------------------- odds

test('PR_VIEW_FIELDS covers every field githubGate reads', () => {
  for (const f of ['state', 'isDraft', 'mergeable', 'mergeStateStatus', 'reviewDecision', 'statusCheckRollup']) {
    assert.ok(PR_VIEW_FIELDS.includes(f), f);
  }
});

test('relayLine is one tab-separated line a log reader can grep', () => {
  const line = relayLine({ task: { id: 'abc', name: 'Fix it' }, status: 'Ready to launch', outcome: 'would-merge', detail: 'PR #4' });
  assert.equal(line, 'abc\tReady to launch\twould-merge\tPR #4 "Fix it"');
  assert.equal(line.split('\n').length, 1);
});

// ------------------------------------------- the hand-back (slice 2)
//
// An answered `Needs your input` ticket, through the same two calls the
// `relay` command makes: handbackAnswer on the comments, then handbackPlan
// on that answer's reply thread and the PR's state.

const { BANNER_LABEL } = require('./operatorCard.js');
const { handHeldText, handbackDoneText, handbackFailureText } = require('./busRelayPlan.js');
const { handbackAnswer, handbackPlan } = require('./relayLane.js');
const { isMachineComment } = require('./machineComment.js');

const card = (t) => c(t, OPERATOR, stampMachineComment(`@@CONTEXT ...\n${BANNER_LABEL}Pick (a) or (b).`));
const NYI = 'Needs your input';

function handBack(comments, { replies = [], pr = null, status = NYI, description } = {}) {
  const verdict = handbackAnswer({ comments, operatorId: OPERATOR, isMachine: isMachineComment });
  return { verdict, plan: handbackPlan({ status, verdict, answerReplies: replies, pr, description }) };
}

test('HAND-BACK: his reply to the card, nothing built yet → Queued', () => {
  const { verdict, plan } = handBack([card(1), c(2, OPERATOR, 'a')]);
  assert.equal(verdict.state, 'answered');
  assert.equal(verdict.answer.comment_text, 'a');
  assert.deepEqual([plan.act, plan.target], ['move', 'Queued']);
});

test('HAND-BACK: an open PR behind the ticket → Rework; merged → Live; closed unmerged → Queued', () => {
  const comments = () => [prOpened(1), card(2), c(3, OPERATOR, 'go with (b)')];
  assert.equal(handBack(comments(), { pr: { number: 4, state: 'OPEN' } }).plan.target, 'Rework');
  assert.equal(handBack(comments(), { pr: { number: 4, state: 'MERGED' } }).plan.target, 'Live');
  assert.equal(handBack(comments(), { pr: { number: 4, state: 'CLOSED' } }).plan.target, 'Queued');
});

// 2026-10-26 (task 86bcrvwam): a multi-slice ticket asked a question between
// slices has the PREVIOUS slice's PR on it, already merged. The hand-back
// closed it; it must read the same "Next slice:" line the merge path reads.
test('HAND-BACK: merged PR but the description names a next slice → Queued, naming the line', () => {
  const comments = [prOpened(1), card(2), c(3, OPERATOR, '(a) more work first')];
  const description = '## Slices\n\nSlice 1 shipped as PR #5.\n\nNext slice: the runners and the watchdogs\n';
  const { plan } = handBack(comments, { pr: { number: 5, state: 'MERGED' }, description });
  assert.deepEqual([plan.act, plan.target], ['move', 'Queued']);
  assert.match(plan.why, /PR #5 is already merged/);
  assert.match(plan.why, /Next slice: the runners and the watchdogs/);
});

test('HAND-BACK: merged PR with "Next slice: none", or no line at all → still Live', () => {
  const comments = () => [prOpened(1), card(2), c(3, OPERATOR, 'a')];
  const pr = { number: 5, state: 'MERGED' };
  for (const description of ['Next slice: none', 'Next slice: done.', '## Goal\n\nShip it.\n', '', undefined]) {
    assert.equal(handBack(comments(), { pr, description }).plan.target, 'Live', String(description));
  }
});

test('HAND-BACK: "close it" closes a merged ticket whether or not a next slice is named', () => {
  const comments = () => [prOpened(1), card(2), c(3, OPERATOR, 'close it')];
  const pr = { number: 5, state: 'MERGED' };
  for (const description of ['Next slice: the runners and the watchdogs', 'Next slice: none', undefined]) {
    const { plan } = handBack(comments(), { pr, description });
    assert.deepEqual([plan.act, plan.target], ['move', 'Live'], String(description));
    assert.match(plan.why, /your answer says to close it/);
  }
});

test('HAND-BACK: a "Next slice:" line never overrides an OPEN PR (Rework) or a ticket with nothing built (Queued)', () => {
  const description = 'Next slice: slice 3';
  const comments = [prOpened(1), card(2), c(3, OPERATOR, 'b')];
  assert.equal(handBack(comments, { pr: { number: 4, state: 'OPEN' }, description }).plan.target, 'Rework');
  assert.equal(handBack([card(1), c(2, OPERATOR, 'b')], { description }).plan.target, 'Queued');
});

test('HAND-BACK: "close it" answering the card → Live, even with the PR open, and says the PR was left alone', () => {
  const { plan } = handBack([prOpened(1), card(2), c(3, OPERATOR, 'close it')], { pr: { number: 4, state: 'OPEN' } });
  assert.deepEqual([plan.act, plan.target], ['move', 'Live']);
  assert.match(plan.why, /PR #4 is still open and was not touched/);
});

test('HAND-BACK: "done" is NOT a close phrase — it goes by the PR', () => {
  assert.equal(handBack([card(1), c(2, OPERATOR, 'done')]).plan.target, 'Queued');
});

test('HAND-BACK: a PR whose state could not be read moves nothing', () => {
  const { plan } = handBack([prOpened(1), card(2), c(3, OPERATOR, 'b')], { pr: { number: 4, state: '', why: 'gh failed' } });
  assert.equal(plan.act, 'cannot-tell');
  assert.equal(plan.target, null);
  assert.match(plan.why, /gh failed/);
});

test('HAND-BACK: no reply newer than the card → waiting, no move', () => {
  const { plan } = handBack([c(1, OPERATOR, 'an older word'), card(2)]);
  assert.deepEqual([plan.act, plan.target], ['waiting', null]);
});

test('HAND-BACK: the card itself, posted under his token, is never read as his answer', () => {
  const { verdict, plan } = handBack([card(1)]);
  assert.equal(verdict.state, 'none');
  assert.equal(plan.act, 'waiting');
});

test('HAND-BACK: no machine-written card on the ticket → reported, never moved', () => {
  const { plan } = handBack([c(1, OPERATOR, 'close it')]);
  assert.deepEqual([plan.act, plan.target], ['no-card', null]);
  // A card he QUOTES is his text, not a machine card: still no card.
  const quoted = handBack([c(1, OPERATOR, `> ${BANNER_LABEL}Pick (a) or (b).\n\na`)]).plan;
  assert.equal(quoted.act, 'no-card');
});

test('HAND-BACK: a held-by-hand note newer than the card withholds the move', () => {
  const held = c(2, OPERATOR, stampMachineComment(handHeldText({ at: 'now' })));
  const { plan } = handBack([card(1), held, c(3, OPERATOR, 'a')]);
  assert.deepEqual([plan.act, plan.target], ['held', null]);
});

test('HAND-BACK: an answer whose reply thread says the hand-back already happened is spent', () => {
  const done = [{ id: 'r1', comment_text: stampMachineComment(handbackDoneText({ target: 'Queued', at: 'x' })) }];
  const { plan } = handBack([card(1), c(2, OPERATOR, 'a')], { replies: done });
  assert.deepEqual([plan.act, plan.target], ['handled', null]);
});

test('HAND-BACK: a FAILED earlier attempt is retried, and the failure note is not repeated', () => {
  const failed = [{ id: 'r1', comment_text: stampMachineComment(handbackFailureText({ target: 'Queued', why: 'HTTP 500' })) }];
  const { plan } = handBack([card(1), c(2, OPERATOR, 'a')], { replies: failed });
  assert.deepEqual([plan.act, plan.target], ['move', 'Queued']);
  assert.equal(plan.failureNoted, true);
});

test('HAND-BACK: an answer from an EARLIER round does not release a newer card', () => {
  const { plan } = handBack([card(1), c(2, OPERATOR, 'a'), card(3)]);
  assert.equal(plan.act, 'waiting');
});

test('HAND-BACK: a ticket not in Needs your input is never released', () => {
  const { plan } = handBack([card(1), c(2, OPERATOR, 'a')], { status: 'Ready to launch' });
  assert.equal(plan.act, 'skip');
  assert.equal(plan.target, null);
});

test('HAND-BACK: someone else\'s reply is not his answer', () => {
  assert.equal(handBack([card(1), c(2, AGENT, 'a')]).plan.act, 'waiting');
});

// ------------------------------------------- the conflict catch-up ticket (86bctbev9)

const { conflictFilingPlan } = require('./relayLane.js');
const {
  conflictTicketName, conflictTicketFiledComment, VERDICT_KINDS,
} = require('./conflictWork.js');
const { conflictHandOffNotice } = require('./mergeOnComment.js');

const CONFLICT_PR = { number: 12, url: 'https://github.com/mentor24-maker/spirality/pull/12' };
const CATCH_UP_NAME = conflictTicketName({ pr: CONFLICT_PR, branch: 'move-starcaster-modules', localVerdict: null });
const filedTrail = (t, id, prNumber = 12) => c(t, AGENT, conflictTicketFiledComment({
  id, url: `https://app.clickup.com/t/${id}`, prNumber, localVerdict: null,
}));

test('CONFLICT: a conflicting PR with nothing on file → file one catch-up ticket', () => {
  const plan = conflictFilingPlan({
    comments: [prOpened(1), reviewPassed(2), c(3, OPERATOR, 'merge')],
    prNumber: 12, queueTasks: [{ id: 'other', name: 'Something else' }], ticketName: CATCH_UP_NAME, localVerdict: null,
  });
  assert.equal(plan.act, 'file');
  assert.equal(plan.filed, null);
});

test('CONFLICT: the trail line on the ticket means it is already filed — however many passes run', () => {
  const comments = [prOpened(1), reviewPassed(2), c(3, OPERATOR, 'merge'), filedTrail(4, '86abc123')];
  for (let pass = 0; pass < 5; pass += 1) {
    const plan = conflictFilingPlan({ comments, prNumber: 12, queueTasks: [], ticketName: CATCH_UP_NAME, localVerdict: null, filedStatus: 'Queued' });
    assert.equal(plan.act, 'already-filed');
    assert.deepEqual(plan.filed, { id: '86abc123', url: 'https://app.clickup.com/t/86abc123' });
    assert.equal(plan.recorded, true);
  }
});

test('CONFLICT: a ticket filed whose trail line never posted is found by name in the queue, not filed again', () => {
  const plan = conflictFilingPlan({
    comments: [prOpened(1), c(3, OPERATOR, 'merge')],
    prNumber: 12,
    queueTasks: [{ id: '86twin', name: CATCH_UP_NAME, url: 'https://app.clickup.com/t/86twin', status: { status: 'queued' } }],
    ticketName: CATCH_UP_NAME,
    localVerdict: null,
  });
  assert.equal(plan.act, 'already-filed');
  assert.deepEqual(plan.filed, { id: '86twin', url: 'https://app.clickup.com/t/86twin' });
  assert.equal(plan.recorded, false, 'the caller still has to write the trail line');
});

test('CONFLICT: a trail line for a DIFFERENT PR does not count — a rebuilt PR gets its own ticket', () => {
  const plan = conflictFilingPlan({
    comments: [filedTrail(4, '86old', 11)], prNumber: 12, queueTasks: [], ticketName: CATCH_UP_NAME, localVerdict: null,
  });
  assert.equal(plan.act, 'file');
});

// SP-100: a catch-up ticket counts as "on file" only while a loop works it.
const { CATCH_UP_WORKED_STATUSES } = require('./relayLane.js');
const trackerTrail = (t, id) => c(t, AGENT, conflictTicketFiledComment({
  id, url: `http://mac-mini.local:4180/t/${id}`, prNumber: 12, localVerdict: null,
}));

test('CONFLICT (SP-100): a catch-up ticket in any worked status is on file', () => {
  assert.deepEqual([...CATCH_UP_WORKED_STATUSES].sort(), ['building', 'in review', 'queued', 'rework']);
  for (const filedStatus of ['Queued', 'Rework', 'Building', 'In review']) {
    const plan = conflictFilingPlan({ comments: [trackerTrail(4, 'SP-90')], prNumber: 12, queueTasks: [], ticketName: CATCH_UP_NAME, localVerdict: null, filedStatus });
    assert.equal(plan.act, 'already-filed', filedStatus);
    assert.equal(plan.refiledFrom, null);
  }
});

test('CONFLICT (SP-100): a catch-up ticket that left the loop does not block a new one', () => {
  for (const filedStatus of ['Ready to launch', 'Needs your input', 'Live']) {
    const plan = conflictFilingPlan({ comments: [trackerTrail(4, 'SP-90')], prNumber: 12, queueTasks: [], ticketName: CATCH_UP_NAME, localVerdict: null, filedStatus });
    assert.equal(plan.act, 'file', filedStatus);
    assert.equal(plan.refiledFrom.id, 'SP-90');
    assert.equal(plan.refiledFrom.status, filedStatus);
  }
});

test('CONFLICT (SP-100): a catch-up ticket that cannot be read is cannot-tell, never "on file"', () => {
  for (const filedStatus of [null, undefined, '']) {
    const plan = conflictFilingPlan({ comments: [trackerTrail(4, 'SP-90')], prNumber: 12, queueTasks: [], ticketName: CATCH_UP_NAME, localVerdict: null, filedStatus });
    assert.equal(plan.act, 'cannot-tell');
    assert.equal(plan.filed.id, 'SP-90');
  }
});

test('CONFLICT (SP-100): the finished catch-up is not its own twin — same name in Ready to launch still files', () => {
  const plan = conflictFilingPlan({
    comments: [trackerTrail(4, 'SP-90')], prNumber: 12,
    queueTasks: [{ id: 'SP-90', name: CATCH_UP_NAME, status: { status: 'ready to launch' } }],
    ticketName: CATCH_UP_NAME, localVerdict: null, filedStatus: 'Ready to launch',
  });
  assert.equal(plan.act, 'file');
  const noTrail = conflictFilingPlan({
    comments: [], prNumber: 12,
    queueTasks: [{ id: 'SP-90', name: CATCH_UP_NAME, status: { status: 'live' } }],
    ticketName: CATCH_UP_NAME, localVerdict: null,
  });
  assert.equal(noTrail.act, 'file', 'a same-named ticket that is Live is not open work');
});

test('CONFLICT (SP-100): the SP-84 / SP-90 sequence files a second ticket exactly once across passes', () => {
  // The world the relay sees: the waiting ticket's comments (newest first)
  // and every ticket's status. One pass = one plan, carried out.
  const statuses = new Map();
  let comments = [prOpened(1), reviewPassed(2), c(3, OPERATOR, 'merge')];
  let nextId = 90;
  const filings = [];
  const pass = () => {
    const trail = require('./conflictWork.js').findConflictTicket(comments, 12);
    const filedStatus = trail ? statuses.get(trail.id) ?? null : null;
    const queueTasks = [...statuses].map(([id, st]) => ({ id, name: CATCH_UP_NAME, status: { status: st } }));
    const plan = conflictFilingPlan({ comments, prNumber: 12, queueTasks, ticketName: CATCH_UP_NAME, localVerdict: null, filedStatus });
    if (plan.act === 'file') {
      const id = `SP-${nextId++}`;
      statuses.set(id, 'queued');
      filings.push({ id, refiledFrom: plan.refiledFrom });
      comments = [trackerTrail(100 + filings.length, id), ...comments];
    }
    return plan;
  };

  // First conflict: one ticket, however many passes.
  for (let i = 0; i < 4; i += 1) pass();
  assert.deepEqual(filings.map((f) => f.id), ['SP-90']);

  // The build loop catches the PR up; review passes it; it parks in Ready to launch.
  statuses.set('SP-90', 'building');
  pass();
  statuses.set('SP-90', 'in review');
  pass();
  statuses.set('SP-90', 'ready to launch');
  assert.equal(filings.length, 1, 'no second ticket while the first was still being worked');

  // main moves again and the PR conflicts a second time: exactly one new ticket.
  for (let i = 0; i < 6; i += 1) pass();
  assert.deepEqual(filings.map((f) => f.id), ['SP-90', 'SP-91']);
  assert.deepEqual(filings[1].refiledFrom, { id: 'SP-90', url: 'http://mac-mini.local:4180/t/SP-90', status: 'Ready to launch' });
  assert.equal(pass().act, 'already-filed');
  assert.equal(pass().filed.id, 'SP-91');
});

test('CONFLICT (SP-100): a re-filing whose trail did not post is found by name, not filed a third time', () => {
  const plan = conflictFilingPlan({
    comments: [trackerTrail(4, 'SP-90')], prNumber: 12,
    queueTasks: [
      { id: 'SP-90', name: CATCH_UP_NAME, status: { status: 'ready to launch' } },
      { id: 'SP-91', name: CATCH_UP_NAME, url: 'http://mac-mini.local:4180/t/SP-91', status: { status: 'queued' } },
    ],
    ticketName: CATCH_UP_NAME, localVerdict: null, filedStatus: 'Ready to launch',
  });
  assert.equal(plan.act, 'already-filed');
  assert.equal(plan.filed.id, 'SP-91');
  assert.equal(plan.recorded, false);
  assert.equal(plan.refiledFrom.id, 'SP-90', 'the trail line still says why there is a second ticket');
});

test('CONFLICT (SP-100): the re-filed trail line says the first catch-up landed and main moved again, and still parses', () => {
  const body = conflictTicketFiledComment({
    id: 'SP-91', url: 'http://mac-mini.local:4180/t/SP-91', prNumber: 12, localVerdict: null,
    refiledFrom: { id: 'SP-90', status: 'Ready to launch' },
  });
  assert.match(body, /is now ticket SP-91/);
  assert.match(body, /earlier catch-up, ticket SP-90, was finished \(it is in Ready to launch\), but `main` moved again/);
  assert.equal(require('./conflictWork.js').findConflictTicket([c(1, AGENT, body)], 12).id, 'SP-91');
  const first = conflictTicketFiledComment({ id: 'SP-90', url: 'http://mac-mini.local:4180/t/SP-90', prNumber: 12, localVerdict: null });
  assert.doesNotMatch(first, /moved again/);
});

test('CONFLICT (SP-100): the relay reads the filed ticket\'s status and reports an unreadable one as unchecked', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'scripts', 'clickup.mjs'), 'utf8');
  assert.match(src, /conflictFilingPlan\(\{[^}]*filedStatus \}\)/);
  assert.match(src, /readTaskOrNull\(trail\.id\)/);
  assert.match(src, /if \(plan\.act === 'cannot-tell'\) \{\s*unchecked\.push\(`\$\{task\.id\}: PR #\$\{pr\.number\} conflicts, and the catch-up ticket on file/);
  assert.match(src, /recordCatchUp\(task, filed, pr\.number, plan\.refiledFrom\)/);
});

test('CONFLICT: a proven no-overlap files nothing (the next pass clears it itself)', () => {
  const clean = { kind: VERDICT_KINDS.NO_OVERLAP, reason: 'merged cleanly' };
  const plan = conflictFilingPlan({ comments: [], prNumber: 12, queueTasks: [], ticketName: CATCH_UP_NAME, localVerdict: clean });
  assert.equal(plan.act, 'none');
});

test('CONFLICT: the notice says filing failed only when nothing is on file, and names the ticket when one is', () => {
  const failed = conflictHandOffNotice({ commentId: '7', pr: CONFLICT_PR, localVerdict: null, filed: null });
  assert.match(failed.body, /did not succeed/);
  const filed = conflictHandOffNotice({ commentId: '7', pr: CONFLICT_PR, localVerdict: null, filed: { id: '86abc123', url: 'https://app.clickup.com/t/86abc123' } });
  assert.doesNotMatch(filed.body, /did not succeed/);
  assert.match(filed.body, /ticket 86abc123/);
  assert.equal(filed.marker, failed.marker, 'the marker does not depend on the filing, so the quiet check reads one reason');
});

test('CONFLICT: the catch-up ticket names the branch, and the "now ticket" comment keeps the ticket in Ready to launch', () => {
  assert.match(CATCH_UP_NAME, /PR #12 \(move-starcaster-modules\)/);
  const body = conflictTicketFiledComment({ id: '86abc123', url: 'https://app.clickup.com/t/86abc123', prNumber: 12, localVerdict: null });
  assert.match(body, /is now ticket 86abc123 in the Loop Queue/);
  assert.match(body, /stays in Ready to launch/);
});

test('PR_VIEW_FIELDS asks for the branch name the catch-up ticket carries', () => {
  assert.ok(PR_VIEW_FIELDS.includes('headRefName'));
});

// ── closePlan: his close word on a Ready to launch ticket (SP-68) ──────────

{
  const { closePlan } = require('./relayLane.js');
  const { closeRefusedText, handbackDoneText } = require('./busRelayPlan.js');
  const answered = (text = 'close') => ({ state: 'answered', answer: { id: 'a1', comment_text: text } });
  const merged = { number: 7, state: 'MERGED' };
  const open = { number: 7, state: 'OPEN' };

  test('a close word moves the ticket to Live when its own PR, or the PR it unstuck, is merged', () => {
    const own = closePlan({ verdict: answered(), answerReplies: [], ownPr: merged, unstuckPr: null });
    assert.deepEqual([own.act, own.target], ['move', 'Live']);
    assert.match(own.why, /its own PR #7 is merged/);
    const unstuck = closePlan({ verdict: answered('close it'), answerReplies: [], ownPr: null, unstuckPr: merged });
    assert.deepEqual([unstuck.act, unstuck.target], ['move', 'Live']);
    assert.match(unstuck.why, /filed to unstick, is merged/);
  });

  test('its own PR decides when it has one: an open own PR is not closed on a merged unstuck one', () => {
    const plan = closePlan({ verdict: answered(), answerReplies: [], ownPr: open, unstuckPr: merged });
    assert.equal(plan.act, 'refuse');
    assert.match(plan.why, /its own PR #7 is still open/);
  });

  test('work that is not merged is refused with the reason, and the same reason is not said twice', () => {
    for (const [pr, why] of [[open, /still open/], [{ number: 7, state: 'CLOSED' }, /closed without merging/]]) {
      const plan = closePlan({ verdict: answered(), answerReplies: [], ownPr: null, unstuckPr: pr });
      assert.equal(plan.act, 'refuse');
      assert.match(plan.why, why);
      const again = closePlan({ verdict: answered(), answerReplies: [{ comment_text: closeRefusedText({ why: plan.why, at: 'now' }) }], ownPr: null, unstuckPr: pr });
      assert.equal(again.act, 'refused-quiet');
    }
    const none = closePlan({ verdict: answered(), answerReplies: [], ownPr: null, unstuckPr: null });
    assert.equal(none.act, 'refuse');
    assert.match(none.why, /no pull request of its own and names none/);
    // A reason that changed is said again.
    const changed = closePlan({ verdict: answered(), answerReplies: [{ comment_text: closeRefusedText({ why: 'something older' }) }], ownPr: null, unstuckPr: open });
    assert.equal(changed.act, 'refuse');
  });

  test('the refusal reply promises a later close only while the PR is still open', () => {
    const cases = [
      [{ ownPr: open, unstuckPr: null }, true],
      [{ ownPr: null, unstuckPr: open }, true],
      [{ ownPr: { number: 7, state: 'CLOSED' }, unstuckPr: null }, false],
      [{ ownPr: null, unstuckPr: { number: 7, state: 'CLOSED' } }, false],
      [{ ownPr: null, unstuckPr: null }, false],
    ];
    for (const [prs, pending] of cases) {
      const plan = closePlan({ verdict: answered(), answerReplies: [], ...prs });
      assert.equal(plan.act, 'refuse', JSON.stringify(prs));
      assert.equal(plan.pending, pending, JSON.stringify(prs));
      const text = closeRefusedText({ why: plan.why, pending: plan.pending, at: 'now' });
      if (pending) {
        assert.match(text, /still stands: the first relay pass after its work is merged moves it to Live/);
        assert.doesNotMatch(text, /cannot move it/);
      } else {
        assert.doesNotMatch(text, /still stands|after its work is merged/, JSON.stringify(prs));
        assert.match(text, /cannot move it\. To finish it, tell a session to close it by hand, or reply here/);
      }
      // The reason still reads back off either wording, so it is said once.
      const again = closePlan({ verdict: answered(), answerReplies: [{ comment_text: text }], ...prs });
      assert.equal(again.act, 'refused-quiet', JSON.stringify(prs));
    }
  });

  test('a PR that could not be read is cannot-tell, never a guess', () => {
    const plan = closePlan({ verdict: answered(), answerReplies: [], ownPr: { number: 7, state: '', why: 'gh failed' }, unstuckPr: null });
    assert.equal(plan.act, 'cannot-tell');
    assert.match(plan.why, /gh failed/);
  });

  test('the hand-back\'s rules: no card, a hold, no answer, another word or a spent answer leave it to the merge step', () => {
    for (const verdict of [{ state: 'no-question' }, { state: 'hand-held', answer: { comment_text: 'close' } }, { state: 'none' }, answered('merge'), answered('please close this when the PR lands')]) {
      assert.equal(closePlan({ verdict, answerReplies: [], ownPr: merged }).act, 'not-close', JSON.stringify(verdict));
    }
    const spent = [{ comment_text: handbackDoneText({ target: 'Live' }) }];
    assert.equal(closePlan({ verdict: answered(), answerReplies: spent, ownPr: merged }).act, 'not-close');
  });
}
