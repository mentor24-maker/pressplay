'use strict';

/**
 * mergeOnComment — the rules for "the operator said merge, so merge it".
 *
 * WHY THIS EXISTS (2026-08-21, task 86bbjd5nn). On 2026-08-20 three
 * Ready-to-launch tickets sat for hours after Dane commented "merge" on
 * them. Nothing acted on those comments: bus-relay only echoed them to the
 * party line, and the merge happened whenever a human session next looked.
 * His comment on a reviewed ticket IS the explicit merge authorization the
 * doctrine requires (LOOP_ENGINEERING, "Safety"); the only thing missing
 * was hands. This module is the decision half of those hands — pure
 * functions over comment lists and a `gh pr view` payload, so every refusal
 * path is testable without touching GitHub or ClickUp.
 *
 * The plumbing that carries the decisions out lives in
 * scripts/clickup_direct.mjs (`bus-relay`), the same pass that already
 * relays his comments. Nothing here performs a merge, and nothing here
 * loosens the standing rules: only the operator's own user id authorizes,
 * only a ticket already promoted to Ready to launch by loop-review is
 * eligible, and a script never resolves a merge conflict.
 */

// The one reading of a local merge verdict, shared with the merge step so the
// two cannot disagree about it (task 86bbq80j5).
const { isRealOverlap, isSelfHealing, isPermanent, conflictActor, verdictCopy, conflictVerdictKind } = require('./conflictWork');
const { stripMachineMarker } = require('./machineComment');

// Every refusal reason, classified terminal/transient/unknown where it is
// RAISED (task 86bbtqpxd). There is no default: a code absent from that table
// throws rather than inheriting a promise nobody chose for it.
const { REFUSAL_CODES: R, classifyRefusal, speaksAsTerminal, refusalNeeds } = require('./refusalClass');
const { operatorName, machineSenderTag, mergePhrases } = require('./substrateConfig.js');

/**
 * The exact phrases that mean "merge it". Deliberately a closed set matched
 * as a WHOLE comment, never as a substring: "do not merge this yet" and
 * "I'll approve the design later" both contain a keyword and must not fire.
 *
 * WHICH phrases is a per-product fact, so it is read from the project config's
 * `mergePhrases` per call, never frozen at load time (review of 86bcgmnpy,
 * round 2). It is exported as a getter so `MERGE_PHRASES` still reads as the
 * list it always was. All three product configs list StarCaster's four today,
 * which is also the fallback where there is no config, so nothing in service
 * changes behaviour with this read.
 */

/**
 * Strip the editor's own formatting off a command.
 *
 * ClickUp's message box turns a PASTED phrase into a fenced code block, and it
 * guesses a language while it is at it — Dane's `resume auto-merging` was
 * stored as "```cpp\nresume auto-merging\n```". Every command here is matched
 * as a WHOLE message, so those backticks made his words unreadable and the
 * auto-merge lane stayed latched off for two days while he typed the right
 * thing three times (2026-09-01, task 86bbt038u).
 *
 * The wrapper is the editor talking, not him. Removing it before matching is
 * what keeps whole-message strictness honest: without this, "strict" quietly
 * means "strict about things the operator cannot control".
 *
 * Only the WRAPPER goes. Nothing inside is touched, so prose that merely
 * mentions a command is still prose, and the caller still requires the whole
 * remaining string to equal a phrase.
 *
 * IT CAME BACK IN A DIFFERENT SHAPE (2026-09-06, task 86bbvraw4). The first
 * version of this stripped backticks and fences, because that was the wrapper
 * ClickUp had produced. On 2026-09-06 Dane posted the resume three times over
 * half an hour and the lane stayed latched off; the near-miss detector quoted
 * what had actually been stored:
 *
 *     **resume auto-merging**
 *
 * Markdown bold, which he did not type — it rode along on a formatted copy. It
 * only took on the fourth try, using Paste and Match Style. His words:
 * "we definitely need to do string match or some other method that will strip
 * the invisible style characters so I don't always have to remember to paste
 * just so."
 *
 * So this now removes the CLASS rather than the instance: emphasis, invisible
 * characters, and the dash variants an editor substitutes. Whole-message
 * strictness is untouched — that is the point. Strict has to mean strict about
 * what he SAID, never about what his editor did to it on the way out.
 */
function stripEditorFormatting(text) {
  return String(text || '')
    // A fenced block: ```lang\n ... \n``` — the opening fence may carry a
    // language tag ClickUp inferred, which is never part of the instruction.
    .replace(/^[ \t]*```[^\n`]*\n?/gm, '')
    .replace(/^[ \t]*```[ \t]*$/gm, '')
    // Inline backticks: `merge` is the same instruction as merge.
    .replace(/`/g, '')
    // Invisible characters a paste carries: zero-width space/non-joiner/joiner,
    // BOM, and the bidirectional marks. They are never part of an instruction
    // and they are, by definition, the ones he cannot see to remove.
    .replace(/[\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
    // A non-breaking space is a space. Collapsing it here rather than in the
    // whitespace pass below keeps that pass's \s+ honest across engines.
    .replace(/\u00A0/g, ' ')
    // Dash variants: en/em dash, non-breaking and figure hyphen, minus sign.
    // "auto-merging" carries a hyphen, and autocorrect rewrites it.
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    // Markdown emphasis: **bold**, __bold__, *italic*, _italic_, ~~strike~~.
    // Removed as MARKERS, not as pairs — a copy can bring one end and not the
    // other, and half a wrapper is still the editor talking.
    .replace(/\*\*|__|~~/g, '')
    .replace(/[*_]/g, '');
}

/** The old name, kept because the whole point is that the wrapper varies.
 *  One implementation, so a caller cannot get the narrow behaviour by accident. */
const stripCodeFormatting = stripEditorFormatting;

/**
 * Normalize a comment for phrase matching: strip code formatting the editor
 * added (see above), trim, lowercase, collapse runs of whitespace (ClickUp
 * turns a Reply box into "merge\n"), and drop trailing sentence punctuation so
 * "Merge!" is the same instruction as "merge".
 * Nothing here makes the match a substring match — the whole remaining
 * string must equal a phrase.
 */
function normalizeCommand(text) {
  return stripEditorFormatting(text)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!\s]+$/g, '');
}

/**
 * Is this comment, in its entirety, a merge command?
 *
 * THE CONFIGURED PHRASES ARE NORMALIZED TOO (review of 86bcgmnpy, round 3).
 * This normalized only the COMMENT and compared it to the phrases as written,
 * which was safe while the phrases were a lower-case literal in this file and
 * stopped being safe the moment they became a per-product config value: a
 * product that wrote `mergePhrases: ["Ship it"]` loaded without error and then
 * never matched anything, so the operator's merge word was ignored with no
 * error at all. Normalizing both sides is what makes the config say what it
 * looks like it says, for capitals, punctuation, emphasis and double spaces
 * alike.
 *
 * Empty phrases are dropped rather than matched: a phrase that normalizes away
 * to nothing (`"."`) would otherwise equal every empty comment and merge on
 * silence. `projectConfig.mjs` refuses such a phrase at load time; this is the
 * same answer for the no-config fallback path, which reads no file to refuse.
 */
function isMergeCommand(text) {
  const asked = normalizeCommand(text);
  if (!asked) return false;
  return mergePhrases().map(normalizeCommand).filter(Boolean).includes(asked);
}

/**
 * The review verdict comments loop-review leaves. Both spellings are in the
 * live record — "REVIEW: PASSED (...)" and "REVIEW PASSED (...)" — so the
 * colon is optional. Line-anchored, because a review that merely DISCUSSES
 * the words ("this is not a REVIEW PASSED situation") is prose, not a
 * verdict. A failing verdict reads "REVIEW: sent back to Rework" (and, on
 * tickets sent back before 2026-08-31, "…to Queued"), which matches
 * isReviewVerdict but not isReviewPassed — exactly the distinction the
 * precondition needs. Neither pattern reads the DESTINATION, which is what
 * lets the status be renamed without invalidating the history.
 *
 * IT MUST ALSO CARRY ONE OF THE VERDICT WORDS (2026-09-01, task 86bbrem48).
 * This used to be `/^\s*REVIEW\b.*$/im` — any line beginning with the word
 * "Review", which is a shape loop-review itself emits in ordinary prose. The
 * operator card it posts alongside a PASS contains the line
 *
 *   Review re-ran everything independently on the merged code: typecheck ...
 *
 * and that card is NEWER than the verdict. `all` is correctly newest-first,
 * so `.find` returned the CARD, `isReviewPassed` was false, and four approved
 * tickets were refused overnight with "the most recent review verdict is not
 * a PASS" — a false statement, while the queue sat still behind a full WIP
 * cap. The review pass was poisoning its own verdict.
 *
 * The refusal was also permanent and self-concealing: it tells the operator
 * "your approval is still standing ... the moment the reason above is dealt
 * with it goes through on its own", and the reason can never be dealt with,
 * because the card is newer than the verdict and always will be.
 *
 * `verdictComment` (scripts/builder/loopTrail.js) is the ONE producer, and it
 * emits exactly two headings. Keying on those words rather than on the bare
 * prefix is what separates a verdict from prose — and it is STRICTER than
 * what it replaced, never more willing to merge, which is the only safe
 * direction for the gate in front of production.
 *
 * THE TWO CHANGES MEET HERE ON PURPOSE (2026-09-01, ticket 86bbrf2y3). The
 * Rework rename and the prose fix landed within an hour of each other and
 * conflicted on this comment alone. They are compatible in substance: the
 * pattern keys on "SENT BACK" and never on what follows it, so renaming the
 * destination status cannot invalidate a verdict written before the rename.
 */
const REVIEW_VERDICT_RE = /^\s*REVIEW\s*:?\s*(?:PASSED|SENT BACK)\b/im;
const REVIEW_PASSED_RE = /^\s*REVIEW\s*:?\s*PASSED\b/im;

function isReviewVerdict(text) {
  return REVIEW_VERDICT_RE.test(String(text || ''));
}

function isReviewPassed(text) {
  return REVIEW_PASSED_RE.test(String(text || ''));
}

/**
 * The PR this ticket is about. The build loop's own convention is a comment
 * whose first line is "PR opened: <url>" (loop-build SKILL.md step 7), and
 * ONLY that line is trusted: ticket comments routinely cite other PRs in
 * passing ("it depends on ... PR #341: <url>"), and merging the PR a review
 * comment mentioned would be a catastrophe that looks like success. No
 * "PR opened:" line means no candidate — refuse rather than guess.
 * Newest wins, so a rebuilt ticket merges its latest PR.
 *
 * `findPullRequests` is the same rule, returning EVERY trail PR newest-first
 * rather than only the winner. It exists because the reconciler needs both
 * questions answered from ONE definition of "this ticket's PR": which PR is
 * authoritative (the newest), and which PRs are this ticket's at all (all of
 * them, to spot a leftover open one under a closed ticket). Before 2026-09-04
 * the reconciler answered the second question with its own loose regex over
 * prose and closed a live urgent ticket on a PR belonging to another ticket —
 * exactly the catastrophe the paragraph above says this parser exists to
 * prevent, arriving through the one caller that did not use it (86bbuv66c).
 */
const PR_OPENED_RE = /^\s*PR opened:\s*(https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+))\b/im;

