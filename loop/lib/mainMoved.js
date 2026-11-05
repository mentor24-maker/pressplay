'use strict';

/**
 * mainMoved — telling every ticket still in flight that `main` just moved
 * under it, and whether that matters to its own branch.
 *
 * WHY THIS EXISTS (2026-10-27, task 86bctjffu). Two tickets claimed close
 * together branch from the same `main`. When the first merges, the second
 * finds out only when review merges `main` in, or when the relay refuses
 * Dane's merge word for a conflict — and then it goes back through a whole
 * build and review cycle. Dane's words: "Is there any way to telegraph the
 * fact that the original state has changed so it doesn't have to wait to test
 * it, then get rejected, then have to go through the whole process."
 *
 * So after every merge, each open ticket in a machine status (Building,
 * In review, Rework) gets one note saying which of four things is true:
 *
 *   no-overlap   the merge touched none of this branch's files and git merges
 *                the two cleanly — nothing to do now
 *   same-files   it touched some of the same files but still merges cleanly —
 *                merge `main` in and re-run verify before review
 *   conflict     merging `main` in now conflicts, in the files named
 *   cannot-tell  the check could not run — treated as same-files, never as clean
 *
 * HOW THE CHECK WORKS. `git merge-tree --write-tree` does the merge in memory
 * and prints the result: no checkout, no worktree, nothing pushed, so it is
 * safe to run from the relay's own main checkout. It answers right after a
 * merge, where GitHub's mergeability lags for minutes (see branchCatchUp.js).
 * Its exit code alone is not enough: it exits 1 BOTH for a conflict and for a
 * branch it cannot find. A conflict prints the merged tree's id first; an
 * error prints nothing to stdout. That difference is the only thing this
 * module accepts as a conflict.
 *
 * WHAT THIS IS NOT. It moves no status and resolves nothing. Dane's two
 * statuses are not told: a `Ready to launch` ticket's conflict is the merge
 * step's job (conflictWork.js), and his inbox is not a log.
 */

const { spawnSync } = require('node:child_process');
const { REWORK, BUILDING, IN_REVIEW } = require('./loopStatuses.js');

const KINDS = Object.freeze({
  NO_OVERLAP: 'no-overlap',
  SAME_FILES: 'same-files',
  CONFLICT: 'conflict',
  CANNOT_TELL: 'cannot-tell',
});

/** The statuses that are told. Each is a machine's, with a branch that may exist. */
const NOTIFY_STATUSES = Object.freeze([BUILDING, IN_REVIEW, REWORK]);

/**
 * The ONE shape a note is recorded in and read back from — the writer and the
 * reader share this, as `CONFLICT TICKET FILED:` does in conflictWork.js. The
 * pair of PR numbers is the duplicate guard: one note per merge per PR.
 */
const MAIN_MOVED_TRAIL = 'MAIN MOVED:';
const MAIN_MOVED_RE = /^MAIN MOVED:\s*PR\s*#(\d+)\s*->\s*PR\s*#(\d+)\s*—\s*(no-overlap|same-files|conflict|cannot-tell)\b/im;

function defaultRunGit(args, { cwd } = {}) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    ok: out.status === 0,
    status: out.status,
    stdout: String(out.stdout || '').trim(),
    stderr: String(out.stderr || '').trim(),
  };
}

const lines = (text) => String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Is this ticket one that gets told? */
function isNotifyTarget(task) {
  const status = String(task?.status?.status ?? task?.status ?? '').trim().toLowerCase();
  return NOTIFY_STATUSES.includes(status);
}

/**
 * Turn what git said into a verdict. Pure: every git answer comes in as an
 * argument, so each rule is tested without a repository.
 *
 * @param mergedFiles the files the merge commit changed, or null if unread
 * @param branchFiles the files the branch changes since it left main, or null
 * @param mergeTree   the `git merge-tree` result ({ status, stdout, stderr }), or null
 * @returns {{ kind, files: string[], reason: string }}
 */
function classify({ mergedFiles, branchFiles, mergeTree }) {
  const cannot = (reason) => ({ kind: KINDS.CANNOT_TELL, files: [], reason });
  if (!Array.isArray(mergedFiles)) return cannot('the files the merge changed could not be read');
  if (!Array.isArray(branchFiles)) return cannot("the branch's own files could not be read");
  if (!mergeTree) return cannot('the in-memory merge did not run');
  const out = lines(mergeTree.stdout);
  if (!OID_RE.test(out[0] || '')) {
    return cannot(`the in-memory merge failed (${String(mergeTree.stderr || '').slice(0, 200) || `exit ${mergeTree.status}`})`);
  }
  if (mergeTree.status === 1) return { kind: KINDS.CONFLICT, files: out.slice(1), reason: '' };
  if (mergeTree.status !== 0) return cannot(`the in-memory merge exited ${mergeTree.status}`);
  const touched = new Set(mergedFiles);
  const overlap = branchFiles.filter((f) => touched.has(f));
  return overlap.length
    ? { kind: KINDS.SAME_FILES, files: overlap, reason: '' }
    : { kind: KINDS.NO_OVERLAP, files: [], reason: '' };
}

