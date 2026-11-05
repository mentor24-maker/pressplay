import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prOpenedComment, verdictComment, findPullRequest, prTrailLanded, bodyNamesTicket,
  readyToLaunchGate, sendBackRounds, wouldEscalate, roundSummaryLines, operatorSpokeLast, isReviewVerdict,
} from './loopTrail.mjs';

const c = (id, text, date, userId = 54254347) => ({ id, comment_text: text, date: String(date), user: { id: userId } });

test('the PR trail is written by one function and read back by the other', () => {
  const comments = [c(1, prOpenedComment('https://github.com/mentor24-maker/spirality/pull/7'), 10)];
  const found = findPullRequest(comments);
  assert.equal(found.number, 7);
  assert.equal(found.owner, 'mentor24-maker');
  assert.equal(prTrailLanded(comments, 7).ok, true);
  assert.equal(prTrailLanded(comments, 8).ok, false);
  assert.equal(prTrailLanded([], 7).ok, false);
});

test('a PR line carrying a human-hours estimate still verifies and passes review the same way (SP-78)', () => {
  const comments = [
    c(1, prOpenedComment('https://github.com/o/r/pull/7', 'Why: one module.', { humanHours: 2.5 }), 10),
    c(2, verdictComment(true, 'All good.'), 20),
  ];
  assert.match(comments[0].comment_text, /^PR opened: https:\/\/github\.com\/o\/r\/pull\/7\nHuman-hours estimate: 2\.5\n\nWhy/);
  assert.equal(findPullRequest(comments).number, 7);
  assert.equal(prTrailLanded(comments, 7).ok, true);
  assert.equal(readyToLaunchGate(comments).ok, true);
  assert.equal(prOpenedComment('https://github.com/o/r/pull/7'), 'PR opened: https://github.com/o/r/pull/7');
});

test('the newest PR line wins', () => {
  const comments = [
    c(1, 'PR opened: https://github.com/o/r/pull/1', 10),
    c(2, 'PR opened: https://github.com/o/r/pull/2', 20),
  ];
  assert.equal(findPullRequest(comments).number, 2);
});

test('a PR body names its ticket by either ClickUp link shape', () => {
  assert.equal(bodyNamesTicket('ClickUp: https://app.clickup.com/t/86c12abcd', '86c12abcd'), true);
  assert.equal(bodyNamesTicket('see https://app.clickup.com/t/90141423066/86c12abcd', '86c12abcd'), true);
  assert.equal(bodyNamesTicket('https://app.clickup.com/t/86c12abcde', '86c12abcd'), false);
  assert.equal(bodyNamesTicket('no link here', '86c12abcd'), false);
  assert.equal(bodyNamesTicket('anything', ''), false);
});

test('a PR body names a tracker ticket by the tracker link or the ClickUp link, never a neighbour (SP-32)', () => {
  const opts = { tracker: 'api', trackerPrefix: 'SP', trackerUrl: 'http://mac-mini.local:4180' };
  for (const body of ['Ticket: http://mac-mini.local:4180/tickets/SP-12', 'ClickUp: https://app.clickup.com/t/SP-12']) {
    assert.equal(bodyNamesTicket(body, 'SP-12', opts), true, body);
    assert.equal(bodyNamesTicket(body, 'SP-1', opts), false, `${body} does not name SP-1`);
  }
  // A ClickUp ticket is read as before when no tracker is configured.
  assert.equal(bodyNamesTicket('ClickUp: https://app.clickup.com/t/86c12abcd', '86c12abcd', { tracker: 'clickup' }), true);
});

test('Ready to launch needs the NEWEST verdict to be a PASS', () => {
  assert.equal(readyToLaunchGate([]).ok, false);
  const passThenFail = [c(1, verdictComment(true, 'all gates green'), 10), c(2, verdictComment(false, 'test missing'), 20)];
  assert.equal(readyToLaunchGate(passThenFail).ok, false);
  const failThenPass = [c(1, verdictComment(false, 'test missing'), 10), c(2, verdictComment(true, 'fixed'), 20)];
  assert.equal(readyToLaunchGate(failThenPass).ok, true);
  assert.equal(readyToLaunchGate(failThenPass).verdictId, '2');
  assert.equal(isReviewVerdict('REVIEW: PASSED'), true);
  assert.equal(isReviewVerdict('I reviewed it and it passed'), false);
});

test('send-back rounds are counted and the fourth escalates', () => {
  const rounds = [
    c(1, verdictComment(false, 'first reason'), 10),
    c(2, verdictComment(false, 'second reason'), 20),
  ];
  assert.equal(sendBackRounds(rounds), 2);
  assert.equal(wouldEscalate(rounds), false);
  rounds.push(c(3, verdictComment(false, 'third reason'), 30));
  assert.equal(wouldEscalate(rounds), true);
  assert.deepEqual(roundSummaryLines(rounds), ['round 1: first reason', 'round 2: second reason', 'round 3: third reason']);
});

test('operatorSpokeLast keys on the user id of the newest comment', () => {
  const dane = 48012725;
  assert.equal(operatorSpokeLast([c(1, 'machine', 10), c(2, 'answer: A', 20, dane)], dane), true);
  assert.equal(operatorSpokeLast([c(1, 'answer: A', 10, dane), c(2, 'machine', 20)], dane), false);
  assert.equal(operatorSpokeLast([], dane), false);
});
