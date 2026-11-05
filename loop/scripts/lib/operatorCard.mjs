/**
 * The operator card — the fixed shape of every message a loop puts in front
 * of Dane on a ClickUp ticket. Adapted from StarCaster's operatorCard.js.
 *
 * Detail goes LEFT (the task description, which has room). The right-hand
 * comment column carries a short card with exactly three parts: Dane's own
 * words that caused the ticket, the problem and the fix in 50-100 plain
 * words, and the specific ask under a banner he can spot without reading.
 *
 * Authored as plain text with `@@SECTION` markers on their own lines:
 *
 *   @@ASKED
 *   build the to-do list
 *   @@WHEN
 *   2026-10-11 9:40am, in the planning session
 *   @@CONTEXT
 *   ...50-100 words...
 *   @@NEEDED
 *   ...the ask...
 *   @@EVIDENCE            (only when the ask costs money or cannot be undone)
 *   @@MEASURED 8:04pm
 *   ```
 *   the command and what it printed
 *   ```
 *
 * ClickUp DELETES `> ` blockquote lines from comments and descriptions — not
 * unformatted, gone, with a clean 200. So a card is refused if it carries one,
 * and Dane's words go in a fence, the one form ClickUp keeps verbatim.
 */

import sharedCard from '../../lib/operatorCard.js';

// The one-line move ("Your move: Close — …") is the shared module's rule, read
// from there so the card `ask` posts and the card the page reads agree (SP-68).
export const { YOUR_MOVES, readYourMove, yourMoveProblems } = sharedCard;

export const MARKERS = ['ASKED', 'WHEN', 'CONTEXT', 'NEEDED', 'EVIDENCE'];
export const CONTEXT_MIN_WORDS = 50;
export const CONTEXT_MAX_WORDS = 100;

const BANNER_RULE = '#'.repeat(29);
const BANNER_LABEL = 'NEEDED FROM DANE: ';
export const BANNER_COLOR = '#CC0000';

/** Words the way a person counts them: a token has to carry a letter or digit. */
export function countWords(text) {
  return String(text || '').split(/\s+/).filter((tok) => /[\p{L}\p{N}]/u.test(tok)).length;
}

export function parseCard(text) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = {};
  let current = null;
  const preamble = [];
  for (const line of lines) {
    const match = /^@@([A-Z]+)\s*$/.exec(line.trim());
    if (match) {
      const name = match[1];
      if (name === 'MEASURED') {
        throw new Error('@@MEASURED takes the time on the SAME line — "@@MEASURED 8:04pm" — and it belongs inside @@EVIDENCE.');
      }
      if (!MARKERS.includes(name)) {
        throw new Error(`"@@${name}" is not a card section. Use ${MARKERS.map((m) => `@@${m}`).join(', ')}.`);
      }
      if (sections[name] !== undefined) throw new Error(`@@${name} appears twice — each section may only be given once.`);
      sections[name] = [];
      current = name;
      continue;
    }
    if (current === null) preamble.push(line);
    else sections[current].push(line);
  }
  if (preamble.some((l) => l.trim())) {
    throw new Error('There is text before the first @@ section. Start the card with @@ASKED so nothing is dropped.');
  }
  const trim = (name) => (sections[name] || []).join('\n').trim();
  return { asked: trim('ASKED'), when: trim('WHEN'), context: trim('CONTEXT'), needed: trim('NEEDED'), evidence: trim('EVIDENCE') };
}

/** 1-based lines that start a markdown blockquote, outside fences. */
export function findBlockquoteLines(text) {
  const found = [];
  fenceLines(text).forEach(({ line, role }, i) => {
    if (role === 'prose' && /^\s*>/.test(line)) found.push(i + 1);
  });
  return found;
}

/**
 * A backtick fence that `text` cannot close: one longer than its longest
 * backtick run, and never shorter than three. Dane's words may carry their
 * own ``` lines; a plain ``` round them would end at his first one.
 */
