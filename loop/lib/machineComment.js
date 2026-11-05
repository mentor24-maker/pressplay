'use strict';

/**
 * "Did a machine write this comment, or did Dane?"
 *
 * WHY THIS EXISTS (2026-09-01, task 86bbqx2xe). The loops post to ClickUp
 * under Dane's own API token, so every card a machine writes comes back from
 * the API stamped with HIS user id. Everything downstream asked authorship the
 * only way it could — `Number(c.user.id) === OPERATOR_ID` — and got "yes" for
 * comments no human had ever seen.
 *
 * The damage was the escalation lane. `ask` posts an operator card and moves a
 * ticket to `Needs your input` with Dane assigned; the next bus-relay pass, ten
 * minutes later, read that card as a fresh answer FROM him, relayed it to the
 * bus as "Dane replied", and handed the ticket back to `Queued`. The ticket
 * left `Assigned to me` — the one view he trusts — and the next loop-build pass
 * would claim it and try to build the very thing that had been escalated. The
 * card stayed on the ticket, so from the ticket it looked handled. Only the
 * status and the assignee were gone.
 *
 * It hid well because it is self-limiting: the hand-back is gated on FRESHLY
 * relayed comments, so re-setting the status by hand sticks and only the
 * original escalation is lost.
 *
 * `waiting` was fooled by the same mechanism, in the quieter direction — it
 * under-reports. A `Ready to launch` ticket always has a machine card as its
 * newest comment, so `waiting` answered "his own comment is the newest word on
 * it" and called it NOT_WAITING. An agent asking "does anything need Dane?"
 * before writing its run report was told no while five merges sat parked.
 * That blindness was already self-confirming once: the override note on
 * 86bbpz1ed cited `waiting` as evidence that the guard had been fooled — a
 * tool fooled by the same mechanism.
 *
 * THE FIX IS A MARKER, NOT A TOKEN. The real fix is a separate ClickUp
 * identity for the loops, and it is entangled with 86bbq8qa8; this is the
 * cheap one that works today and does not depend on the token at all.
 *
 * IT IS STAMPED AT ONE CHOKE POINT. `call()` in clickup_direct.mjs stamps
 * every POST to a comment endpoint, because there are fourteen separate
 * comment-posting sites in that file and a fifteenth added later would fail
 * SILENTLY IN THE DANGEROUS DIRECTION — an unmarked machine card reads as
 * Dane's word and releases his escalation. Stamping at the door means a new
 * caller inherits the guard instead of having to remember it.
 *
 * WHICH WAY IT FAILS. Detection is deliberately anchored to the LAST non-empty
 * line, which is where the stamp is written and nowhere else. So if Dane
 * pastes a machine card ABOVE words of his own, the marker lands mid-text and
 * his comment is still read as his.
 *
 * IT ONLY HOLDS FOR THAT ONE ORDERING, and the qualifier was missing here
 * until 2026-09-06 (task 86bbv8nvy round 2). Paste the card UNDERNEATH his
 * words and the stamp is the last line of HIS comment, so the whole thing
 * reads as machine-written — and quoting below your reply is at least as
 * natural as quoting above it.
 *
 * WHAT THAT COSTS DEPENDS ENTIRELY ON THE CALL SITE, which is why this note
 * cannot answer for all of them:
 *
 *   - HERE, at the escalation and the kill switch, mistaking his word for a
 *     machine's leaves the escalation unreleased. The ticket stays with him,
 *     he is not told it was handled, and the failure is LOUD. That is the
 *     correct direction, and the opposite of the bug this replaces.
 *
 *   - AT LANE A's objection filter it is the reverse: a discounted objection
 *     MERGES the pull request he said hold on, silently, an hour later. That
 *     site therefore cannot run on the stamp alone, and does not — see
 *     `quotesMachineText` in scripts/builder/autoMergeLane.js. Any future
 *     caller whose failure direction is an action rather than a stall owes
 *     itself the same second question.
 *
 * COMMENTS WRITTEN BEFORE THIS SHIPPED carry no marker and still read as his.
 * Nothing can be done about that from here; the legacy prefixes below catch
 * the machine comments that already announced themselves.
 */

/** The stamp. Its own line, at the end of the comment, written by `call()`. */
const { operatorName, legacyMachinePrefixes } = require('./substrateConfig.js');
const MACHINE_MARKER = '[machine]';

