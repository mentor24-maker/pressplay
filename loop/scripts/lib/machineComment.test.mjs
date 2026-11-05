import test from 'node:test';
import assert from 'node:assert/strict';
import { stampCommentBody, isMachineComment, stripMachineMarker, isCommentPostPath, MACHINE_MARKER_LINE } from './machineComment.mjs';
import { operatorSpokeLast } from './loopTrail.mjs';

test('a plain comment body is stamped once, and the stamp is recognised', () => {
  const once = stampCommentBody({ comment_text: 'PR opened: https://github.com/o/r/pull/1' });
  assert.ok(once.comment_text.endsWith(MACHINE_MARKER_LINE));
  const twice = stampCommentBody(once);
  assert.equal(twice.comment_text, once.comment_text);
  assert.equal(isMachineComment(once.comment_text), true);
  assert.equal(isMachineComment('merge'), false);
  assert.equal(stripMachineMarker(once.comment_text), 'PR opened: https://github.com/o/r/pull/1');
});

test('a structured (card) body is stamped as a trailing run', () => {
  const body = stampCommentBody({ comment: [{ text: 'hello', attributes: { bold: true } }] });
  assert.equal(body.comment.length, 2);
  assert.ok(body.comment[1].text.includes(MACHINE_MARKER_LINE));
  assert.equal(isMachineComment(body.comment.map((r) => r.text).join('')), true);
});

test('only task comment posts and threaded replies are stamped', () => {
  assert.equal(isCommentPostPath('/api/v2/task/abc/comment'), true);
  assert.equal(isCommentPostPath('/api/v2/comment/123/reply'), true);
  assert.equal(isCommentPostPath('/api/v2/task/abc'), false);
  assert.equal(isCommentPostPath('/api/v2/comment/123'), false);
  assert.equal(stampCommentBody({ status: 'Queued' }).status, 'Queued');
});

test("a stamped comment under Dane's seat does not count as Dane speaking", () => {
  const dane = 48012725;
  const machine = { id: 1, comment_text: stampCommentBody({ comment_text: 'REVIEW: PASSED' }).comment_text, date: '20', user: { id: dane } };
  const his = { id: 2, comment_text: 'merge', date: '10', user: { id: dane } };
  assert.equal(operatorSpokeLast([his, machine], dane), false);
  assert.equal(operatorSpokeLast([machine, { ...his, date: '30' }], dane), true);
});