export function fenceFor(text) {
  const longest = Math.max(0, ...(String(text || '').match(/`+/g) || []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Words in an ask that mean it spends money or cannot be undone. */
const COSTLY = /\b(spend|spending|buy|pay|paying|purchase|subscribe|subscription|upgrade|plan change|rotate|rotation|delete|deletes|deleting|drop|drops|cannot be undone|irreversible|wipe|wipes)\b/i;

export function costlyTriggers(needed) {
  const found = new Set();
  const re = new RegExp(COSTLY.source, 'gi');
  let m;
  while ((m = re.exec(String(needed || ''))) !== null) found.add(m[1].toLowerCase());
  return [...found];
}

const CLOCK = /^((?:\d{4}-\d{2}-\d{2}\s+|\d{1,2}\/\d{1,2}\s+)?\d{1,2}:\d{2}\s*(?:am|pm))$/i;
const MEASURED_LINE = /^[ \t]*@@MEASURED\b[ \t]*(.*?)[ \t]*$/i;

const FENCE_MARK = /^\s*(`{3,}|~{3,})/;

/**
 * Every line of `text` with its place in the fences: 'open', 'close', 'body'
 * (inside a fence) or 'prose'. The ONE scanner the card check and the card
 * builders share, so they cannot disagree on where a fence ends. A fence opens
 * on ``` or ~~~ and closes only on the same character, at least as long,
 * with nothing after it: a ``` inside a ```` block is literal text. The
 * tracker page's renderer (tracker/web/render.mjs) follows the same rule.
 */
export function fenceLines(text) {
  let fence = null;
  return String(text || '').split('\n').map((line) => {
    const mark = FENCE_MARK.exec(line);
    if (fence === null) {
      if (!mark) return { line, role: 'prose' };
      fence = mark[1];
      return { line, role: 'open' };
    }
    if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !line.trim().slice(mark[1].length).trim()) {
      fence = null;
      return { line, role: 'close' };
    }
    return { line, role: 'body' };
  });
}

export function splitFences(text) {
  const prose = [];
  const blocks = [];
  let open = null;
  for (const { line, role } of fenceLines(text)) {
    if (role === 'open') open = [];
    else if (role === 'close') { blocks.push(open); open = null; } else if (role === 'body') open.push(line);
    else prose.push(line);
  }
  if (open !== null && open.length) blocks.push(open);
  return { prose: prose.join('\n'), blocks };
}

export function evidenceTimestamp(text) {
  const { prose } = splitFences(text);
  const declared = prose.split('\n').map((l) => MEASURED_LINE.exec(l)).filter(Boolean).map((m) => m[1].trim());
  if (declared.length !== 1) return null;
  const m = CLOCK.exec(declared[0]);
  return m ? m[1] : null;
}

function evidenceProblems(card) {
  const problems = [];
  const triggers = costlyTriggers(card.needed);
  const evidence = String(card.evidence || '').trim();
  if (!triggers.length && !evidence) return problems;
  if (triggers.length && !evidence) {
    problems.push(
      `@@EVIDENCE is missing, and this ask is a costly one (${triggers.join(', ')}). An ask that spends money\n` +
      '  or cannot be undone has to carry the check that proves it: the command in runnable form, its ACTUAL\n' +
      '  output in a ``` fence, and when you ran it on a line of its own ("@@MEASURED 8:04pm").',
    );
    return problems;
  }
  const { blocks } = splitFences(evidence);
  const filled = blocks.filter((lines) => lines.some((l) => l.trim()));
  const pasted = filled.reduce((n, lines) => n + lines.filter((l) => l.trim()).length, 0);
  if (!filled.length) problems.push('@@EVIDENCE has no fenced block. Put the command and its output inside ``` fences.');
  else if (pasted < 2) problems.push('@@EVIDENCE shows a command with no output under it. Paste what it actually printed.');
  if (!evidenceTimestamp(evidence)) {
    problems.push('@@EVIDENCE needs exactly one "@@MEASURED 8:04pm" line in its prose (outside the fence), in Mountain time, dated if not today.');
  }
  return problems;
}

/** Every problem with a card, as plain sentences. Empty when the card is good. */
export function validateCard(card) {
  const problems = [];
  const words = countWords(card.context);
  if (!card.asked) {
    problems.push("@@ASKED is empty. It must carry Dane's own words that caused this ticket, verbatim. If there is no instruction, say so and name the standing decision it descends from — never invent a quote.");
  }
  if (!card.context) problems.push('@@CONTEXT is empty. It must explain the problem and the fix in plain English.');
  else if (words < CONTEXT_MIN_WORDS) problems.push(`@@CONTEXT is ${words} words; the floor is ${CONTEXT_MIN_WORDS}. Under that it stops carrying enough to act on.`);
  else if (words > CONTEXT_MAX_WORDS) problems.push(`@@CONTEXT is ${words} words; the ceiling is ${CONTEXT_MAX_WORDS}. The long version belongs in the description (use describe).`);
  if (!card.needed) problems.push('@@NEEDED is empty. State the specific ask. "Nothing right now" is a fine answer, but write it down.');
  problems.push(...yourMoveProblems(card.needed));
  problems.push(...evidenceProblems(card));
  // @@ASKED is exempt: the card puts his words in a fence of its own, where a
  // "> " line of his is literal text and survives.
  for (const name of ['context', 'needed', 'evidence']) {
    const offending = findBlockquoteLines(card[name]);
    if (offending.length) {
      problems.push(`@@${name.toUpperCase()} uses a "> " blockquote (line ${offending.join(', ')}). ClickUp DELETES those lines. Use plain text, **bold** or a fenced block.`);
    }
  }
  return problems;
}

function bannerLines(needed) {
  const askLines = String(needed || '').trim().split('\n');
  return [BANNER_RULE, `${BANNER_LABEL}${askLines[0]}`, ...askLines.slice(1), BANNER_RULE];
}

function evidenceBody(text) {
  return fenceLines(text)
    .filter(({ line, role }) => role !== 'prose' || !MEASURED_LINE.test(line))
    .map(({ line }) => line).join('\n').trim();
}

/** The card as blocks — the one description both renderers read. Banner LAST. */
export function cardBlocks(card) {
  const blocks = [
    { kind: 'heading', text: "DANE'S WORDS — the instruction behind this ticket" },
    { kind: 'fence', text: card.asked },
  ];
  if (card.when) blocks.push({ kind: 'note', text: `(${card.when})` });
  blocks.push({ kind: 'heading', text: "WHAT'S GOING ON" }, { kind: 'prose', text: card.context });
  if (card.evidence) {
    const when = evidenceTimestamp(card.evidence);
    blocks.push(
      { kind: 'heading', text: `THE CHECK BEHIND THIS ASK${when ? ` — measured at ${when}` : ''}` },
      { kind: 'prose', text: evidenceBody(card.evidence) },
    );
  }
  blocks.push({ kind: 'banner', lines: bannerLines(card.needed) });
  return blocks;
}

function inlineRuns(text) {
  const runs = [];
  const pattern = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
  let last = 0;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) runs.push({ text: m[1], attributes: { bold: true } });
    else runs.push({ text: m[2], attributes: { code: true } });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}

function proseRuns(text) {
  const runs = [];
  const { blocks: fences } = splitFences(text);
  let fenceIndex = 0;
  let open = false;
  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    runs.push(...inlineRuns(paragraph.join('\n') + '\n'));
    paragraph = [];
  };
  for (const { line, role } of fenceLines(text)) {
    if (role === 'open') { flush(); open = true; } else if (role === 'close') {
      open = false;
      runs.push({ text: `${(fences[fenceIndex++] || []).join('\n')}\n`, attributes: { 'code-block': 'plain' } });
    } else if (role === 'prose') paragraph.push(line);
  }
  if (open) runs.push({ text: `${(fences[fenceIndex] || []).join('\n')}\n`, attributes: { 'code-block': 'plain' } });
  flush();
  return runs;
}