/** The whole line, phrased for Dane — he reads these tickets, and a bare
 *  token in the margin of every card explains nothing.
 *
 *  Built on every call, never at load: the operator's name is config, and the
 *  config is the working directory's. A launchd runner requires this module
 *  with its working directory at `/`, so a name read at load time would freeze
 *  as "the operator" for every card it stamps (review of task 86bcgmnpy). */
function machineMarkerLine() {
  return `${MACHINE_MARKER} posted by a loop under ${operatorName()}'s token — not his word`;
}

/**
 * Comments that announced themselves as machine-written before this marker
 * existed. Matched at the START of the comment, which is where these prefixes
 * are written. Kept short on purpose: every entry is a phrase Dane could in
 * principle type himself, and a false positive here ignores something he said.
 */
const SHARED_MACHINE_PREFIXES = [
  // These name an AGENT or a LANE, not a product, so they are the same
  // everywhere and stay here.
  '[Antigravity]',
  '[CC-pulse]',
  '[auto-merge]',
  '[bus-relay]',
];

/** The product's own retired prefixes come from its config: `[CC-starcaster]`
 *  is StarCaster's history, not a fact about the loop (CLAUDE.md rule 2). Read
 *  per call, for the same reason as `machineMarkerLine`. */
function legacyMachinePrefixList() {
  return [...legacyMachinePrefixes(), ...SHARED_MACHINE_PREFIXES];
}

/**
 * The same idea as the list above, but matching the FAMILY rather than the
 * exact strings — because the list could only ever hold the signatures
 * somebody had already thought of.
 *
 * Found by rehearsal, 2026-09-05 (task 86bbuv99r). The party line carries
 * `[CC-starcaster loop-build]`, `[CC-starcaster loop-review]` and
 * `[reconciler]` many times a day, and not one of them matched: the exact
 * string `[CC-starcaster]` does not prefix `[CC-starcaster loop-build]`, and
 * `[reconciler]` was never listed at all. Every one of those posts was
 * therefore being read as DANE'S OWN WORDS on the channel where the kill
 * switch is read — which is task 86bbt038u's failure exactly, still live in
 * the half of it that enumerated signatures instead of describing them.
 *
 * Still tight: the tag must be the very first thing in the message, inside
 * brackets, and its first token must name a machine sender. Nothing Dane
 * types starts that way — his messages on the bus are prose.
 */
// NOT `machine` — the [machine] marker is deliberately honoured only on the
// LAST non-empty line (a body that OPENS with it is a person quoting one), and
// putting it in this head-anchored family quietly repealed that rule.
const MACHINE_TAG = /^\[\s*(cc-[a-z0-9-]+|ag-[a-z0-9-]+|antigravity|cx-[a-z0-9-]+|cr-[a-z0-9-]+|bus-relay|auto-merge|reconciler)\b[^\]]*\]/i;

/**
 * Undo the editor's markdown escaping before matching a prefix.
 *
 * ClickUp's CHAT api hands back "\\[CC-starcaster bus-relay\\] ..." — it escapes
 * the brackets it would otherwise read as markdown. Every prefix below starts
 * with "[", so without this every agent post on the party line read as Dane's
 * own words. Verified against live channel content, not assumed: before this,
 * all six most recent bus messages classified as "his word", including three
 * the relay had posted itself (task 86bbt038u).
 *
 * Only the BACKSLASH is dropped, and only where it escapes markdown
 * punctuation, so nothing Dane actually typed changes meaning.
 */
