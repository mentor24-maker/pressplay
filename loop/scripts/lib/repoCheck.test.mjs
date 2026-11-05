import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRepo, normalRepo, projectEditUrl } from './repoCheck.mjs';

const editUrl = projectEditUrl('http://mini.local:4180/', 'normie');
const base = { configRepo: 'mentor24-maker/normie', slug: 'normie', editUrl };

test('the Edit form is the page address, the project slug and /edit', () => {
  assert.equal(editUrl, 'http://mini.local:4180/projects/normie/edit');
});

test('the same repository is ok, whatever its case or whether it is written as its GitHub address', () => {
  for (const trackerRepo of ['mentor24-maker/normie', 'Mentor24-Maker/Normie', 'https://github.com/mentor24-maker/normie.git']) {
    const r = compareRepo({ ...base, trackerRepo });
    assert.equal(r.verdict, 'same', trackerRepo);
    assert.equal(r.ok, true);
    assert.match(r.line, /agree: mentor24-maker\/normie/);
  }
});

test('every way of writing the repository reads as owner/name, a trailing slash after .git included', () => {
  for (const v of ['mentor24-maker/normie', 'mentor24-maker/normie/', 'https://github.com/mentor24-maker/normie.git',
    'https://github.com/mentor24-maker/normie.git/', 'https://github.com/Mentor24-Maker/Normie/', 'git@github.com:mentor24-maker/normie.git',
    'ssh://git@github.com/mentor24-maker/normie.git']) {
    assert.equal(normalRepo(v), 'mentor24-maker/normie', v);
  }
});

test('an empty field is reported with where to fill it in, never failed', () => {
  for (const trackerRepo of [null, undefined, '', '  ']) {
    const r = compareRepo({ ...base, trackerRepo });
    assert.equal(r.verdict, 'empty');
    assert.equal(r.ok, true);
    assert.match(r.line, /has no GitHub repository recorded/);
    assert.ok(r.line.includes('http://mini.local:4180/projects/normie/edit'));
  }
});

test('a different repository fails, naming both', () => {
  const r = compareRepo({ ...base, trackerRepo: 'someone-else/normie' });
  assert.equal(r.verdict, 'different');
  assert.equal(r.ok, false);
  assert.ok(r.line.includes('someone-else/normie'));
  assert.ok(r.line.includes('mentor24-maker/normie'));
  assert.match(r.line, /DIFFERENT/);
});