function findPullRequests(comments) {
  const found = [];
  const seen = new Set();
  for (const c of byDateNewestFirst(comments)) {
    const m = PR_OPENED_RE.exec(String(c.comment_text || ''));
    if (!m) continue;
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    found.push({ url, owner: m[2], repo: m[3], number: Number(m[4]), commentId: String(c.id) });
  }
  return found;
}

function findPullRequest(comments) {
  return findPullRequests(comments)[0] || null;
}

function commentDate(c) {
  const n = Number(c && c.date);
  return Number.isFinite(n) ? n : 0;
}

function byDateNewestFirst(comments) {
  return (comments || []).slice().sort((a, b) => commentDate(b) - commentDate(a));
}

/**
 * The merge path's dedup marker, written as a threaded reply on the
 * operator's own comment. Defined HERE, next to the parser that reads it
 * back, so the writer and the reader can never drift apart.
 */
const MERGE_MARKER = '[merge-on-comment]';

/**
 * The exact shape of a conflict hand-off marker written before 2026-08-23,
 * when hand-offs were terminal by accident rather than by intent. Anchored
 * whole-string so nothing else can drift into the migration path.
 */
const LEGACY_HAND_OFF_RE = /^conflict hand-off on PR #\d+$/i;

/**
 * Read one marker reply back into a decision.
 *
 * WHY THIS EXISTS (2026-08-22, task 86bbjt18r). Until now every marker meant
 * the same thing — "this authorization is spent, never look at it again" —
 * and that is wrong for a REFUSAL. On 2026-08-22 two tickets were refused for
 * "no PR opened: comment", the missing comment was added by hand minutes
 * later, and the next three passes did not look at them again: Dane's
 * approval was still sitting there, still valid, and the ticket had gone
 * quiet forever. A refusal is a snapshot of a moment, not a verdict on the
 * ticket.
 *
 * So markers now carry a KIND. 'terminal' (merged, or handed to a human for
 * a conflict) is spent forever — re-deciding a merged PR is the one mistake
 * that cannot be undone. 'refused' is re-decided on every later pass, and
 * only stays quiet while the reason it gave is still the true one.
 *
 * The format is the one already in the live record — `[merge-on-comment]
 * refused: <why> — <ISO>` — so markers written before this change parse
 * correctly and nothing needs migrating. `lastIndexOf` finds the timestamp
 * separator because the REASON often contains an em-dash of its own
 * ("no \"PR opened:\" comment on this ticket — nothing to merge").
 */
function parseMergeMarker(text) {
  // THE STAMP COMES OFF FIRST (2026-09-06, task 86bbvr0j5). `call()` appends
  // the `[machine]` line to every comment it posts, this marker included, and
  // that line ends in "Dane's token — not his word". The ` — <timestamp>` split
  // below takes the LAST em-dash, so the stamp captured it: the timestamp was
  // never recovered and the reason came back with the stamp glued on. Neither
  // ever matched what the next pass compared against, which killed the dedup
  // and made the stall alarm behind it unreachable.
  const raw = stripMachineMarker(text);
  if (!raw.startsWith(MERGE_MARKER)) return null;
  let rest = raw.slice(MERGE_MARKER.length).trim();
  let at = '';
  const cut = rest.lastIndexOf(' — ');
  if (cut !== -1) {
    const tail = rest.slice(cut + 3).trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(tail)) {
      at = tail;
      rest = rest.slice(0, cut).trim();
    }
  }
  if (/^refused\s*:/i.test(rest)) {
    return { kind: 'refused', reason: rest.replace(/^refused\s*:\s*/i, '').trim(), at };
  }
  // MIGRATION (2026-08-23, task 86bbk0g4u). Conflict hand-offs written before
  // this change carry no "refused:" prefix, so they parsed as TERMINAL and
  // spent the authorization — while the comment posted beside them promised
  // the exact opposite ("then your merge still stands and this goes through").
  // Eleven Ready-to-launch tickets sat dead that way, one of them approved
  // twice four hours apart. Reading the old shape back as re-decidable heals
  // every one of them on the next pass, with no second "merge" from the
  // operator and nothing to remember to run by hand.
  //
  // Safe in the only direction that matters: a `merged PR #N at ...` marker
  // does not match this, so a merged PR is still never re-decided — and even
  // if one somehow were, githubGate refuses an already-merged PR outright.
  if (LEGACY_HAND_OFF_RE.test(rest)) {
    return { kind: 'refused', reason: rest, at, legacy: true };
  }
  return { kind: 'terminal', reason: rest, at };
}

/**
 * The NEWEST marker on one comment's reply thread decides its state. A
 * ticket refused twice for different reasons carries two markers, and only
 * the last one describes where it actually stands.
 */
function latestMergeMarker(replies) {
  let best = null;
  let bestDate = -Infinity;
  for (const r of replies || []) {
    const parsed = parseMergeMarker(r && r.comment_text);
    if (!parsed) continue;
    const d = commentDate(r);
    if (d >= bestDate) { best = parsed; bestDate = d; }
  }
  return best;
}

/**
 * How many times a pass has already refused this authorization FOR THIS REASON.
 *
 * WHY IT IS COUNTED (2026-09-06, task 86bbvr0j5, Dane's call). A conflicting
 * PR retries every relay pass, and the only alarm on that path measured AGE —
 * 24 hours, chosen when the failure being imagined was a hand-off nobody had
 * picked up. It is the wrong instrument for a merge that is actively retrying
 * and failing: PR #628 failed five times in ninety minutes and the clock had
 * barely moved. Dane noticed by eye and asked why the system had not.
 *
 * The attempts need no new storage, because each pass already writes its own
 * marker reply. Counting the markers that gave THIS reason is the number of
 * times this exact refusal has been reached — which is the question, and it
 * survives a restart because the record is on the ticket rather than in
 * memory.
 *
 * Matching on the reason, not merely on the marker, is what keeps it honest: a
 * PR refused twice for red checks and once for a conflict has not tried the
 * conflict three times, and an alarm that said so would send somebody looking
 * for a problem that is not there.
 */
function countMergeRefusals(replies, reason) {
  const want = String(reason == null ? '' : reason).trim();
  if (!want) return 0;
  let n = 0;
  for (const r of replies || []) {
    const parsed = parseMergeMarker(r && r.comment_text);
    if (parsed && parsed.kind === 'refused' && String(parsed.reason).trim() === want) n += 1;
  }
  return n;
}

/**
 * Decide what a bus-relay pass should do with one Ready-to-launch ticket.
 *
 * Returns `{ act, reason, ... }` where act is one of:
 *   'ignore'  — nothing to do, and nothing to say (the common case)
 *   'refuse'  — an authorization exists but a precondition failed; the
 *               caller comments on the ticket and marks the comment handled
 *   'merge'   — every ClickUp-side precondition holds; the caller now checks
 *               GitHub (see githubGate) and merges
 *
 * `handled` is the set of comment ids whose answer was TERMINAL — merged, or
 * handed to a human for a conflict. Those are never re-decided.
 *
 * `refused` is the other half (task 86bbjt18r): a map of comment id -> the
 * reason that refusal gave. A refused authorization IS re-decided on every
 * later pass, because the reason may have gone away — that is the whole
 * point. The map is what keeps it quiet in the meantime: if the pass reaches
 * the SAME refusal again, the decision is 'ignore' and nothing is posted, so
 * re-planning costs no extra noise on the ticket. A different reason, or a
 * clean run through to 'merge', is new information and is acted on.
 */
function mergeDecision({ status, comments, operatorId, handled, refused, refusedAt, refusedCount }) {
  const seen = handled instanceof Set ? handled : new Set(handled || []);
  const priorRefusals = refused instanceof Map ? refused : new Map(Object.entries(refused || {}));
  // WHEN the previous refusal was written, carried alongside WHY. A conflict
  // hand-off that has been sitting for a day is news even though its reason
  // has not changed (task 86bbq0fh8) — and the age can only come from the
  // marker, which is the one record of when the pass actually said it.
  const priorRefusalTimes = refusedAt instanceof Map ? refusedAt : new Map(Object.entries(refusedAt || {}));
  const priorRefusalCounts = refusedCount instanceof Map ? refusedCount : new Map(Object.entries(refusedCount || {}));
  const all = byDateNewestFirst(comments);

  // Only Ready to launch. The same word on any other status does nothing —
  // a merge command on a Building ticket is not an authorization, it is a
  // guess about work that is not finished.
  if (String(status || '').toLowerCase() !== 'ready to launch') {
    return { act: 'ignore', reason: `status is "${status}", not Ready to launch` };
  }

  // Only the operator, checked by numeric user id. A Pulse or agent comment
  // saying "merge" is a machine talking to itself, never an authorization.
  const authorization = all.find(
    (c) => Number(c.user && c.user.id) === Number(operatorId)
      && isMergeCommand(c.comment_text)
      && !seen.has(String(c.id)),
  );
  if (!authorization) return { act: 'ignore', reason: 'no unhandled merge command from the operator' };

  // The reason a previous pass refused THIS authorization, carried out to the
  // caller as well as used below. The plumbing needs it because two of the
  // three refusal reasons are only discovered later, against GitHub (checks
  // red, branch conflicts) — mergeDecision cannot quiet those on its own, and
  // without it a permanent conflict would post an identical comment on every
  // pass.
  const base = {
    commentId: String(authorization.id),
    commentDate: commentDate(authorization),
    priorRefusal: priorRefusals.get(String(authorization.id)),
    priorRefusalAt: priorRefusalTimes.get(String(authorization.id)) || '',
    // HOW MANY TIMES, alongside why and when. Age alone cannot see a merge
    // that is retrying and failing every few minutes (task 86bbvr0j5).
    priorRefusalCount: Number(priorRefusalCounts.get(String(authorization.id))) || 0,
  };

  // A refusal we have already given, whose reason is still true, is not news.
  // Saying it again on every pass would bury the ticket in identical
  // comments, so it goes quiet — but it goes quiet by RE-DERIVING the same
  // answer, not by being permanently struck off. The moment the reason
  // changes (or disappears), the next pass acts.
  const wasRefusedFor = base.priorRefusal;
  // The CODE travels with the reason from here on (task 86bbtqpxd).
  // `classifyRefusal` throws on an unknown one, so a new refusal added
  // without a classification fails at the raise site rather than quietly
  // inheriting the standing-approval promise.
  const refuse = (refusalCode, reason) => {
    classifyRefusal(refusalCode);
    return reason === wasRefusedFor
      ? { ...base, act: 'ignore', reason: `already refused for the same reason: ${reason}`, refusalCode }
      : { ...base, act: 'refuse', reason, refusalCode };
  };

  // The newest REVIEW verdict must be a PASS, and the authorization must be
  // NEWER than it. Both halves matter: the first is "a human-independent
  // check said this is good", the second is "he was authorizing THIS
  // verdict". A ticket sent back, rebuilt and re-reviewed carries a stale
  // "merge" from the previous round; that comment predates the new verdict
  // and must not release the new PR.
  const verdict = all.find((c) => isReviewVerdict(c.comment_text));
  if (!verdict) {
    return refuse(R.noReviewVerdict, 'no review verdict on this ticket — loop-review has not passed it');
  }
  if (!isReviewPassed(verdict.comment_text)) {
    return refuse(R.reviewNotPassed, 'the most recent review verdict is not a PASS');
  }
  if (commentDate(authorization) < commentDate(verdict)) {
    return refuse(R.authorizationPredatesVerdict, 'the merge command predates the current review verdict — it authorized an earlier round');
  }

  const pr = findPullRequest(all);
  if (!pr) {
    return refuse(R.noPrRecorded, 'no "PR opened:" comment on this ticket — nothing to merge');
  }

  return { ...base, act: 'merge', pr, reason: `authorized by comment ${authorization.id}` };
}

