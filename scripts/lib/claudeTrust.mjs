#!/usr/bin/env node
/**
 * Marks a product's checkout as trusted in Claude's own settings file,
 * `~/.claude.json`, so its lanes use the product's `.claude/settings.json`
 * from their first pass (SP-116).
 *
 *   node scripts/lib/claudeTrust.mjs ensure <folder>   # trust it; exit 0 trusted, 1 FAILED
 *   node scripts/lib/claudeTrust.mjs check  <folder>   # read only; exit 0 yes, 3 no, 1 could not tell
 *
 * WHY (2026-11-04). Normie's lanes' first two passes logged "Ignoring 1
 * permissions.allow entry from .claude/settings.json: this workspace has not
 * been trusted", because a headless `claude -p` never shows the trust dialog
 * a person accepts the first time they open Claude in a folder. It stopped
 * only once somebody opened Claude in Normie's folder by hand.
 *
 * Claude itself rewrites this file all the time (every lane's pass does), and
 * its command line has no setting for the flag. So the write is as small as
 * it can be: only when the flag is not already true; only the one key of the
 * one folder; the file's time is checked again just before the new copy is
 * moved into place, and a change in between means read again and retry; the
 * previous copy is kept beside it; and the result is read back (rule 5). A
 * file that is missing or does not parse is never written (rule 6).
 */
import { readFileSync, writeFileSync, renameSync, statSync, copyFileSync, chmodSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The settings object with `folder` trusted: { changed, next }. Every other
 * key, of this folder and every other, is kept as it was.
 */
export function withTrust(settings, folder) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('the file does not hold one JSON object');
  const projects = settings.projects && typeof settings.projects === 'object' ? settings.projects : {};
  const entry = projects[folder] && typeof projects[folder] === 'object' ? projects[folder] : {};
  if (entry.hasTrustDialogAccepted === true) return { changed: false, next: settings };
  return { changed: true, next: { ...settings, projects: { ...projects, [folder]: { ...entry, hasTrustDialogAccepted: true } } } };
}

/** Is `folder` trusted in this settings object? */
export function isTrusted(settings, folder) {
  return settings?.projects?.[folder]?.hasTrustDialogAccepted === true;
}

/** The form Claude records a folder under: absolute, symlinks resolved. */
export function folderKey(folder) {
  const abs = resolve(folder);
  return existsSync(abs) ? realpathSync(abs) : abs;
}

function readSettings(file) {
  const text = readFileSync(file, 'utf8');
  return { text, json: JSON.parse(text), mtimeMs: statSync(file).mtimeMs };
}

/**
 * Trust `folder` in `file`. Returns { ok, changed, why }. Never throws.
 * `beforeMove` is for tests: it runs at the moment a session's write would race ours.
 */
export function ensureTrusted(folder, { file = join(homedir(), '.claude.json'), tries = 3, beforeMove = () => {} } = {}) {
  const key = folderKey(folder);
  for (let attempt = 1; attempt <= tries; attempt++) {
    let before;
    try { before = readSettings(file); } catch (e) {
      return { ok: false, changed: false, why: `${file} could not be read as JSON (${e.code || e.message}); nothing was written` };
    }
    let plan;
    try { plan = withTrust(before.json, key); } catch (e) { return { ok: false, changed: false, why: `${file}: ${e.message}; nothing was written` }; }
    if (!plan.changed) return { ok: true, changed: false, why: `${key} is already trusted` };

    const indent = /^\{\n(\s+)"/.exec(before.text)?.[1] || '  ';
    const temp = `${file}.spirality-${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(plan.next, null, indent)}\n`, { mode: 0o600 });
      beforeMove(file); // tests stand in for a Claude session writing the file here
      // A Claude session wrote the file while we were busy: start again from its copy.
      if (statSync(file).mtimeMs !== before.mtimeMs) { rmSync(temp, { force: true }); continue; }
      copyFileSync(file, `${file}.spirality-backup`);
      chmodSync(`${file}.spirality-backup`, 0o600);
      renameSync(temp, file);
    } catch (e) {
      // Disk full, permissions: the move is the last step, so the file is
      // either untouched or wholly the new copy, never half-written.
      rmSync(temp, { force: true });
      return { ok: false, changed: false, why: `writing ${file} failed (${e.code || e.message}); it was not changed` };
    }

    let after;
    try { after = readSettings(file); } catch (e) { return { ok: false, changed: true, why: `${file} does not read back after the write (${e.message}); the previous copy is ${file}.spirality-backup` }; }
    if (!isTrusted(after.json, key)) {
      // Overwritten by a session in the moment after the rename: try again.
      continue;
    }
    return { ok: true, changed: true, why: `${key} is now trusted (read back; the previous copy is ${file}.spirality-backup)` };
  }
  return { ok: false, changed: false, why: `${file} kept changing under the write (${tries} tries); run the installer again when the lanes are between passes` };
}

/** Read only: { trusted: true | false | null, why }. */
export function checkTrusted(folder, { file = join(homedir(), '.claude.json') } = {}) {
  const key = folderKey(folder);
  try {
    const { json } = readSettings(file);
    return isTrusted(json, key)
      ? { trusted: true, why: `${key} is trusted` }
      : { trusted: false, why: `${key} is not trusted, so its lanes ignore its .claude/settings.json allow list; run scripts/install_loop_runner.sh to trust it` };
  } catch (e) {
    return { trusted: null, why: `${file} could not be read (${e.code || e.message})` };
  }
}

// Run directly, not imported. Compared as real paths: on a Mac /tmp is a link
// to /private/tmp, and a plain comparison there would skip the command and
// exit 0 having done nothing.
const realOrSelf = (p) => { try { return realpathSync(p); } catch { return p; } };
if (process.argv[1] && realOrSelf(resolve(process.argv[1])) === realOrSelf(fileURLToPath(import.meta.url))) {
  const [cmd, folder] = process.argv.slice(2);
  if (!['ensure', 'check'].includes(cmd) || !folder) {
    console.error('usage: node scripts/lib/claudeTrust.mjs ensure|check <folder>');
    process.exit(2);
  }
  if (cmd === 'ensure') {
    const r = ensureTrusted(folder);
    if (r.ok) console.log(`trust:    ${r.why}`);
    else console.error(`FAILED: trust: ${r.why}`);
    process.exit(r.ok ? 0 : 1);
  }
  const r = checkTrusted(folder);
  console.log(r.trusted === true ? `trust:    yes — ${r.why}` : r.trusted === false ? `trust:    NO — ${r.why}` : `trust:    could not tell — ${r.why}`);
  process.exit(r.trusted === true ? 0 : r.trusted === false ? 3 : 1);
}
