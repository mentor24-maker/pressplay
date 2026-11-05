#!/usr/bin/env node
'use strict';

/**
 * Claude Code PreToolUse hook (Edit|Write|NotebookEdit).
 * Blocks edits while the working tree is on the `main` branch. `main` is what
 * ships, so work starts on a topic branch (engineering rule 1 in CLAUDE.md).
 * Exit 2 = block. ALLOW_MAIN_EDITS=1 bypasses — say so and why.
 *
 * Copied from StarCaster's scripts/hooks/block_edits_on_main.cjs.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function currentBranch(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** Nearest existing ancestor dir of a path (the file may not exist yet). */
function nearestDir(target) {
  let dir = target ? path.dirname(target) : '';
  while (dir && !fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
  return dir;
}

function main(input) {
  if (process.env.ALLOW_MAIN_EDITS === '1') process.exit(0);
  let payload;
  try { payload = JSON.parse(input); } catch { process.exit(0); }

  const filePath = String(payload?.tool_input?.file_path || payload?.tool_input?.notebook_path || '');
  const root = String(process.env.CLAUDE_PROJECT_DIR || path.join(__dirname, '..', '..'));
  const resolved = filePath ? path.resolve(filePath) : '';

  // Only guard edits inside this repo; scratchpad writes elsewhere are fine.
  if (resolved) {
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) process.exit(0);
  }

  // Ask the worktree that OWNS the file: a linked worktree carries its own HEAD.
  if (currentBranch(nearestDir(resolved) || root) !== 'main') process.exit(0);

  process.stderr.write(
    'BLOCKED: you are on the "main" branch, which is what ships.\n' +
    'Make a topic branch first so this work stays off the live site until it is ready:\n' +
    '  git checkout -b <short-topic-name>   # e.g. feat/todo-list\n' +
    'Your uncommitted changes come with you onto the new branch — nothing is lost.\n' +
    '(Override for a deliberate one-off: prefix the command with ALLOW_MAIN_EDITS=1.)\n',
  );
  process.exit(2);
}

let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => main(stdin));