/**
 * Every check on the PR, reduced to one verdict. Handles BOTH shapes GitHub
 * puts in statusCheckRollup: a CheckRun (status + conclusion) and a
 * StatusContext (state) — the Vercel deployment arrives as the latter, so a
 * reader that only understood CheckRun would call a red Vercel build green.
 */
function checkState(rollup) {
  const entries = rollup || [];
  const pending = [];
  const failed = [];
  for (const c of entries) {
    const name = c.name || c.context || '(unnamed check)';
    if (c.__typename === 'StatusContext' || (!c.status && c.state)) {
      const state = String(c.state || '').toUpperCase();
      if (state === 'PENDING' || state === 'EXPECTED') pending.push(name);
      else if (state !== 'SUCCESS') failed.push(`${name} (${state || 'unknown'})`);
      continue;
    }
    const status = String(c.status || '').toUpperCase();
    if (status !== 'COMPLETED') { pending.push(name); continue; }
    const conclusion = String(c.conclusion || '').toUpperCase();
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) continue;
    failed.push(`${name} (${conclusion || 'no conclusion'})`);
  }
  return { pending, failed, total: entries.length };
}

/**
 * Every value GitHub's `mergeStateStatus` can hold. Eight situations, eight
 * owners — and this gate answers for each of them separately, because
 * collapsing them into one sentence is the defect this list was written
 * against (2026-09-01, task 86bbrg9v0).
 *
 * `mergeOnComment.test.js` walks this array and fails if any value reaches
 * the gate without a sentence of its own, so adding a value here without
 * handling it is caught rather than merged on.
 */
const MERGE_STATE_STATUSES = Object.freeze([
  'BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE',
]);

/**
 * The branch-protection rule GitHub is holding the merge on — but ONLY when
 * GitHub actually named one.
 *
 * `reviewDecision` is the single piece of branch protection `gh pr view`
 * exposes, so an unmet review requirement can be named exactly and every
 * other rule cannot be named at all. The second case is a CANNOT TELL, never
 * a guess at a review: guessing at a review is precisely what happened to
 * PR #487.
 *
 * Returns null when the field is absent, which is also what an older caller
 * that never asked for `reviewDecision` produces — absent reads as "could not
 * tell", not as "no rule".
 */
function unmetProtectionRule(pr) {
  const decision = String((pr && pr.reviewDecision) || '').toUpperCase();
  if (decision === 'REVIEW_REQUIRED') return 'a required review has not been given';
  if (decision === 'CHANGES_REQUESTED') return 'a reviewer requested changes';
  return null;
}

/**
 * What to do with the PR itself, given `gh pr view --json
 * state,mergeStateStatus,mergeable,reviewDecision,statusCheckRollup`.
 *
 *   'merge'            — go
 *   'update-branch'    — behind main; catch it up via GitHub, then re-run the gate
 *   'catch-up-locally' — GitHub says it conflicts and git says it does not;
 *                        merge main in HERE and push (GitHub's own
 *                        `update-branch` refuses on a PR it has flagged)
 *   'conflict'         — hand it to an agent session; a script never resolves conflicts
 *   'wait'          — checks still running; say nothing, try next pass
 *   'refuse'        — terminal; comment on the ticket and stop
 *
 * THE REASON IS THE PRODUCT (2026-09-01, task 86bbrg9v0). Dane's "merge" on
 * PR #487 came back with "GitHub reports the merge is blocked (a required
 * review or check is missing)". Both halves were false: every check was
 * green, and `gh pr view` read CONFLICTING / DIRTY — the branch had a merge
 * conflict. The sentence sent him looking for a missing review that did not
 * exist. A refusal that names the wrong reason is worse than one that names
 * none, because it looks answered — the same defect as 86bbrem48 (the gate
 * read its own card as the verdict) and 86bbrf2vf (a blocked pull called
 * "uncommitted changes").
 *
 * So no sentence below asserts a cause this function did not read. Where
 * GitHub's answer does not determine the cause, the reason says CANNOT TELL
 * and names what it saw (DOCTRINE 3.11) — never a pass, and never a plausible
 * reason, for a question that could not be answered.
 *
 * EVERY RETURN DECLARES `cannotTell`, TRUE OR FALSE (review round 2 of task
 * 86bbuvd50). It answers one question — did this pass take a reading of the
 * pull request at all, or is the verdict the absence of one? — and it is what
 * the repeat bound counts, because the SENTENCE cannot be trusted to carry
 * that meaning. PR #597 reworded the dominant cannot-tell and deleted the
 * `CANNOT TELL` marker from it, which silently unhooked 84 of the 108
 * measured lines from a bound that read the prose. Omitting the field on a
 * new branch is not a syntax error and no behavioural test would catch it
 * (`Boolean(undefined)` is `false`, so it would simply never be counted), so
 * a source assertion in mergeOnComment.test.js fails on any return here that
 * leaves the question unanswered.
 */
function githubGate(pr, { gitCrossCheck = null } = {}) {
  const state = String((pr && pr.state) || '').toUpperCase();
  if (state === 'MERGED') return { action: 'refuse', cannotTell: false, refusalCode: R.prAlreadyMerged, reason: 'the PR is already merged' };
  if (state !== 'OPEN') return { action: 'refuse', cannotTell: false, refusalCode: R.prNotOpen, reason: `the PR is ${state || 'in an unknown state'}, not open` };

  if (pr.isDraft) return { action: 'refuse', cannotTell: false, refusalCode: R.prIsDraft, reason: 'the PR is still a draft' };

  const mergeable = String(pr.mergeable || '').toUpperCase();
  const mergeStateStatus = String(pr.mergeStateStatus || '').toUpperCase();

  // Conflicts first: a CONFLICTING PR cannot be helped by updating the
  // branch, and update-branch on one is exactly the "resolve it blind" this
  // must never do.
  //
  // ONE ASYNCHRONOUS READING IS NOT A SETTLED FACT (2026-09-03, task
  // 86bbupfgn). On 2026-09-03 PR #567 read CONFLICTING/DIRTY from two
  // different GitHub endpoints five minutes apart, while `git merge-tree`
  // said clean and the real merge brought 16 commits across with zero
  // conflicts. The gate handed the ticket to an agent session — of which
  // none was watching — so a green, approved PR simply stopped, and the
  // sentence it stopped with ("the branch conflicts with newer work on
  // main") was false.
  //
  // Note the shape: the UNKNOWN branch below already knows this reading is
  // computed in the background and can be not-yet-true. DIRTY comes from the
  // same computation and got no such treatment.
  //
  // WHY GitHub said dirty is still unknown, and this code does not guess.
  // The ticket's leading suspect was a stale computation against an older
  // base — GitHub reported base_sha 0c6f096b while main was at 9b0056e2 —
  // and that was MEASURED and does not hold: `git merge-tree --write-tree`
  // is clean against BOTH commits (verified 2026-09-03 on the real objects).
  // So the fix deliberately assumes nothing about the cause. It only refuses
  // to assert a conflict that a second source contradicts.
  if (mergeable === 'CONFLICTING' || mergeStateStatus === 'DIRTY') {
    const cc = gitCrossCheck;
    if (cc && cc.known && cc.conflicts === false) {
      // THE DISAGREEMENT HAS A KNOWN REMEDY, SO REPORTING IT IS NOT ENOUGH
      // (2026-09-04, task 86bbuvcwc). This used to answer `wait` — no
      // conflict claimed, ask again next pass — which is right about the
      // conflict and wrong about what happens next. Nothing was going to
      // change on its own: measured on PR #585, this exact line was printed
      // five times over fifty minutes, saying auto-merge would land a pull
      // request GitHub had flagged and therefore would not land.
      //
      // One confirmed cause is `docs/WORK-LOG.md merge=union`. Git honours
      // that driver and so does a merge GitHub PERFORMS, but the mergeability
      // GitHub PRECOMPUTES does not — so a union-only difference reads as
      // CONFLICTING for as long as the branch stays behind. That is not
      // asserted as THE cause here, because this function does not know it:
      // it is one measured instance of the general shape.
      //
      // What IS general is the remedy, and it was measured on the same PR —
      // merging main in and pushing flipped GitHub to MERGEABLE within
      // seconds. So the answer is the local catch-up, not GitHub's
      // `update-branch` (which refuses on a PR it has called CONFLICTING).
      return {
        action: 'catch-up-locally',
        disagreement: true,
        // NO READING WAS TAKEN. Two sources contradict each other about the
        // same branch, so this verdict is not an answer — it is the absence
        // of one, and asking again next pass can legitimately say something
        // different. It is 84 of the 108 lines the bound's threshold was
        // measured on, and until review round 2 of task 86bbuvd50 it was
        // classified by looking for `CANNOT TELL` in the sentence below —
        // which PR #597 had already deleted from it.
        cannotTell: true,
        reason: `GitHub reports this branch as ${mergeable === 'CONFLICTING' ? 'CONFLICTING' : 'DIRTY'}, but git merges ${cc.base || 'main'} into ${cc.head || 'the branch'} cleanly (merge-tree exit 0). The two sources disagree, so no conflict is claimed — this machine merges ${cc.base || 'main'} into the branch and pushes, which is what cleared the identical reading on PR #585`,
      };
    }
    if (cc && cc.known && cc.conflicts === true) {
      const files = Array.isArray(cc.files) ? cc.files.filter(Boolean) : [];
      return {
        action: 'conflict',
        // Both sources agree: this IS a reading, and a definite one.
        cannotTell: false,
        // Read by conflictRoute: a conflict git has CONFIRMED needs no catch-up
        // attempt, and so no merge window (task 86bcemvj5).
        gitConfirmed: true,
        files,
        reason: `the branch conflicts with newer work on main — GitHub and git agree${files.length ? ` (${files.join(', ')})` : ''}`,
      };
    }
    // No cross-check available. The hand-off still happens, because an
    // unverified conflict is not a reason to merge — but the sentence says
    // what was actually read and what could not be, rather than asserting a
    // conflict nothing confirmed (DOCTRINE 3.11).
    return {
      action: 'conflict',
      needsGitCrossCheck: true,
      // Honestly a cannot-tell — GitHub said CONFLICTING and nothing
      // confirmed it. It never reaches the repeat bound, because a conflict
      // hand-off is terminal rather than a wait that repeats, but the field
      // states what was read rather than what happens next.
      cannotTell: true,
      reason: `GitHub reports this branch as ${mergeable === 'CONFLICTING' ? 'CONFLICTING' : 'DIRTY'}${cc && cc.why ? `, and git could not be consulted (${cc.why})` : ', and this pass did not cross-check it against git'} — treated as a conflict because an unconfirmed conflict is still not something to merge`,
    };
  }

  // GitHub answers UNKNOWN while it is still computing mergeability. That is
  // not a failure — it is "ask again", and asking again is what the next
  // pass is for.
  if (mergeable === 'UNKNOWN' || mergeStateStatus === 'UNKNOWN') {
    return {
      action: 'wait',
      // The other 22 of the 108 measured lines.
      cannotTell: true,
      reason: 'CANNOT TELL yet — GitHub is still computing whether the branch merges cleanly; the next pass asks again',
    };
  }

  const checks = checkState(pr.statusCheckRollup);
  if (checks.failed.length) {
    return { action: 'refuse', cannotTell: false, refusalCode: R.checksRed, reason: `checks are red: ${checks.failed.join(', ')}` };
  }
  if (checks.pending.length) {
    // A READING WAS TAKEN and it is "not yet". CI here takes about six
    // minutes; counting it toward a ninety-minute bound measured on a
    // narrower population would turn every ordinary wait into an alarm, which
    // is the calibration error task 86bbuvd50 warned about in the loud
    // direction.
    return { action: 'wait', cannotTell: false, reason: `checks still running: ${checks.pending.join(', ')}` };
  }
  // A PR with no checks at all is not a green PR — it is a PR nothing
  // verified. main is protected on the "verify" check precisely so this
  // cannot ship unchecked.
  if (!checks.total) {
    return { action: 'refuse', cannotTell: false, refusalCode: R.noChecksAtAll, reason: 'the PR reports no checks at all — nothing verified this branch' };
  }

  // Behind main: the machine's own job, and it does it this pass.
  if (mergeStateStatus === 'BEHIND') {
    return {
      action: 'update-branch',
      cannotTell: false,
      reason: 'the branch is behind main — this machine catches it up and the checks re-run',
    };
  }

  // UNSTABLE means GitHub can see a check on this branch that is not passing.
  // Every check this gate can read is green (the two branches above already
  // named a red or a running one), so the two readings disagree — and merging
  // on the greener of two disagreeing readings is acting on a contradiction.
  if (mergeStateStatus === 'UNSTABLE') {
    return {
      action: 'refuse',
      cannotTell: true,
      refusalCode: R.unstableCannotTell,
      reason: 'CANNOT TELL — GitHub reports a check on this branch is not passing, but every check this gate can read is green, so it cannot name which one; read the PR\'s checks on GitHub',
    };
  }

  if (mergeStateStatus === 'BLOCKED') {
    const rule = unmetProtectionRule(pr);
    if (rule) {
      return { action: 'refuse', cannotTell: false, refusalCode: R.blockedByNamedRule, reason: `GitHub is holding the merge because ${rule}` };
    }
    // The #487 sentence used to live here, and it was a guess wearing a
    // fact's clothes. GitHub reports BLOCKED for any unsatisfied protection
    // rule AND for a conflict it has not finished recomputing, and it named
    // neither, so neither may be named back.
    return {
      action: 'refuse',
      cannotTell: true,
      refusalCode: R.blockedCannotTell,
      reason: 'CANNOT TELL which rule — GitHub reports the merge is blocked while every check this gate can read is green, and it did not name the rule. It is not necessarily a missing review: a conflict GitHub has not finished recomputing reads exactly like this, so re-read the PR before acting on it',
    };
  }

  if (mergeStateStatus === 'DRAFT') {
    return { action: 'refuse', cannotTell: false, refusalCode: R.githubReportsDraft, reason: 'GitHub still reports the PR as a draft' };
  }

  if (mergeStateStatus === 'CLEAN' || mergeStateStatus === 'HAS_HOOKS') {
    return { action: 'merge', cannotTell: false, reason: `open, ${checks.total} check(s) green, no conflicts` };
  }

  // Not one of the eight values this gate knows how to read. The old code
  // fell through to 'merge' here, which is the same guess in the safest-
  // sounding direction — and "it merged, so it must have been fine" is not
  // evidence.
  return {
    action: 'refuse',
    cannotTell: true,
    refusalCode: R.unreadableMergeState,
    reason: `CANNOT TELL — GitHub reported a merge state this gate does not know how to read (${mergeStateStatus ? `mergeStateStatus "${mergeStateStatus}"` : 'no mergeStateStatus at all'}, mergeable "${mergeable || 'absent'}")`,
  };
}

