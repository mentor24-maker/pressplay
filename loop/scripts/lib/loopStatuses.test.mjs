import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimOrder, isClaimableByBuild, isOperatorStatus, claimTier, compareWithinStatus, STAGE_ORDER, DISPLAY,
  REQUESTED, MACHINE_STATUSES, TERMINAL_STATUSES,
} from './loopStatuses.mjs';
import cjs from '../../lib/loopStatuses.js';

const t = (id, status, priority, created) => ({
  id, status: { status }, priority: priority ? { priority } : null, date_created: String(created),
});

test('claim order: every Rework before any Queued, rework oldest first ignoring priority', () => {
  const tasks = [
    t('q-high-old', 'Queued', 'high', 100),
    t('r-low-new', 'rework', 'low', 500),
    t('r-urgent-old', 'Rework', 'urgent', 400),
    t('q-normal-older', 'queued', 'normal', 50),
    t('building', 'Building', 'urgent', 1),
    t('r-none-oldest', 'Rework', null, 300),
  ];
  assert.deepEqual(claimOrder(tasks).map((x) => x.id), [
    'r-none-oldest', 'r-urgent-old', 'r-low-new', 'q-high-old', 'q-normal-older',
  ]);
});

test('queued tier: priority first, then oldest', () => {
  const tasks = [t('a', 'Queued', 'normal', 10), t('b', 'Queued', 'high', 20), t('c', 'Queued', null, 5)];
  assert.deepEqual(claimOrder(tasks).map((x) => x.id), ['b', 'a', 'c']);
});

test('only Rework and Queued are claimable; case does not matter', () => {
  assert.equal(isClaimableByBuild('REWORK'), true);
  assert.equal(isClaimableByBuild(' queued '), true);
  for (const s of ['Building', 'In review', 'Needs your input', 'Ready to launch', 'Live', '']) {
    assert.equal(isClaimableByBuild(s), false, s);
  }
  assert.equal(claimTier('Rework'), 0);
  assert.equal(claimTier('Queued'), 1);
  assert.equal(claimTier('Live'), null);
});

test('the two operator statuses are the only ones that hand work to Dane', () => {
  assert.equal(isOperatorStatus('Needs your input'), true);
  assert.equal(isOperatorStatus('ready to launch'), true);
  assert.equal(isOperatorStatus('In review'), false);
});

test('the board lists all eight statuses and DISPLAY spells each one', () => {
  assert.equal(STAGE_ORDER.length, 8);
  for (const name of STAGE_ORDER) assert.equal(DISPLAY[name.toLowerCase()], name);
});

test('both status modules spell the eight statuses the same, in the same order', () => {
  assert.deepEqual([...STAGE_ORDER], [...cjs.STAGE_ORDER]);
  assert.deepEqual({ ...DISPLAY }, { ...cjs.DISPLAY });
});

test('Requested is first, a machine status, and not claimable, not Dane\'s, not terminal', () => {
  assert.equal(STAGE_ORDER[0], 'Requested');
  assert.equal(DISPLAY[REQUESTED], 'Requested');
  assert.equal(isClaimableByBuild('Requested'), false);
  assert.equal(claimTier('requested'), null);
  assert.deepEqual(claimOrder([t('r', 'Requested', 'urgent', 1)]), []);
  assert.equal(isOperatorStatus('Requested'), false);
  assert.ok(MACHINE_STATUSES.includes(REQUESTED), 'a spec pass owns it');
  assert.ok(!TERMINAL_STATUSES.includes(REQUESTED));
});

test('claimOrder never mutates its input', () => {
  const tasks = [t('b', 'Queued', 'low', 2), t('a', 'Queued', 'high', 1)];
  const before = tasks.map((x) => x.id);
  claimOrder(tasks);
  assert.deepEqual(tasks.map((x) => x.id), before);
  assert.deepEqual([t('x', 'Queued', 'low', 1), t('y', 'Queued', 'high', 2)].sort(compareWithinStatus).map((x) => x.id), ['y', 'x']);
});
