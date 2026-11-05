'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readWaitsOn, waitsOn, waitsOnText, holdReasons } = require('./waitsOn.js');

test('a Waits on: line names the ticket it waits on', () => {
  assert.deepEqual(waitsOn('## Goal\nBuild it.\n\nWaits on: 86bctbf46\n'), ['86bctbf46']);
});

test('a tracker id waits as itself, any case (SP-32)', () => {
  assert.deepEqual(waitsOn('Waits on: SP-12'), ['sp-12']);
  assert.deepEqual(waitsOn('- **Waits on:** SP-12, sp-3'), ['sp-12', 'sp-3']);
});

test('several ids and links on one line, any letter case, no repeats', () => {
  const body = 'WAITS ON: https://app.clickup.com/t/86bctbf46, 86BCTBW76, https://app.clickup.com/t/90141423066/86bctbw76';
  assert.deepEqual(waitsOn(body), ['86bctbf46', '86bctbw76']);
});

test('several Waits on: lines add up', () => {
  assert.deepEqual(waitsOn('Waits on: aaa1\ntext\n  Waits on: bbb2'), ['aaa1', 'bbb2']);
});

test('a tracker-style id is accepted', () => {
  assert.deepEqual(waitsOn('Waits on: SP-12'), ['sp-12']);
});

test('formatting around an id is ignored', () => {
  assert.deepEqual(waitsOn('Waits on: `86bctbf46`.'), ['86bctbf46']);
});

test('prose that mentions waiting is not a declaration', () => {
  assert.deepEqual(waitsOn('This waits on: nothing in particular, it just reads that way.'), []);
  assert.deepEqual(waitsOn('It waits on the API ticket.'), []);
  assert.deepEqual(waitsOn(''), []);
  assert.deepEqual(waitsOn(undefined), []);
});

test('a list marker, bold, italic or quote around the marker still counts (the markdown keeps them)', () => {
  for (const line of ['*   Waits on: aaa1', '- Waits on: aaa1', '+ Waits on: aaa1', '1. Waits on: aaa1',
    '**Waits on:** aaa1', '*Waits on:* aaa1', '> Waits on: aaa1', '> - **Waits on:** `aaa1`', '**Waits on: aaa1**']) {
    assert.deepEqual(readWaitsOn(`## Scope\n${line}\n`), { ids: ['aaa1'], unparsed: [] }, line);
  }
});

test('a link in angle brackets or a markdown link is read', () => {
  assert.deepEqual(waitsOn('Waits on: <https://app.clickup.com/t/aaa1>, [x](https://app.clickup.com/t/9/bbb2)'), ['aaa1', 'bbb2']);
});

test('a Waits on: line naming something that is not an id is reported, never dropped', () => {
  assert.deepEqual(readWaitsOn('Waits on: the API ticket').unparsed, ['the API ticket']);
  assert.deepEqual(readWaitsOn('Waits on: aaa1 (the API ticket)').unparsed, ['aaa1 (the API ticket)']);
  assert.deepEqual(readWaitsOn('Waits on: aaa1 and bbb2').unparsed, ['aaa1 and bbb2']);
  assert.deepEqual(readWaitsOn('Waits on: aaa1; bbb2').unparsed, ['aaa1; bbb2']);
  assert.deepEqual(readWaitsOn('Waits on: aaa1 and https://app.clickup.com/t/bbb2').unparsed, ['aaa1 and https://app.clickup.com/t/bbb2']);
  assert.deepEqual(readWaitsOn('- **Waits on:**').unparsed, ['(nothing named)']);
  assert.deepEqual(readWaitsOn('Waits on: aaa1, the API one'), { ids: ['aaa1'], unparsed: ['the API one'] });
});

test('queue and claim read the same text: markdown first, plain as the fallback', () => {
  assert.equal(waitsOnText({ markdown_description: '- Waits on: aaa1', description: 'Waits on: aaa1' }), '- Waits on: aaa1');
  assert.equal(waitsOnText({ description: 'Waits on: aaa1' }), 'Waits on: aaa1');
  assert.equal(waitsOnText({}), '');
});

test('only prerequisites still open hold a ticket back', () => {
  const t = { markdown_description: '* Waits on: aaa1, bbb2' };
  const states = { aaa1: 'closed', bbb2: 'open' };
  assert.deepEqual(holdReasons(t, (id) => states[id]), { reasons: ['waits on bbb2 (still open)'], unreadable: false });
  assert.deepEqual(holdReasons(t, () => 'closed'), { reasons: [], unreadable: false });
  assert.deepEqual(holdReasons({ description: 'no declaration' }, () => 'open'), { reasons: [], unreadable: false });
});

test('a prerequisite that cannot be read holds the ticket back and says so', () => {
  assert.deepEqual(holdReasons({ description: 'Waits on: typo1' }, () => 'unreadable'),
    { reasons: ['waits on typo1 (could not be read)'], unreadable: true });
  assert.deepEqual(holdReasons({ description: 'Waits on: aaa1' }, () => undefined).unreadable, true);
});

test('an unparsed Waits on: line holds the ticket back', () => {
  assert.deepEqual(holdReasons({ description: 'Waits on: aaa1 and bbb2' }, () => 'closed'),
    { reasons: ['its Waits on: line names "aaa1 and bbb2", which is not a ticket id or link'], unreadable: false });
});