/**
 * WAITING FOR CI INSIDE ONE PASS (2026-08-24, task 86bbk2fb5).
 *
 * Merging one PR is about three minutes of real work — catch the branch up,
 * run CI (`verify` median 85 seconds), merge. We were achieving 1.25 merges an
 * hour, with the pipeline idle roughly 95% of the time.
 *
 * The cost was the SHAPE, not the work. It took two passes to merge one PR:
 * pass N caught the branch up and returned `waiting`; CI finished 85 seconds
 * later; pass N+1 merged it an hour after that. A three-minute job took two
 * hours.
 *
 * It gets worse as the queue grows, not better. Branch protection is
 * `strict: true`, so a branch must be current with main to merge — meaning
 * EVERY merge invalidates every other open branch. At 24 open PRs each merge
 * leaves 23 needing catch-up, and a catch-up done an hour ago is stale before
 * the next pass reaches it. The two-pass shape can lose a race with its own
 * previous pass.
 *
 * So after a catch-up push, the pass waits for the check run rather than
 * going away for an hour. Three rules keep that bounded:
 *
 *   - A BUDGET, not patience. ~2x the observed median. When it runs out the
 *     answer is `wait` — exactly what the pass returned before — never a
 *     merge and never a failure. A slow CI run is not a broken one.
 *   - A CAP per pass, so one stuck PR cannot starve the rest. Beyond the cap
 *     everything falls through to `wait` and the next pass takes it.
 *   - The SAME gate. Nothing here decides whether a PR may merge; it only
 *     decides whether to ask again. Red is refused by the existing path, with
 *     the existing wording.
 */

/**
 * How long a pass will hold itself open waiting on CI.
 *
 * MEASURED AGAINST `verify`, AND THE MEASUREMENT MOVED (2026-09-03, task
 * 86bbup3u1). This was set at 180s as "~2x the observed 85s median". That
 * median is no longer true: four consecutive runs on PR #571 that afternoon
 * took 127s, 317s, 346s and 342s. 180s is now SHORTER than the thing it is
 * waiting for, which is not a slow wait — it is a wait that can never
 * succeed.
 *
 * It is deliberately NOT raised to cover the new figure, and that is the
 * point of this ticket. The bound is not free: MAX_IN_PASS_WAITS x this must
 * stay under the relay's own 600s interval (see below), so covering a 350s CI
 * run would mean a cap of one, and one stuck PR would spend the whole pass.
 * A budget cannot be both big enough for CI and small enough for the
 * schedule.
 *
 * So the merge path no longer tries to win that race. It hands the PR to
 * GitHub's own auto-merge (see autoMergeDecision) and returns immediately;
 * GitHub merges it whenever the checks go green, however long they take, and
 * keeps the branch current itself. This budget survives only for the one
 * caller that genuinely must wait in-pass — the stale review-gate re-run,
 * which has to see a NEW answer appear before it can act on anything.
 */
const IN_PASS_WAIT_MS = 180_000;

/** How often to re-ask GitHub inside that budget. */
const IN_PASS_POLL_MS = 10_000;

/**
 * How many tickets may hold a pass open. Worst case is CAP x BUDGET, so this
 * is the number that keeps a pass from becoming an unbounded one.
 *
 * The ceiling that matters is the relay's OWN interval (`INTERVAL_SECONDS` in
 * scripts/install_bus_relay.sh, 600s). A pass that stays under it is finished
 * before the next firing is due; a pass that runs past it swallows that firing
 * — launchd coalesces the ones it misses — so approvals arriving meanwhile
 * wait on work already in flight instead of being picked up promptly.
 * mergeOnComment.test.js reads that interval and pins the bound against it, so
 * shortening the cadence again fails a test rather than quietly permitting a
 * pass longer than its own schedule.
 */
const MAX_IN_PASS_WAITS = 3;

/** Has this pass already spent its in-pass waits? */
function mayWaitInPass(waitsUsed, cap = MAX_IN_PASS_WAITS) {
  return Number(waitsUsed || 0) < cap;
}

/**
 * How long may THIS pass hold itself open watching a merge land?
 *
 * WHY THIS EXISTS (round 2 of task 86bbv35cq). The merge-observation wait was
 * added taking a 15-minute default, blocking (`Atomics.wait` freezes the event
 * loop), uncapped per ticket, and charged to nothing — so `inPassBudget` never
 * saw it and the tested "a pass cannot outlast its own interval" invariant did
 * not cover it. The relay's schedule is 600s. One enqueued pull request would
 * have been 900s, several 30-45 minutes, swallowing the relay's own next
 * firings and everything else that rides its ten-minute wake.
 *
 * That is exactly what the comment on the worst-case test already warned
 * about: "the 15-minute bound this replaces... was picked when the relay ran
 * hourly, and it survived the change to 10 minutes still permitting a pass
 * 1.5x longer than the whole interval." It came straight back on a new path.
 *
 * So the merge observation is not a second budget. It IS an in-pass wait — the
 * same slots, the same per-wait ceiling, the same accounting — because two
 * budgets that must jointly fit under one interval is a sum nobody maintains.
 * The worst case stays MAX_IN_PASS_WAITS x IN_PASS_WAIT_MS, which
 * mergeOnComment.test.js already pins against the relay's real interval read
 * out of install_bus_relay.sh.
 *
 * A SPENT BUDGET IS NOT A REFUSAL TO LOOK. It returns `timeoutMs: 0`, which
 * still takes one read and no sleep — and one read is the whole of the
 * queue-less path, where `gh pr merge` has already merged synchronously by the
 * time it returns. So a pass that has spent its waits still observes every
 * ordinary merge correctly; it just does not linger on one GitHub is holding.
 *
 * @param used  waits already spent this pass (inPassBudget.used)
 * @param cap   how many the pass gets (inPassBudget.cap)
 * @param waitMs per-wait ceiling
 * @returns {{ timeoutMs: number, charged: boolean }}
 */
function mergeObserveBudget({ used = 0, cap = MAX_IN_PASS_WAITS, waitMs = IN_PASS_WAIT_MS } = {}) {
  if (!mayWaitInPass(used, cap)) return { timeoutMs: 0, charged: false };
  return { timeoutMs: waitMs, charged: true };
}

/**
 * Did that merge observation actually SPEND one of the pass's waits?
 *
 * WHY THIS IS NOT `observeBudget.charged` (round 3 of task 86bbv35cq). The
 * slot was drawn BEFORE the observation, so a queue-less merge — which returns
 * on the first read having slept 0ms, and is every merge on this repo today —
 * still cost one of three. Measured: three ordinary merges in a pass left
 * `used = 3/3`, and `mayWaitInPass` then refused the fourth ticket its real
 * review-gate or CI wait and deferred it a whole ten-minute interval. For
 * waits that never happened.
 *
 * That is criterion 5 — "it must work identically with NO queue enabled" —
 * broken on the live path, by the accounting rather than by the wait.
 *
 * So the budget is charged on the way OUT, on evidence: `sleptMs` is what the
 * observation really blocked for. `charged` still gates it, because a pass
 * with no slots left is handed `timeoutMs: 0` and must not somehow spend a
 * fourth.
 *
 * @param charged  whether a slot was available (mergeObserveBudget().charged)
 * @param sleptMs  what the observation actually blocked for (waitForMerge)
 */