/**
 * Ask git about one branch, after the caller has fetched. Three reads, no
 * writes: what the merge commit changed, what the branch changes since it left
 * `base`, and whether the two merge. A read that fails becomes null, which
 * classify() turns into cannot-tell.
 *
 * @param mergeCommit the merged PR's commit on `base` (a squash: one parent)
 */
function checkBranch({ base, branch, mergeCommit, cwd = process.cwd(), runGit = defaultRunGit }) {
  const read = (args) => {
    const res = runGit(args, { cwd });
    return res.ok ? lines(res.stdout) : null;
  };
  const mergedFiles = mergeCommit ? read(['diff', '--name-only', `${mergeCommit}^`, mergeCommit]) : null;
  const branchFiles = read(['diff', '--name-only', `origin/${base}...origin/${branch}`]);
  const mergeTree = runGit(['merge-tree', '--write-tree', '--name-only', '--no-messages', `origin/${base}`, `origin/${branch}`], { cwd });
  return classify({ mergedFiles, branchFiles, mergeTree });
}

/**
 * Does `branch` already hold `mergeCommit`? A branch that merged `main` in
 * after the PR landed has nothing to hear about it. true / false, or null when
 * git could not say (the caller then runs the full check, never skips).
 */
function branchContains({ branch, mergeCommit, cwd = process.cwd(), runGit = defaultRunGit }) {
  if (!mergeCommit) return null;
  const res = runGit(['merge-base', '--is-ancestor', mergeCommit, `origin/${branch}`], { cwd });
  if (res.status === 0) return true;
  if (res.status === 1 && !String(res.stderr || '').trim()) return false;
  return null;
}

const fileList = (files) => files.map((f) => `\`${f}\``).join(', ');

/**
 * The note, marker line first. `merged` is { number, url }; `pr` is the
 * ticket's own open PR { number }.
 */
function mainMovedComment({ merged, pr, base, verdict }) {
  const head = `${MAIN_MOVED_TRAIL} PR #${merged.number} -> PR #${pr.number} — ${verdict.kind}`;
  const what = `\`${base}\` changed under this ticket: PR #${merged.number} (${merged.url}) just merged.`;
  const next = {
    [KINDS.NO_OVERLAP]: `It touched none of the files PR #${pr.number} changes, and git merges the two cleanly. Nothing to do now.`,
    [KINDS.SAME_FILES]: `It changed ${verdict.files.length} file(s) PR #${pr.number} also changes: ${fileList(verdict.files)}. Git still merges them cleanly, but the next pass on this ticket merges \`${base}\` in and re-runs \`npm run verify\` before review.`,
    [KINDS.CONFLICT]: `Merging \`${base}\` into PR #${pr.number} now conflicts${verdict.files.length ? ` in: ${fileList(verdict.files)}` : ''}. The next build pass merges \`${base}\` in and resolves it before review; a review pass sends it straight back to Rework.`,
    [KINDS.CANNOT_TELL]: `The check could not run (${verdict.reason}), so nothing is known either way: treat it as same-files and merge \`${base}\` in before review.`,
  }[verdict.kind];
  return [head, '', what, next, '', '(Automatic — main-moved step.)'].join('\n');
}

function parse(text) {
  const m = MAIN_MOVED_RE.exec(String(text || ''));
  return m ? { merged: Number(m[1]), pr: Number(m[2]), kind: m[3] } : null;
}

const byNewest = (comments) => [...(comments || [])].sort((a, b) => Number(b?.date || 0) - Number(a?.date || 0));

/** The note already written for this merge on this PR, or null. */
function findMainMovedNote(comments, mergedNumber, prNumber) {
  for (const c of byNewest(comments)) {
    const got = parse(c?.comment_text);
    if (got && got.merged === Number(mergedNumber) && got.pr === Number(prNumber)) return { ...got, commentId: String(c.id) };
  }
  return null;
}

/**
 * The newest note about this PR, from any merge: what a build or review pass
 * reads. The newest is enough for a conflict, because every check runs against
 * the `main` of its moment, which holds every earlier merge too.
 */
function latestMainMoved(comments, prNumber) {
  for (const c of byNewest(comments)) {
    const got = parse(c?.comment_text);
    if (got && (prNumber == null || got.pr === Number(prNumber))) return { ...got, commentId: String(c.id) };
  }
  return null;
}