function unescapeMarkdown(text) {
  return String(text == null ? '' : text).replace(/\\([[\]()*_`~#!>+\-.])/g, '$1');
}

/** The last line with anything on it, or '' for an empty comment. */
function lastNonEmptyLine(text) {
  const lines = String(text == null ? '' : text).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return '';
}

/**
 * Is this comment machine-written?
 *
 * `null`/`undefined` text is NOT treated as machine-written: an unreadable
 * comment is an unknown, and the callers that care already have a
 * "could not tell" path. Answering "machine" for a read we never made is the
 * DOCTRINE 3.11 failure in a new place.
 */
function isMachineComment(text) {
  if (text == null) return false;
  const s = unescapeMarkdown(text);
  if (!s.trim()) return false;
  if (lastNonEmptyLine(s).startsWith(MACHINE_MARKER)) return true;
  const head = s.trimStart();
  if (legacyMachinePrefixList().some((p) => head.startsWith(p))) return true;
  return MACHINE_TAG.test(head);
}

/**
 * Is this comment machine-written BY THE STAMP ALONE?
 *
 * The strict half of `isMachineComment`, for the one call site where a false
 * "a machine wrote this" discards something Dane said.
 *
 * WHY IT IS SEPARATE (2026-09-06, task 86bbv8nvy round 1). `isMachineComment`
 * answers two questions at once: the tail stamp `call()` writes, and a
 * head-anchored tag a machine announced itself with before the stamp existed.
 * The head half is deliberately wide — the bus kill-switch reader and the
 * reconciler both need it, and it was widened on purpose (task 86bbuv99r)
 * because the party line carries `[CC-starcaster loop-build]` and
 * `[reconciler]` all day.
 *
 * But a head-anchored tag is exactly what Dane types when he QUOTES a card and
 * replies under it, which is how he objects. Measured:
 *
 *     "[CC-starcaster loop-review] REVIEW: PASSED ...
 *      wait, do not merge this yet — I want to look"
 *
 * — his words, classified as a machine's. Only a body whose LAST line is the
 * stamp counts here, which is the same choice `isMachineComment` makes for the
 * stamp, kept and nothing else.
 *
 * THIS IS NOT A COMPLETE ANSWER TO QUOTING, and the first version of this note
 * claimed it was: "a pasted card puts the marker MID-text". That is true only
 * when he types AFTER the paste. Pasted UNDER his words, the card's stamp is
 * the last line of his comment and this reader says machine. A caller that
 * cannot afford that reading needs a second question — Lane A's objection
 * filter asks `quotesMachineText`; see the note at the head of this file for
 * why the answer differs by call site.
 *
 * IT COSTS NOTHING TO BE THIS STRICT. Sampled 2026-09-06 over 110 real
 * comments on 40 Loop Queue tickets: 100 classify as machine-written, and
 * every one of them via the tail stamp. Zero needed the head tag.
 *
 * `null`/`undefined` text is NOT machine-written, for the same reason as
 * above: a read we never made is an unknown, not a verdict.
 */
function isStampedMachineComment(text) {
  if (text == null) return false;
  const s = unescapeMarkdown(text);
  if (!s.trim()) return false;
  return lastNonEmptyLine(s).startsWith(MACHINE_MARKER);
}

/**
 * Add the stamp. Idempotent — stamping an already-stamped body returns it
 * unchanged, so a caller that stamps and then passes through `call()` (or a
 * retry of the same post) cannot end up with two.
 *
 * IDEMPOTENCE IS ON THE STAMP, NOT ON THE WIDE READER (2026-09-06, task
 * 86bbv8nvy round 1). It used to skip anything `isMachineComment` recognised,
 * which meant a machine card OPENING with a head tag (`[CC-starcaster ...]`,
 * `[auto-merge]`) was posted with no stamp at all — it already "looked
 * machine", so the door saw no work to do. Nothing was wrong while every
 * reader used the wide form; `isStampedMachineComment` reads the stamp alone,
 * and would have called such a card Dane's word.
 *
 * Measured before changing it: over 125 real Loop Queue comments, 114 machine-
 * written and all 114 carrying the stamp — so no live comment took that path.
 * This closes it by construction rather than by sampling, and the change only
 * ever adds a marker that was missing.
 */
function stampMachineComment(text) {
  const s = String(text == null ? '' : text);
  if (isStampedMachineComment(s)) return s;
  const trimmed = s.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n\n${machineMarkerLine()}` : machineMarkerLine();
}

/**
 * Does this request body post a comment, and if so which key holds the text?
 * ClickUp's task-comment endpoint takes a plain `comment_text`, OR a rich
 * `comment` array of `{ text, attributes }` blocks. Returns the key, or null
 * when this body is not a comment post at all.
 */
/**
 * The comment text WITHOUT the machine stamp `call()` appended.
 *
 * WHY (2026-09-06, task 86bbvr0j5). The stamp is written at the door, onto
 * every machine comment — including the merge step's own dedup marker, whose
 * format predates it and ends in ` — <ISO timestamp>`. The stamp put a second
 * em-dash AFTER that timestamp, so `parseMergeMarker`'s `lastIndexOf(' — ')`
 * found the one in "Dane's token — not his word", failed to split the
 * timestamp off, and returned a reason with the timestamp and the whole stamp
 * glued to it. It therefore never equalled the reason the next pass compared
 * it against, so the merge step's dedup silently stopped working on the day
 * the stamp shipped: PR #628 posted the identical conflict hand-off seven
 * times in two hours, and the stall alarm behind that comparison became
 * unreachable.
 *
 * Anchored on the LAST non-empty line, exactly like `isMachineComment` — same
 * question, so it must not be a second definition that can drift. A body that
 * does not end in the stamp comes back unchanged.
 */
function stripMachineMarker(text) {
  const raw = String(text == null ? '' : text);
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    // Only the stamp, and only at the end. Anything else means this comment
    // does not carry one and must come back untouched.
    if (!line.startsWith(MACHINE_MARKER)) break;
    return lines.slice(0, i).join('\n').trim();
  }
  return raw.trim();
}

function commentTextKey(body) {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.comment_text === 'string') return 'comment_text';
  if (typeof body.comment === 'string') return 'comment';
  if (Array.isArray(body.comment)) return 'comment';
  return null;
}

/**
 * Flatten the rich block form to the text ClickUp will store, which is what
 * comes back as `comment_text` on a read and what every consumer reads.
 */
function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.map((b) => String(b && b.text != null ? b.text : '')).join('');
}