function mergeObservationSpendsSlot({ charged = false, sleptMs = 0 } = {}) {
  return Boolean(charged) && Number(sleptMs) > 0;
}

/**
 * Given a freshly re-read gate and how long we have been waiting, what next?
 *
 * Deliberately does NOT re-implement the gate. `merge`, `refuse` and
 * `conflict` are handed straight back to the paths that already handle them,
 * so there is exactly one place that decides whether something may merge.
 *
 * `refusalCode` RIDES THROUGH, AND THAT IS LOAD-BEARING (review round 1 of
 * task 86bbtqpxd). This function is the funnel BOTH in-pass waits go through
 * — `waitForChecksInPass` spreads its answer straight to the caller — so
 * dropping the code here left every refusal discovered while waiting
 * unclassified. Two things followed, and both were worse than the bug this
 * ticket set out to kill: the relay pass THREW (`classifyRefusal` has no
 * default, by design) and died mid-pass, and the one path that supplied a
 * fallback code relabelled genuinely terminal reasons — "the PR is CLOSED" —
 * as transient, rebuilding the exact standing-approval lie on a fresh path.
 *
 * The rule this encodes: a gate object whose action is a refusal carries the
 * code that classifies it, through every hand-off, unconditionally. Anything
 * that rebuilds a gate object copies the code with it. (Written without the
 * literal raise-site spelling on purpose: refusalClass.test.js COUNTS that
 * string to prove every raise site is classified, and a comment quoting it
 * would be an eleventh refusal that carries no code.)
 *
 * @returns {{ action: 'merge'|'refuse'|'conflict'|'update-branch'|'catch-up-locally'|'wait'|'poll-again', reason?: string, refusalCode?: string }}
 */
function afterCatchUpDecision({ gate, elapsedMs = 0, budgetMs = IN_PASS_WAIT_MS } = {}) {
  const action = String(gate?.action || '');

  // Terminal answers go back to the existing paths untouched — code included.
  if (action === 'merge' || action === 'refuse' || action === 'conflict') {
    return { action, cannotTell: Boolean(gate.cannotTell), reason: gate.reason, ...(gate.refusalCode ? { refusalCode: gate.refusalCode } : {}) };
  }

  // Behind main is also terminal: no amount of polling makes a branch catch
  // itself up, so waiting out the budget on it can only end in a wrong-reason
  // answer — "CI was still running" about a branch whose CI was fine (found
  // in review, 2026-08-30, task 86bbmk7pv). Ending the wait here hands it to
  // the next pass, where the catch-up path already lives.
  if (action === 'update-branch') {
    return { action, cannotTell: Boolean(gate.cannotTell), reason: gate.reason || 'the branch fell behind main while waiting' };
  }

  // Same reasoning, different remedy (task 86bbuvcwc). A branch GitHub has
  // flagged as CONFLICTING while git calls it clean does not un-flag itself
  // either, so polling it out can only end in a wrong-reason answer. It goes
  // back terminal, to the caller that owns the local catch-up.
  if (action === 'catch-up-locally') {
    return {
      action,
      disagreement: true,
      cannotTell: Boolean(gate.cannotTell),
      reason: gate.reason || 'GitHub and git disagree about whether this branch conflicts',
    };
  }

  // Anything else means "not resolved yet". Out of budget is a WAIT — the
  // same outcome the pass used to return immediately — never a merge.
  if (Number(elapsedMs) >= Number(budgetMs)) {
    return {
      action: 'wait',
      // THE VERDICT'S CLASSIFICATION SURVIVES THE TIMEOUT. Running out of
      // budget does not turn a pull request GitHub cannot read into one it
      // can — if the last gate reading was a cannot-tell, this is still one,
      // whatever the sentence below says about CI.
      cannotTell: Boolean(gate && gate.cannotTell),
      reason: `CI was still running after ${Math.round(Number(budgetMs) / 1000)}s; the next pass will pick it up`,
    };
  }

  return { action: 'poll-again', cannotTell: Boolean(gate && gate.cannotTell), reason: gate?.reason || 'checks still running' };
}

/**
 * WHAT THE COMMENT PROMISES AND WHAT THE MARKER DOES, BUILT TOGETHER
 * (2026-08-23, task 86bbk0g4u).
 *
 * The merge path posts a comment to the operator and writes a marker for
 * itself, and until now those were written in two different places with
 * nothing tying them together. They drifted, in the worst possible
 * direction: the conflict hand-off told him "then your merge still stands
 * and this goes through" while writing a marker that no later pass would
 * ever look at again. He read that promise on eleven tickets and every one
 * of them was dead.
 *
 * So every notice is built by a function here that returns the body AND the
 * marker as one object. The marker's kind decides which promise the body is
 * allowed to make, and a test asserts that pairing for every notice there
 * is — which is only possible because they are no longer written apart.
 */
const APPROVAL_CARRIES_OVER = '**Your approval is still standing — you do not have to say "merge" again.** Every later pass re-checks this ticket, so the moment the reason above is dealt with it goes through on its own. You will only hear from this step again if the answer changes.';

// There is deliberately NO "your approval is spent" wording here. The ticket
// offered two fixes — say the spent thing truthfully, or stop spending it —
// and this takes the second. Every notice below either carries the approval
// over or is the merge itself, so a sentence telling him to say "merge" twice
// would have nothing left to describe. If a future outcome IS terminal and
// not a merge, it needs that sentence written back, and the test at the
// bottom of mergeOnComment.test.js is what will notice.

/**
 * WHAT THE APPROVAL PROMISE NOW ALSO DEPENDS ON (2026-08-30, task 86bbq0fh8).
 *
 * A re-decidable marker was treated as licence to say "it goes through on its
 * own". That is only true if somebody is going to deal with the reason — and
 * on a conflict, nobody was. The hand-off asked the bus for an agent session,
 * nothing reads the bus, and PR #434 sat three days under a comment saying it
 * was progressing.
 *
 * So every notice now declares its ACTOR as well as its marker, and the two
 * together decide the promise:
 *
 *   'later-pass' — the reason can clear without anyone acting (CI goes green,
 *                  a missing comment gets added). A later pass merges it.
 *   'loop-queue' — resolving it is filed as a Queued ticket the build loop
 *                  drains. A named actor, running on a timer today.
 *   'nobody'     — nothing is going to pick this up. The body MUST say the
 *                  work is stalled and MUST NOT promise a merge.
 *   'none'       — already merged; there is no next actor and no promise.
 *
 * Passive voice is the tell (vault `doctrine/TERMINOLOGY.md`, 2026-08-29): a
 * hand-off that cannot name a specific waiting actor does not get to imply
 * one. `actor` is that name, made structural so a test can check it.
 */
const ACTOR_PROMISES = {
  'later-pass': true,
  'loop-queue': true,
  // A TERMINAL refusal: the reason will never clear on its own, so no pass is
  // coming and the body must say who has to act instead (task 86bbtqpxd). The
  // hyphenated name is the two actors the `needs` sentences name out loud, so
  // the structural field and the prose cannot drift apart into a message that
  // implies an actor it never names (`docs/DOCTRINE.md` §2.5).
  'agent-or-operator': false,
  nobody: false,
  none: false,
};

/** May this notice tell him the approval carries over? Only if the marker is
 *  re-decidable AND a named actor is going to act on the reason. */
function mayPromiseApproval({ marker, actor }) {
  if (markerKind(marker) === 'terminal') return false;
  return ACTOR_PROMISES[actor] === true;
}

/** The kind a marker string parses back as, without the timestamp tail. */
function markerKind(what) {
  const parsed = parseMergeMarker(`${MERGE_MARKER} ${what}`);
  return parsed ? parsed.kind : 'terminal';
}

/**
 * A precondition failed, or GitHub says the PR cannot be merged safely.
 *
 * WHICH PROMISE THIS MAKES DEPENDS ON THE REASON'S CLASS, NOT ON ITS WORDING
 * (2026-09-03, task 86bbtqpxd). Until now every refusal said the same thing —
 * "your approval is still standing ... it goes through on its own" — and that
 * sentence is true of "checks are red" and flatly false of "the PR is already
 * merged". Ticket 86bbqw49y carried twenty-five of them, sixteen for a reason
 * no pass could ever clear, and sat twelve hours with its work already live.
 *
 * So the class comes from `refusalClass.js`, keyed on the code the raise site
 * chose:
 *
 *   transient — unchanged. The marker is re-decidable, a later pass merges on
 *               the same word, and the body says so truthfully.
 *   terminal / unknown — the promise is dropped entirely and replaced by the
 *               reason's own `needs` sentence, which names WHO must act.
 *
 * THE MARKER STAYS RE-DECIDABLE EVEN WHEN THE MESSAGE IS TERMINAL, and that
 * is deliberate. Terminal describes the REASON, not the operator's word: if an
 * agent session records the missing PR, his "merge" should still be good. A
 * terminal marker would spend it and make him say it twice for someone else's
 * omission. What changes is what he is TOLD, which is the whole defect.
 *
 * `refusalCode` is required. An absent or unknown one throws (there is no
 * default), because a refusal that could not be classified is exactly the one
 * that would otherwise inherit the reassuring wording by accident.
 */
function refusalNotice({ commentId, why, plainEnglish, refusalCode }) {
  const kind = classifyRefusal(refusalCode).kind;
  const terminal = speaksAsTerminal(refusalCode);
  const closing = terminal ? refusalNeeds(refusalCode) : APPROVAL_CARRIES_OVER;
  return {
    marker: `refused: ${why}`,
    actor: terminal ? 'agent-or-operator' : 'later-pass',
    refusalCode,
    terminal,
    // `terminal` answers "may this promise the approval carries over?" and is
    // deliberately true for BOTH 'terminal' and 'unknown'. `kind` is the
    // three-way answer, and the bus post needs it: announcing a CANNOT-TELL
    // as "no later pass will clear it" is a certainty the gate did not have,
    // and it contradicted the ticket comment posted beside it (review round 1
    // of task 86bbtqpxd). A caller that flattens the two says something the
    // classification does not.
    kind,
    body: `Merge not performed. ${plainEnglish}\n\nWhy: ${why}.\n\n${closing}\n\n(Automatic: your comment ${commentId} on this ticket was read as a merge authorization. Nothing on GitHub or this ticket was changed. — bus-relay merge step)`,
  };
}

/**
 * The ONE LINE the bus hears about a refusal, keyed on the reason's class.
 *
 * THREE CLASSES, THREE SENTENCES (review round 1 of task 86bbtqpxd). The
 * relay used to branch on `notice.terminal`, which is true of 'unknown' as
 * well as 'terminal' — so a CANNOT-TELL refusal was announced here as "no
 * later pass will clear it" while the ticket comment posted beside it
 * correctly said it could not say. Two surfaces, one occurrence, contradicting
 * each other, and the CERTAIN one was the wrong one: `blockedCannotTell`
 * routinely does clear on the next pass. A gate that could not tell must never
 * be quoted as though it had.
 *
 * It lives here, next to the body it accompanies, for the same reason the
 * marker does: two places writing about one occurrence is two chances to drift,
 * and the drift is always in the reassuring direction.
 */
