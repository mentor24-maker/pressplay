'use strict';

/**
 * commentPages tests (task 86bchpkxz, review round 1): the hand-back reads a
 * ticket's `PR opened:` line, the OLDEST thing it needs, and ClickUp's first
 * page holds only the newest 25 comments. A PR line on page two must still
 * be found, or merged or open work is sent back to Queued.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { COMMENT_PAGE_SIZE, pageComments } = require('./commentPages.js');
const { findPullRequest } = require('./mergeOnComment.js');

const PR_LINE = 'PR opened: https://github.com/example/repo/pull/8';

/** A trail of `n` comments, oldest first, served newest-first in pages of 25
 *  the way ClickUp does, honouring start/start_id. */
function fakeClickUp(trail) {
  const newestFirst = [...trail].reverse();
  const paths = [];
  const get = async (path) => {
    paths.push(path);
    const m = /start_id=([^&]+)/.exec(path);
    const from = m ? newestFirst.findIndex((x) => x.id === decodeURIComponent(m[1])) + 1 : 0;
    return { ok: true, json: { comments: newestFirst.slice(from, from + COMMENT_PAGE_SIZE) } };
  };
  return { get, paths };
}

function trailOf(n, firstText) {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`, date: String(1000 + i), user: { id: 1 }, comment_text: i === 0 ? firstText : `note ${i}`,
  }));
}

test('a PR line only page two holds is found once the trail is paged', async () => {
  const trail = trailOf(29, PR_LINE);
  const { get, paths } = fakeClickUp(trail);
  const firstPage = (await get('/api/v2/task/t/comment')).json.comments;
  assert.equal(findPullRequest(firstPage), null, 'the unpaged read misses it — the defect');

  paths.length = 0;
  const out = await pageComments({ get, taskId: 't' });
  assert.equal(out.complete, true);
  assert.equal(out.comments.length, 29);
  assert.equal(paths.length, 2);
  assert.match(paths[1], /\?start=1004&start_id=c4$/, 'seeded from the oldest comment of page one');
  assert.equal(findPullRequest(out.comments).number, 8);
});

test('a short first page is the whole trail: one request', async () => {
  const { get, paths } = fakeClickUp(trailOf(12, PR_LINE));
  const out = await pageComments({ get, taskId: 't' });
  assert.equal(out.complete, true);
  assert.equal(out.comments.length, 12);
  assert.equal(paths.length, 1);
});

test('exactly 25 comments costs one more read, which comes back empty', async () => {
  const { get, paths } = fakeClickUp(trailOf(25, PR_LINE));
  const out = await pageComments({ get, taskId: 't' });
  assert.equal(out.complete, true);
  assert.equal(out.comments.length, 25);
  assert.equal(paths.length, 2);
});

test('a failed second page is INCOMPLETE, never a short trail that looks whole', async () => {
  const { get: real } = fakeClickUp(trailOf(40, PR_LINE));
  let n = 0;
  const get = async (p) => (n++ === 0 ? real(p) : { ok: false, json: null });
  const out = await pageComments({ get, taskId: 't' });
  assert.equal(out.complete, false);
  assert.equal(out.comments.length, 25);
  assert.deepEqual(out.failed, { ok: false, json: null });
});

test('a page with no cursor on its oldest comment stops, reported as capped', async () => {
  const page = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, comment_text: 'x' }));
  const out = await pageComments({ get: async () => ({ ok: true, json: { comments: page } }), taskId: 't' });
  assert.equal(out.complete, false);
  assert.equal(out.capped, true);
});

test('maxPages caps a trail that never ends', async () => {
  let i = 0;
  const get = async () => ({
    ok: true,
    json: { comments: Array.from({ length: 25 }, () => ({ id: `c${i}`, date: String(i++), comment_text: 'x' })) },
  });
  const out = await pageComments({ get, taskId: 't', maxPages: 3 });
  assert.equal(out.complete, false);
  assert.equal(out.capped, true);
  assert.equal(out.comments.length, 75);
});