/**
 * Stamp the rich block form.
 *
 * THIS IS THE ONE THAT MATTERED (2026-09-01). The operator card `ask` posts —
 * the exact comment whose misreading caused this ticket — goes out as blocks,
 * not as a string. The first cut of this module skipped non-string bodies on
 * the reasoning that guessing at an unknown shape could corrupt a comment;
 * the live break-test posted a real card and found it unmarked, with `waiting`
 * still calling it Dane's word. A guard that skips the case it was written for
 * is not a cautious guard, it is an absent one.
 */
function stampMachineCommentBlocks(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  // The stamp, not the wide reader — same reason as `stampMachineComment`.
  if (isStampedMachineComment(blocksToText(blocks))) return blocks;
  return blocks.concat([{ text: `\n${machineMarkerLine()}` }]);
}

/**
 * Stamp whichever shape this body carries. Returns the body unchanged when it
 * is not a comment post, so the caller can pass everything through.
 */
function stampCommentBody(body) {
  const key = commentTextKey(body);
  if (!key) return body;
  const value = body[key];
  if (typeof value === 'string') return { ...body, [key]: stampMachineComment(value) };
  return { ...body, [key]: stampMachineCommentBlocks(value) };
}

/** Is this the path of a comment-creating POST? Task comments and threaded
 *  replies both — a dedup marker written as a reply is a machine comment too. */
function isCommentPostPath(path) {
  const p = String(path || '');
  return /^\/api\/v2\/task\/[^/]+\/comment(\?|$)/.test(p)
    || /^\/api\/v2\/comment\/[^/]+\/reply(\?|$)/.test(p);
}

module.exports = {
  MACHINE_MARKER,
  machineMarkerLine,
  legacyMachinePrefixList,
  MACHINE_TAG,
  isMachineComment,
  isStampedMachineComment,
  stampMachineComment,
  stampMachineCommentBlocks,
  stampCommentBody,
  blocksToText,
  commentTextKey,
  stripMachineMarker,
  isCommentPostPath,
  lastNonEmptyLine,
  // Getters, so the names StarCaster's callers already use stay, while the
  // value is read from the config at the moment it is used.
  // Getters LAST. Node's ESM named-import detection reads this list top to
  // bottom and stops at the first entry that is not a plain name, so a
  // getter anywhere earlier hides every name after it from `import { … }`.
  // The getters themselves stay out of named imports on purpose: a named
  // import is copied once at load time, which would freeze the config read
  // they exist to defer. Read them through the module object instead.
  get MACHINE_MARKER_LINE() { return machineMarkerLine(); },
  get LEGACY_MACHINE_PREFIXES() { return legacyMachinePrefixList(); },
};