function refusalBusLine({ label, url, why, kind }) {
  const head = `${machineSenderTag('bus-relay')} Merge NOT performed on ${label} (${url}): ${why}.`;
  if (kind === 'terminal') {
    return `${head} This reason is TERMINAL — no later pass will clear it and this step will not post about it again. It needs an agent session or ${operatorName()}; the ticket comment says what. It is still Ready to launch.`;
  }
  if (kind === 'unknown') {
    return `${head} This step CANNOT TELL whether a later pass would clear it, and it will not post about it again — so an agent session or ${operatorName()} has to look. The ticket comment says what. It is still Ready to launch.`;
  }
  if (kind === 'transient') {
    return `${head} Explanation posted on the ticket; it is still Ready to launch.`;
  }
  // No default sentence, for the same reason refusalClass has no default
  // class: a line written for a class nobody declared would say whichever
  // thing was cheapest to write.
  throw new Error(
    `refusalBusLine: unknown refusal class ${JSON.stringify(kind)} — every class in REFUSAL_CLASSES needs its own sentence`,
  );
}

/**
 * The branch conflicts and a script never resolves a conflict blind — but a
 * human resolving it does not need a second authorization. The marker is
 * re-decidable (see LEGACY_HAND_OFF_RE for why it used not to be), so the
 * body says so, and says plainly what the person has to do first.
 *
 * `localVerdict` is what THIS machine found when it tried the merge itself:
 * THREE outcomes, and collapsing any two of them sends the reader after the
 * wrong thing (the kinds live in conflictWork.js, which is the only place that
 * decides them — this list is a reader's summary, not a second definition):
 *
 *   'real-conflict'   — the branches genuinely overlap. Somebody must decide
 *                       what the merged file says.
 *   'no-overlap'      — the local merge came back clean; it heals itself.
 *   'could-not-check' — the check never ran. NO FINDING WAS MADE, so no
 *                       message here may claim one.
 *
 * (An earlier 'unknown' kind fused the last two and was retired on 2026-08-31,
 * review round 2 of task 86bbq80j5: copy written for it asserted a finding the
 * pass had not made.)
 *
 * (A third kind, 'needs-rebuild', existed while committed HTML carried
 * ?v= asset pins; retired 2026-08-24 with the pins themselves, task 86bbkh288.)
 *
 * `filed` is the NAMED ACTOR (2026-08-30, task 86bbq0fh8): `{ id, url }` for
 * the Loop Queue ticket that will resolve the conflict, or null when no such
 * ticket exists. Null is not a formatting detail — it means nothing is going
 * to pick this up, and the body says exactly that instead of promising a
 * merge. That promise, made with no actor behind it, is what left PR #434
 * sitting for three days under a comment saying it was progressing.
 */
function conflictHandOffNotice({ commentId, pr, localVerdict, filed }) {
  // Two different situations wear the same GitHub answer, and only one of them
  // retries usefully. Saying "it will merge next run" about a real overlap is
  // the same shape of untrue promise this whole ticket family exists to
  // remove — so the two get different sentences, and the difference comes from
  // the localVerdict rather than from a guess.
  //
  // ONE predicate, shared with the filing decision in clickup_direct.mjs
  // (task 86bbq80j5). This function used to derive it here and the merge step
  // did not consult it at all, so a lost push race was filed as a conflict
  // while this very body promised it would heal itself. Neither side gets to
  // hold its own copy of the answer any more.
  // THREE answers, not two (review round 2). `isSelfHealing` is the only one
  // that licences "no overlap was found"; `couldNotCheck` says plainly that
  // nothing was looked at, which is what a wrong repo, a failed fetch or a
  // missing scratch worktree actually is. Collapsing those two produced a
  // ticket comment saying it could not check beside a bus post asserting a
  // finding, seconds apart.
  const realOverlap = isRealOverlap(localVerdict);
  const selfHealing = isSelfHealing(localVerdict);
  const permanent = isPermanent(localVerdict);
  const because = realOverlap
    ? `this branch and \`main\` have both changed the same lines — ${localVerdict.reason}`
    : selfHealing
      ? `GitHub called it a conflict, but this machine merged it here with no overlap at all — ${localVerdict.reason}`
      : localVerdict
        ? `GitHub called it a conflict, and this machine could not check whether that is true — ${localVerdict.reason}`
        : 'GitHub reported that the branch conflicts with newer work on `main`, and no local check was attempted';
  // Who acts next, said out loud. Anything that is not a proven no-overlap is
  // work somebody has to do — deciding what a merged file says, or finding out
  // why the check could not run — and the only honest sentence names who is
  // going to do it. With a filed ticket that is the build loop, which drains
  // the Loop Queue on a timer today. Without one it is nobody, and the body
  // must say so rather than reach for the passive voice that hid the missing
  // actor before. This reads the SAME predicate the filing decision reads.
  const actor = conflictActor({ localVerdict, filed });

  // What the work IS, and what to CALL it — both differ between the two
  // non-healing answers. A ticket that tells its builder to resolve an overlap,
  // when no overlap was ever established, sends them looking for markers that
  // may not be there: the original 2026-08-30 defect, one level down.
  //
  // The real-overlap wording is left EXACTLY as it was. Review round 2
  // verified those two bodies byte-for-byte against main as evidence that the
  // round-1 fix had not disturbed them, and that is a property worth keeping
  // rather than a coincidence to spend.
  const theWork = realOverlap
    ? 'Sorting that overlap out is a code change rather than a decision, and a script must never resolve one blind, so it was not attempted.'
    : `Whether there is anything to resolve is still unknown — the local check did not run${permanent ? ', and it never will from the relay machine: the branch is in a repo that machine has no checkout of, so every future pass returns this same answer' : ''}.`;
  // From the shared table, not from a local ternary (review round 3). This is
  // the noun the FILED TICKET's title has to agree with, and it did not: the
  // comment said "Finding out" and pointed at a ticket titled "Resolve the
  // merge conflict on...". Both read one entry now, so they cannot disagree.
  const theHandOver = verdictCopy(localVerdict).handOver;

  let whatHappensNext;
  if (selfHealing) {
    whatHappensNext = 'It will be merged on the next run, unless something else is in the way by then — GitHub\'s answer about a branch is often minutes stale.';
  } else if (filed) {
    whatHappensNext = `${theWork} ${theHandOver} is now ticket ${filed.id} (${filed.url}) in the Loop Queue, which the build loop drains every pass. Once that branch is caught up and its checks are green, this merges on a later run.`;
  } else {
    // The stalled sentence. It is deliberately blunt: this is the state that
    // cost three days, and a reader must not be able to finish this paragraph
    // thinking something is underway.
    whatHappensNext = `${theWork} **Nothing is currently working on it** — filing the resolution as a Loop Queue ticket did not succeed, so no build loop will pick this up and this PR will not merge on its own. It needs an agent session pointed at the branch, which means asking for one.`;
  }

  const marker = `refused: conflict hand-off on PR #${pr.number}`;
  const promise = mayPromiseApproval({ marker, actor })
    ? `${APPROVAL_CARRIES_OVER}\n\n`
    : '';
  return {
    marker,
    actor,
    // The verdict travels WITH the actor so the merge step never has to
    // re-derive either one (review round 3).
    kind: conflictVerdictKind(localVerdict),
    body: `This task was not able to merge on the last attempt, because ${because}.\n\n${whatHappensNext}\n\n${promise}Nothing was merged and nothing was changed; the ticket stays Ready to launch.\n\n${pr.url}\n\n(Automatic — bus-relay merge step, authorized by your comment ${commentId}.)`,
  };
}

/**
 * The one genuinely terminal outcome. Re-deciding a merged PR is the single
 * mistake that cannot be undone, so this marker stays spent forever and the
 * body makes no promise about a next pass — there is not going to be one.
 */
function mergedNotice({ commentId, pr, mergedAt, lane, files }) {
  // WHOSE WORD MERGED IT (2026-08-25, task 86bbkw2au). Until Lane A there was
  // only one answer — his comment — and the sentence said so. Now there are
  // two, and a record that says "merged on operator comment 123" about a merge
  // he never authorized would be the worst kind of untrue: it would read, to
  // him and to any later audit, as evidence of an approval that does not
  // exist. So the attribution is built from what actually happened.
  const because = lane
    ? `auto-merged under Lane ${lane} after a one-hour objection window with no objection` +
      (files && files.length ? `, qualified by: ${files.map((f) => `\`${f}\``).join(', ')}` : '')
    : `merged on operator comment ${commentId}`;
  return {
    marker: `merged PR #${pr.number} at ${mergedAt}`,
    actor: 'none',
    body: `Merged: PR #${pr.number} (${pr.url}) squash-merged into main at ${mergedAt}, ${because}. Checks were green and the branch was up to date at merge time; the branch has been deleted. main auto-deploys, so this is on its way live now.\n\n(Automatic — bus-relay ${lane ? 'auto-merge' : 'merge step'}.)`,
  };
}

/**
 * The conflicted paths from `git merge-tree --write-tree --name-only`: line one
 * is the tree id, then one path per line up to the first blank line (after which
 * come git's informational messages).
 */
function mergeTreeConflictFiles(stdout) {
  const lines = String(stdout || '').split('\n');
  const files = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) break;
    if (!files.includes(line.trim())) files.push(line.trim());
  }
  return files;
}

/**
 * Where a conflicting pull request goes next: the local catch-up attempt, or
 * straight to the hand-off (2026-10-07, task 86bcemvj5).
 *
 * The catch-up attempt pushes when it succeeds, so it must hold the merge
 * window — and a PR waiting for the window is a PR nobody has handed off. That
 * was fine while the attempt was the only way to learn whether a conflict was
 * real. It is not when `git merge-tree` has ALREADY said so: the attempt can
 * only fail, so queuing for the right to make it buys nothing and costs the
 * whole queue ahead. On 2026-10-07 three approved PRs with git-confirmed
 * conflicts (#771, #779, #780) waited ~85 minutes behind a window that was
 * busy the entire time, logging MERGE WAITING every pass, and Dane heard
 * nothing until he asked.
 *
 *   'hand-off'       — git confirmed it: no window, no catch-up, no arming
 *   'catch-up'       — GitHub said so and nothing confirmed it: try the merge here
 *   'not-a-conflict' — anything else
 */
function conflictRoute(gate) {
  if (!gate || gate.action !== 'conflict') return 'not-a-conflict';
  return gate.gitConfirmed === true ? 'hand-off' : 'catch-up';
}

/**
 * GITHUB'S AUTO-MERGE, AND WHY THE RELAY STOPPED WAITING (2026-09-03, task
 * 86bbup3u1).
 *
 * `main` is protected with `strict: true`, so a branch must contain every
 * commit on main to merge, and every merge invalidates every other open
 * branch. The relay's answer was to catch the branch up itself and then wait
 * out CI in-pass. That works when the queue is quiet and CANNOT work when it
 * is busy, which is exactly when the merge lane matters: catch up, restart
 * CI, run out of budget, defer — and by the next pass main has moved again.
 * On 2026-09-03 the operator said "merge" at 15:43 and the PR was still open
 * an hour later, having gone round that loop four times. Nothing refused and
 * nothing errored; every pass was a healthy pass.
 *
 * The fix is to stop racing. GitHub will hold a merge itself: armed on a PR,
 * auto-merge lands it the moment the required checks pass, and with
 * `allow_update_branch` on it does the catch-up too. The relay arms it and
 * goes home.
 *
 * WHAT ARMING IS NOT. It is not a second merge gate. Arming happens ONLY on
 * the two non-terminal answers — `wait` (checks still running) and
 * `update-branch` (behind main) — which the existing gate reaches only after
 * every other precondition already holds: the PR is open, not a draft, not
 * conflicting, no check is red, and the operator's word is on the ticket.
 * `refuse` and `conflict` are untouched and never arm. GitHub then applies
 * the branch protection rules on its own account, so an armed PR whose checks
 * later go red does not merge.
 */