/** ClickUp's structured comment body: the banner is bold and red. */
export function renderCardComment(card) {
  const runs = [];
  for (const block of cardBlocks(card)) {
    switch (block.kind) {
      case 'heading': runs.push({ text: block.text, attributes: { bold: true } }, { text: '\n\n' }); break;
      case 'note': runs.push({ text: block.text, attributes: { italic: true } }, { text: '\n\n' }); break;
      case 'fence': runs.push({ text: `${block.text}\n`, attributes: { 'code-block': 'plain' } }, { text: '\n' }); break;
      case 'prose': runs.push(...proseRuns(block.text), { text: '\n' }); break;
      case 'banner':
        for (const line of block.lines) runs.push({ text: line, attributes: { bold: true, color: BANNER_COLOR } }, { text: '\n' });
        break;
      default: throw new Error(`unknown card block "${block.kind}"`);
    }
  }
  return runs;
}

/** The same card as markdown text — for the transcript and the read-back check. */
export function renderCard(card) {
  const parts = [];
  for (const block of cardBlocks(card)) {
    switch (block.kind) {
      case 'heading': parts.push(`**${block.text}**`, ''); break;
      case 'note': parts.push(`*${block.text}*`, ''); break;
      case 'fence': { const fence = fenceFor(block.text); parts.push(fence, block.text, fence, ''); break; }
      case 'prose': parts.push(block.text, ''); break;
      case 'banner': parts.push(...block.lines); break;
      default: throw new Error(`unknown card block "${block.kind}"`);
    }
  }
  return parts.join('\n');
}

/** Did Dane's words survive the trip? A problem sentence, or null. */
export function cardSurvived(card, savedText) {
  const flatten = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const asked = flatten(card.asked);
  if (!asked) return null;
  if (flatten(savedText).includes(asked)) return null;
  return "The card posted, but Dane's own words did NOT survive it. ClickUp read back a comment that does not contain @@ASKED. Fix the formatting and post it again.";
}

/** Parse + validate + render. Throws with every problem listed. */
export function buildCard(text) {
  const card = parseCard(text);
  const problems = validateCard(card);
  if (problems.length) {
    throw new Error(`The card is not in the required shape:\n\n- ${problems.join('\n- ')}\n\nNothing was posted and no status was moved.`);
  }
  return { card, rendered: renderCard(card), comment: renderCardComment(card) };
}