/**
 * The per-ticket half of the main-moved step, with every read and write passed
 * in so each rule is tested without ClickUp or GitHub. The caller has already
 * read the merged PR, fetched, and listed the open PRs.
 *
 * NEVER EXITS AND NEVER THROWS PAST ONE TICKET: the relay runs this after a
 * merge it has already recorded, so a failed read on one ticket goes into
 * `problems` and the next ticket is still told.
 *
 * Each ticket is re-read right before its note is posted, and skipped unless
 * it is still in a machine status: a relay pass runs for minutes, and review
 * or `ask` may have moved it to one of Dane's statuses since the list was read.
 *
 * @param tasks     the list's tickets as last read (filtered here)
 * @param merge     { number, url, oid } the merged PR
 * @param base      the branch it merged into
 * @param repo      "owner/name" of the project's repository
 * @param openPrs   Map PR number -> head branch, open against `base`
 * @param io.readComments (id) -> { comments } | { problem }
 * @param io.readStatus   (id) -> status string, or null when unreadable
 * @param io.postNote     (id, text) -> { ok, id, problem }
 * @param io.findPullRequest (comments) -> { owner, repo, number } | null
 * @param io.check        ({ branch }) -> verdict (checkBranch bound)
 * @param io.contains     ({ branch }) -> true | false | null (branchContains bound)
 */
async function tellTickets({ tasks, merge, base, repo, openPrs, dryRun, io }) {
  const lines = [], problems = [];
  let told = 0;
  for (const t of (tasks || []).filter(isNotifyTarget)) {
    const line = (pr, what) => lines.push(`${t.id}\t${t.status?.status ?? t.status ?? '?'}\t${pr}\t${what}\t${t.name}`);
    try {
      const read = await io.readComments(t.id);
      if (!read.comments) { problems.push(`${t.id}: its comments could not be read (${read.problem}) — not told about PR #${merge.number}`); line('-', 'NOT told — comments unreadable'); continue; }
      const found = io.findPullRequest(read.comments);
      if (!found || `${found.owner}/${found.repo}`.toLowerCase() !== String(repo).toLowerCase()) { line('-', 'no PR of this repository recorded — nothing to tell'); continue; }
      const prRef = `PR #${found.number}`;
      if (found.number === merge.number) continue;
      const branch = openPrs.get(found.number);
      if (!branch) { line(prRef, `not open against ${base} — nothing to tell`); continue; }
      if (findMainMovedNote(read.comments, merge.number, found.number)) { line(prRef, `already told about PR #${merge.number}`); continue; }
      if (io.contains({ branch }) === true) { line(prRef, `already contains PR #${merge.number} — nothing to tell`); continue; }
      const verdict = io.check({ branch });
      const what = `${verdict.kind}${verdict.files.length ? ` (${verdict.files.join(', ')})` : ''}${verdict.reason ? ` — ${verdict.reason}` : ''}`;
      if (dryRun) { line(prRef, `would tell: ${what}`); continue; }

      const now = await io.readStatus(t.id);
      if (now == null) { problems.push(`${t.id}: could not be re-read before posting — not told about PR #${merge.number}`); line(prRef, 'NOT told — ticket unreadable'); continue; }
      if (!isNotifyTarget({ status: now })) { line(prRef, `moved to ${now} since the list was read — not told`); continue; }

      const text = mainMovedComment({ merged: merge, pr: { number: found.number }, base, verdict });
      const out = await io.postNote(t.id, text);
      if (!out.ok) { problems.push(`${t.id}: the ${verdict.kind} note about PR #${merge.number} FAILED to post (${out.problem})`); line(prRef, 'NOT told — the note failed to post'); continue; }
      const back = await io.readComments(t.id);
      const stored = back.comments && back.comments.find((c) => String(c.id) === String(out.id));
      const parsed = stored ? findMainMovedNote([stored], merge.number, found.number) : null;
      if (!parsed || parsed.kind !== verdict.kind) {
        problems.push(`${t.id}: the ${verdict.kind} note about PR #${merge.number} posted (id ${out.id || 'none'}) but does not read back${back.comments ? '' : ` (${back.problem})`}`);
        line(prRef, 'NOT told — the note did not read back');
        continue;
      }
      told += 1;
      line(prRef, `told: ${what}`);
    } catch (err) {
      problems.push(`${t.id}: ${err?.message || err} — not told about PR #${merge.number}`);
      line('-', 'NOT told — the step failed on this ticket');
    }
  }
  return { lines, problems, told };
}

module.exports = {
  KINDS,
  NOTIFY_STATUSES,
  MAIN_MOVED_TRAIL,
  isNotifyTarget,
  classify,
  checkBranch,
  branchContains,
  tellTickets,
  mainMovedComment,
  findMainMovedNote,
  latestMainMoved,
};