function autoMergeDecision({ gate, autoMergeRequest, reviewGateState, alreadyMerged = false } = {}) {
  if (alreadyMerged) return { action: 'none', reason: 'the PR is already merged' };

  const armed = Boolean(autoMergeRequest);
  const review = String(reviewGateState || '');

  // THE ONE THING GITHUB DOES NOT CHECK FOR US, AND IT IS THIS REPO'S OWN
  // REVIEW GATE. Branch protection on `main` requires exactly one check,
  // `verify`. `review-gate` runs on every PR but is NOT required, so GitHub's
  // auto-merge — which enforces the protection rules and nothing else —
  // would happily land a PR whose review gate is stale or red. The relay's
  // own merge path refuses that case outright, so arming without this guard
  // would delegate the merge to a WEAKER gate than the one being replaced,
  // which is the kind of trade that gets made once and discovered later.
  //
  // So the review gate is checked HERE, before arming, and is re-checked on
  // every later pass: a PR that goes stale after it was armed is DISARMED
  // rather than left to GitHub. 'absent' passes for the same reason the merge
  // path lets it through — a PR carrying no review-gate check at all is a
  // different situation from one carrying a bad answer, and it is not this
  // function's to redefine.
  const reviewOk = review === 'fresh' || review === 'absent' || review === '';
  if (!reviewOk) {
    return armed
      ? {
          action: 'disarm',
          reason: `the review gate is "${review}", which GitHub's auto-merge does not check — disarming so this merge goes back through the relay's own gate`,
        }
      : { action: 'none', reason: `the review gate is "${review}", so this PR is not in a state to hand to GitHub` };
  }

  const action = String((gate && gate.action) || '');
  if (action !== 'wait' && action !== 'update-branch') {
    return { action: 'none', reason: `the gate says "${action || 'nothing'}", which is not a state that arms auto-merge` };
  }

  if (armed) {
    return { action: 'already-armed', reason: 'auto-merge is already armed on this PR; GitHub lands it when the checks pass' };
  }

  return {
    action: 'arm',
    reason: action === 'update-branch'
      ? 'the branch is behind main — GitHub catches it up and merges when the checks pass'
      : 'the checks are still running — GitHub merges when they pass',
  };
}

/**
 * How long an armed PR may sit before its silence is worth a word.
 *
 * AN ARMED MERGE THAT NEVER FIRES IS A NEW KIND OF QUIET, and it is the thing
 * this ticket's own incident should teach. Before auto-merge, a pass that
 * could not merge said so every ten minutes in its log. After it, the pass
 * ends cleanly having handed the PR to GitHub — and if GitHub then never
 * merges it (a check goes red later, someone pushes, the arming is dropped,
 * a protection rule changes) there is nothing on our side still watching.
 * "Handed off" would read exactly like "done".
 *
 * Two hours is chosen against the thing it must not cry wolf about: a CI run
 * here is ~6 minutes and the relay wakes every 10, so anything still armed
 * after two hours has missed roughly twelve chances to merge and is not
 * merely slow.
 */
const AUTO_MERGE_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * Has an armed PR been armed too long? Returns a REASON, not just a boolean,
 * because the caller puts it in front of a person.
 *
 * A missing or unreadable `enabledAt` is NOT treated as "fine": it comes back
 * as `cannot-tell`, which the caller reports rather than swallows. Reading an
 * unknown as healthy is how the silence this guards against gets rebuilt one
 * level up.
 */
function autoMergeArmedTooLong({ autoMergeRequest, now = Date.now(), thresholdMs = AUTO_MERGE_STALE_MS } = {}) {
  if (!autoMergeRequest) return { state: 'not-armed' };

  const raw = autoMergeRequest.enabledAt || autoMergeRequest.enabled_at || '';
  const at = Date.parse(raw);
  if (!raw || Number.isNaN(at)) {
    return {
      state: 'cannot-tell',
      reason: 'auto-merge is armed but GitHub did not say when it was armed, so how long it has been waiting cannot be read',
    };
  }

  const heldMs = Number(now) - at;
  if (heldMs < Number(thresholdMs)) return { state: 'ok', heldMs };

  const hours = Math.floor(heldMs / 3_600_000);
  const mins = Math.round((heldMs % 3_600_000) / 60_000);
  return {
    state: 'stale',
    heldMs,
    reason: `auto-merge has been armed on this PR for ${hours}h ${mins}m without landing — GitHub is holding it for something (a check that went red after arming, a push that dropped the arming, or a protection rule that is not satisfied)`,
  };
}

/**
 * The PR is MERGED and an unhandled merge authorization is still sitting on
 * the ticket. Before auto-merge this could only mean somebody merged by hand,
 * and the gate's answer — refuse, "the PR is already merged" — was a fair
 * description of what the relay itself had done. Once the relay arms GitHub
 * to merge on its behalf it becomes the ORDINARY ending, and a refusal notice
 * telling the operator his merge was not performed, on a ticket whose PR is
 * merged, is simply false.
 *
 * So a merged PR with a live authorization completes the bookkeeping the
 * merge path would have done: record it and move the ticket to Live. This
 * cannot double-merge — the merge already happened; the only thing left is
 * saying so.
 */
function mergedElsewhereNotice({ commentId, pr, mergedAt, armed }) {
  const how = armed
    ? "GitHub's auto-merge landed it, which this relay armed on your word"
    : 'it was merged outside this relay (by hand, or by another session)';
  return {
    marker: `merged PR #${pr.number} at ${mergedAt}`,
    actor: 'none',
    body: `Merged: PR #${pr.number} (${pr.url}) is merged into main — ${how}. Recorded here on your merge command ${commentId}, and this ticket is moving to Live. main auto-deploys, so this is on its way live now.\n\n(Automatic — bus-relay merge step.)`,
  };
}


/**
 * How long one unchanging CANNOT TELL may repeat before somebody is told.
 *
 * MEASURED, NOT CHOSEN (2026-09-04, task 86bbuvd50 — and the ticket asked for
 * this explicitly, because the 2026-09-02 recency-alarm proposal died of a
 * number picked from a single incident).
 *
 * Every `MERGE WAITING ... CANNOT TELL` line in the relay's own launchd log,
 * grouped by ticket, first sighting to last:
 *
 *   86bbugcpa   16 lines   09:23 -> 12:02   2h39m   an agent session unstuck it
 *   86bbuvcwc   16 lines   09:55 -> 12:33   2h38m   an agent session unstuck it
 *   86bbpz1hu   13 lines   10:37 -> 12:44   2h07m   an agent session unstuck it
 *   86bbtqpxd    6 lines   23:56 -> 00:50     54m   cleared on its own
 *   86bbpz1gd    4 lines   14:20 -> 15:04     44m   cleared on its own
 *   86bbugzep    2 lines   16:04 -> 16:44     40m   cleared on its own
 *   86bbugeda    2 lines   08:40 -> 08:50     10m   cleared on its own
 *   86bbqz7rg    1 line                        —    cleared on its own
 *   86bbjt1b0    1 line                        —    cleared on its own
 *
 * **Nothing sits between 54 minutes and 2h07m.** That empty gap chose the
 * threshold, the same way DOCTRINE 6.22's did. Ninety minutes is above every
 * run that has ever resolved itself and below every run that has ever needed
 * hands, with roughly half an hour of margin on each side.
 *
 * MEASURED IN TIME, NOT IN PASSES, and that is deliberate. A ticket only
 * produces a line on passes where the relay actually looks at it — 86bbugzep's
 * two lines span forty minutes, not twenty — so a pass count is not a clock.
 * The count is still reported, because it is what a reader wants to see; it is
 * simply not what the decision turns on.
 *
 * DO NOT UNIFY THIS WITH `pipelinePause.STRANDED_AFTER_MS`, which is also 90
 * minutes. The equality is a coincidence of two independent measurements: that
 * one bounds how long a BUILD PASS may legitimately take, this one bounds how
 * long GitHub may legitimately be undecided. They will move for different
 * reasons, and a future reader tidying them into one constant would couple two
 * unrelated clocks — the drift failure this repo already carries three
 * comments about.
 */
const CANNOT_TELL_STALE_MS = 90 * 60 * 1000;

/**
 * Is this pass looking at the SAME BLOCK the stored run is counting?
 *
 * A block is one pull request stuck on one commit — NOT one form of words.
 * Review round 1 of task 86bbuvd50 killed the first answer, which compared the
 * reason TEXT: replayed over the relay's own log it escalated on one of the
 * three blocks that actually needed hands, because GitHub alternates between
 * two CANNOT TELL wordings inside a single block
 *
 *   CANNOT TELL — GitHub reports this branch as CONFLICTING, but git merges
 *   origin/main into a6f52c23 cleanly (merge-tree exit 0)...
 *   CANNOT TELL yet — GitHub is still computing whether the branch merges
 *   cleanly; the next pass asks again
 *
 * (Those are the wordings AS LOGGED. PR #597 has since dropped the
 * `CANNOT TELL — ` prefix from the first one — which is what review round 2
 * caught, and why `verdictCannotTell` no longer reads any of this prose.)
 *
 * and 86bbpz1hu alternated eight times in thirteen passes — its longest
 * unbroken streak of one wording was about thirty minutes, so the clock reset
 * long before ninety was ever reached. Both wordings are the same fact:
 * GitHub cannot give a stable answer about this branch. The prose is GitHub's
 * polling state; the head commit is the thing that actually changed or did not.
 *
 * UNKNOWN IS A WILDCARD, NEVER A DIFFERENCE. A pass that could not read the PR
 * has no SHA to compare — that is the ticket's own "a rate-limited read" — and
 * treating an unreadable pass as a new block would restart the clock every time
 * GitHub rate-limited us, which is this bug wearing a different hat. Only a
 * KNOWN difference on both sides ends a run. An old record written before this
 * field existed has no `headSha` either, and continues for the same reason.
 */
function sameCannotTellBlock(previous, identity = {}) {
  if (!previous) return false;
  const differs = (a, b) => a != null && b != null && String(a) !== String(b);
  if (differs(previous.pr, identity.pr)) return false;
  if (differs(previous.headSha, identity.headSha)) return false;
  return true;
}

/**
 * Should this repeated CANNOT TELL be escalated, and has it already been?
 *
 * PURE. The caller owns reading and writing `prev` (the per-PR ledger entry);
 * this only decides. That split is why the quiet-after-escalating rule can be
 * tested without a ledger, a relay pass or a clock.
 *
 * WHAT THIS DOES NOT DO (the ticket's non-goals, restated where they can be
 * violated): it never claims a conflict, never refuses a merge and never
 * cancels auto-merge. CANNOT TELL is a CORRECT verdict — only its silence was
 * wrong. Every branch below returns the same `verdict` it was handed.
 *
 * @param {object|null} prev   the stored run: { pr, headSha, reason, rewordings, firstSeenAt, passes, escalatedAt }
 * @param {string} verdict     this pass's reason text, verbatim ('' if not a cannot-tell)
 * @param {boolean} isCannotTell  whether this pass's verdict is a cannot-tell at all
 * @param {object} identity    what this pass is stuck ON: { pr, headSha }; either may be
 *                             null when it could not be read, and an unknown never
 *                             ends a run — see sameCannotTellBlock
 * @returns {{ state:'clear'|'new'|'holding'|'escalate'|'quiet', next:object|null, escalate:boolean, reason?:string }}
 */
function cannotTellRun({ prev, verdict, isCannotTell, identity = {}, now = Date.now(), thresholdMs = CANNOT_TELL_STALE_MS } = {}) {
  // Not a cannot-tell this pass — the block is over, whatever it was. Returning
  // `next: null` is what leaves NO RESIDUE: a resolved wobble must not make the
  // next unrelated block start half-way to an alarm.
  if (!isCannotTell) return { state: 'clear', next: null, escalate: false };

  const reason = String(verdict || '').trim();
  const previous = prev && typeof prev === 'object' ? prev : null;

  // What this pass is stuck ON. An unknown field is carried forward from the
  // stored run rather than overwritten with null, so one unreadable pass does
  // not erase the identity the next pass would have compared against.
  const pr = identity.pr != null ? identity.pr : (previous ? previous.pr : null);
  const headSha = identity.headSha != null ? identity.headSha : (previous ? previous.headSha : null);
  const at = { pr: pr == null ? null : pr, headSha: headSha == null ? null : headSha };

  // A DIFFERENT BLOCK is a different fact, so the clock restarts and the new
  // run may escalate later on its own merits. "Different" is a different pull
  // request or a different head commit — never a different form of words; see
  // sameCannotTellBlock for the log that settled it.
  if (!sameCannotTellBlock(previous, identity)) {
    return {
      state: 'new',
      next: { ...at, reason, rewordings: 0, firstSeenAt: now, passes: 1, escalatedAt: null },
      escalate: false,
    };
  }

  // A POSITIVE FINITE NUMBER, nothing looser. `Number(null)` is 0 and 0 is
  // finite, so a plain `Number.isFinite` check would read a null timestamp as
  // the epoch — making heldMs about 56 years and escalating instantly on a
  // corrupt record. The test for this caught it; the noisy direction is as
  // wrong as the silent one.
  const rawFirst = previous.firstSeenAt;
  const firstSeenAt = typeof rawFirst === 'number' && Number.isFinite(rawFirst) && rawFirst > 0
    ? rawFirst
    : NaN;
  const passes = Number(previous.passes || 0) + 1;

  // An unreadable stored timestamp is NOT read as "just started" — that would
  // make the alarm unreachable forever, which is this ticket's own bug wearing
  // a different hat (and exactly what task 86bbu60ax found in the claim reader
  // on 2026-09-04). It restarts the clock and says so by leaving escalatedAt
  // null, so the next pass can still get there.
  if (!Number.isFinite(firstSeenAt)) {
    return {
      state: 'new',
      next: { ...at, reason, rewordings: 0, firstSeenAt: now, passes: 1, escalatedAt: null },
      escalate: false,
    };
  }

  const heldMs = Number(now) - firstSeenAt;
  // The NEWEST wording is what gets stored and quoted — the run is identified
  // by the commit, but the message must say what GitHub is saying now, not
  // what it said ninety minutes ago. `rewordings` counts how many times that
  // answer has been reworded, because "GitHub has given three different
  // answers about the same commit" IS the diagnosis in the alternating case.
  const reworded = String(previous.reason || '') !== reason;
  const rewordings = Math.max(0, Number(previous.rewordings || 0) + (reworded ? 1 : 0));
  const carried = { ...at, reason, rewordings, firstSeenAt, passes, escalatedAt: previous.escalatedAt || null };

  // ESCALATED ALREADY — the whole point of the bound. It stays silent until the
  // verdict changes or clears, both of which are handled above. Without this
  // branch the fix would post every ten minutes forever, which is the failure
  // REPORTING-NEEDS-A-READER clause 2 names: one noisy escalation beats 820
  // silent ones, and N escalations beat neither.
  if (previous.escalatedAt) return { state: 'quiet', next: carried, escalate: false };

  if (heldMs < Number(thresholdMs)) return { state: 'holding', next: carried, escalate: false };

  const hours = Math.floor(heldMs / 3_600_000);
  const mins = Math.round((heldMs % 3_600_000) / 60_000);
  const held = hours ? `${hours}h ${mins}m` : `${mins}m`;
  // TWO WORDINGS OF THE SAME SENTENCE, because "answered the same way" is
  // FALSE of the alternating case and that case is the common one — 84 of the
  // 108 measured lines are one wording and the rest are GitHub's "still
  // computing", interleaved. Claiming a verbatim repeat where there was none
  // would make the message argue with the log a reader is about to open.
  const what = rewordings > 0
    ? `This pull request has been unable to settle on an answer for ${held} across ${passes} pass(es) — `
      + `it has reworded itself ${rewordings} time(s) while the commit has not moved. The newest is: `
    : `This pull request has answered the same way for ${held} across ${passes} pass(es) and has not moved: `;
  return {
    state: 'escalate',
    next: { ...carried, escalatedAt: now },
    escalate: true,
    heldMs,
    reason:
      what
      + `"${reason}" — a verdict that will not settle is not a momentary wobble, and nothing on `
      + `this side will say so again until it changes or clears. It needs an agent session or ${operatorName()} to look. `
      + 'Nothing was merged, refused or cancelled by this message.',
  };
}

/**
 * Did this verdict take a reading of the pull request at all?
 *
 * ASKED OF THE VERDICT, NEVER OF ITS PROSE (review round 2 of task
 * 86bbuvd50). This used to test `/CANNOT TELL/` against the reason SENTENCE,
 * and it was already broken on the day it shipped: PR #597 — merged to main
 * before the branch that carried it — deleted the `CANNOT TELL — ` prefix
 * from the dominant verdict and changed its action to `catch-up-locally`.
 *
 * 84 of the 106 classifiable lines in the measured log stopped classifying,
 * and the failure was worse than under-counting. An unclassified pass reads
 * as `clear`, which DELETES the stored run — so every CONFLICTING pass wiped
 * the clock the "still computing" passes had built up, and the longest
 * unbroken run of the one surviving wording is about thirty minutes. Ninety
 * was unreachable. The bound merged green, passed every gate, and said
 * nothing on the exact incident it was written for.
 *
 * So the classification is declared where the verdict is MADE — every
 * `githubGate` return carries `cannotTell` explicitly, and a source assertion
 * fails on any that omits it. That assertion would have failed on the day
 * #597 landed. A future rewording cannot unhook the bound again, because no
 * wording is read.
 *
 * THE POPULATION IS UNCHANGED, deliberately. The verdicts marked true are the
 * same two the ninety-minute threshold was measured on — GitHub-says-
 * CONFLICTING-while-git-says-clean (84 lines) and GitHub-is-still-computing
 * (22) — plus the paths that could not reach GitHub at all, which is the
 * ticket's own "a rate-limited read". A routine six-minute CI wait is a
 * reading, and counting it would be a threshold measured on one population
 * applied to a wider one: the calibration error the ticket warned about,
 * wearing a louder coat.
 *
 * Callers that KNOW no reading was taken — a failed `gh pr view`, unparseable
 * JSON — pass `cannotTell: true` directly rather than through here. What no
 * caller may do is leave the question unanswered, which is why every
 * `outcome: 'waiting'` return is checked by a source assertion too.
 */
function verdictCannotTell(verdict) {
  return Boolean(verdict && verdict.cannotTell);
}

/**
 * The one message a bounded CANNOT TELL run gets to send.
 *
 * It says, in this order, the four things the ticket asked for and the one
 * thing that makes them actionable: how long, how many passes, the verdict
 * VERBATIM (never a summary — the wording is the diagnosis), who wrote this
 * and from which machine, and what a person can actually do about it.
 *
 * It also says what it did NOT do. Every non-goal on the ticket is a thing a
 * reader will otherwise assume happened: nothing was merged, nothing was
 * refused, auto-merge was not cancelled, and the operator's approval is
 * untouched. A message that leaves that ambiguous is the 86bbqw49y defect —
 * an automated note that let the reader infer a merge decision it never made.
 */
function cannotTellEscalation({ label, taskUrl, pr, prUrl, decision, node, at } = {}) {
  const machine = node ? `on ${node}` : 'on an unnamed machine';
  const prBit = pr ? `PR #${pr}` : 'this pull request';
  const when = at ? ` at ${at}` : '';
  const body = [
    `**Stuck on the same answer — ${prBit} has not moved.**`,
    '',
    decision.reason,
    '',
    'What a person can do: read the pull request on GitHub and find out which of '
    + 'the two disagreeing sources is right — the checks, the mergeability, the '
    + 'branch protection. If it needs a push, it needs an agent session; if it '
    + 'needs nothing, it will clear on its own and this goes quiet by itself.',
    '',
    `Auto-merge is exactly as it was and the merge command still stands. ${prUrl || ''}`.trim(),
    '',
    `(Automatic — bus-relay merge step, ${machine}${when}.)`,
  ].join('\n');

  const bus = `${machineSenderTag('bus-relay')} MERGE STUCK — ${label}${taskUrl ? ` (${taskUrl})` : ''}: `
    + `${decision.reason} Written by the bus-relay merge step ${machine}.`
    + `${prUrl ? `\n\n${prUrl}` : ''}`;

  return { body, bus };
}

module.exports = {
  REFUSAL_CODES: R,
  classifyRefusal,
  speaksAsTerminal,
  refusalNeeds,
  IN_PASS_WAIT_MS,
  AUTO_MERGE_STALE_MS,
  CANNOT_TELL_STALE_MS,
  cannotTellRun,
  sameCannotTellBlock,
  verdictCannotTell,
  cannotTellEscalation,
  autoMergeDecision,
  conflictRoute,
  mergeTreeConflictFiles,
  autoMergeArmedTooLong,
  mergedElsewhereNotice,
  IN_PASS_POLL_MS,
  MAX_IN_PASS_WAITS,
  mergeObserveBudget,
  mergeObservationSpendsSlot,
  mayWaitInPass,
  afterCatchUpDecision,
  MERGE_MARKER,
  parseMergeMarker,
  countMergeRefusals,
  latestMergeMarker,
  normalizeCommand,
  stripEditorFormatting,
  commentDate,
  isMergeCommand,
  isReviewVerdict,
  isReviewPassed,
  findPullRequest,
  findPullRequests,
  mergeDecision,
  checkState,
  githubGate,
  MERGE_STATE_STATUSES,
  unmetProtectionRule,
  markerKind,
  mayPromiseApproval,
  refusalNotice,
  refusalBusLine,
  conflictHandOffNotice,
  mergedNotice,
  APPROVAL_CARRIES_OVER,
  // Getters LAST. Node's ESM named-import detection reads this list top to
  // bottom and stops at the first entry that is not a plain name, so a
  // getter anywhere earlier hides every name after it from `import { … }`.
  // The getters themselves stay out of named imports on purpose: a named
  // import is copied once at load time, which would freeze the config read
  // they exist to defer. Read them through the module object instead.
  get MERGE_PHRASES() { return mergePhrases(); },
};
