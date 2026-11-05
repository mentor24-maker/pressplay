'use strict';

const { costlyTriggers, describeTriggers } = require('./costlyAsk.js');
const { operatorName } = require('./substrateConfig.js');

/**
 * The operator card — the fixed shape of every message a loop puts in front
 * of Dane on a ClickUp ticket.
 *
 * WHY THIS EXISTS (2026-08-22). Until now the loops wrote their reasoning as
 * a long free-form ClickUp comment. ClickUp shows comments in the narrow
 * right-hand column, so the reasoning arrived as a wall of text in the
 * skinniest part of the screen, while the roomy left-hand column held a spec
 * written for a machine. Two tickets stalled on exactly that: Sync 6/7
 * (86bbev0g3) and Sync 7/7 (86bbev0gx). The operator could not tell what was
 * being asked of him on either one, and 7/7 sat in his inbox for a day
 * demanding an answer that was never actually needed.
 *
 * The fix Dane specified: detail goes LEFT (the task description, which is a
 * document and has room), and the right-hand column carries a short card with
 * exactly three parts —
 *
 *   1. his own words, verbatim, that caused the ticket to exist
 *   2. the problem and the fix in plain English, 50-100 words
 *   3. the specific ask, under a banner he can spot without reading
 *
 * The word range is the point of the whole thing. Under 50 words the card
 * stops carrying enough context to act on; over 100 it becomes the wall of
 * text this replaces. So it is checked, not suggested — see validateCard.
 *
 * Pulled out of clickup_direct.mjs so the shape is testable without a network
 * or a token, the same way busRelayPlan.js is.
 */

/**
 * CLICKUP EATS BLOCKQUOTES (found live, 2026-08-22, while testing this very
 * module). A comment posted through `POST /task/{id}/comment` comes back with
 * every `> quoted line` **deleted** — not unformatted, gone. The comment as a
 * whole is still non-empty, so a length check calls it a success. The first
 * two cards this module ever posted lost the operator's own words that way,
 * which is the single part of a card that cannot be reconstructed.
 *
 * A probe of six forms against the live API (task 86bbgm68r): fenced blocks,
 * bold-italic, four-space indents, plain quotation marks and bold-with-dash
 * all survive intact. `>` is the only casualty. So the operator's words go in
 * a fence — which is also the only form that guarantees nothing INSIDE them is
 * reinterpreted, and verbatim is the contract — and `validateCard` refuses a
 * `>` anywhere, in any section. DOCTRINE 3.10: a write that normalizes to
 * nothing looks exactly like a success, so it gets checked, not assumed.
 *
 * **Task DESCRIPTIONS do it too**, checked separately the same day: the
 * "## Dane asked for" section of the first rewritten ticket came back with the
 * quoted instruction gone. So `findBlockquoteLines` is exported and the
 * `describe` command refuses a body containing one, for the same reason.
 */

/** The three required sections of the authored input, plus two optional ones.
 *  `@@EVIDENCE` is optional in general and REQUIRED when the ask costs money
 *  or cannot be undone — see evidenceProblems below. */
const MARKERS = ['ASKED', 'WHEN', 'CONTEXT', 'NEEDED', 'EVIDENCE'];

const CONTEXT_MIN_WORDS = 50;
const CONTEXT_MAX_WORDS = 100;

/** The banner, exactly as the operator drew it — including the trailing space
 *  after the colon. Built from a named constant so no editor's
 *  strip-trailing-whitespace can quietly reshape it. */
const BANNER_RULE = '#'.repeat(29);
// The operator's name, shouted, is config — read per call, never at load
// (review of task 86bcgmnpy). For StarCaster this is 'NEEDED FROM DANE: '.
function bannerLabel() {
  return `NEEDED FROM ${operatorName().toUpperCase()}:` + ' ';
}

/**
 * Words, counted the way a person counts them: a token has to contain a
 * letter or a digit. Stray punctuation an em-dash on its own line, a bullet
 * character is not a word, and counting it would let a card sneak under the
 * ceiling on dashes.
 */
function countWords(text) {
  return String(text || '')
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
    .length;
}

/**
 * Parse the authored card. The input is plain text with `@@SECTION` markers on
 * their own lines:
 *
 *   @@ASKED
 *   build the chip display
 *   @@WHEN
 *   2026-08-22 10:56am, on this ticket
 *   @@CONTEXT
 *   ...50-100 words...
 *   @@NEEDED
 *   ...the ask...
 *
 *   @@EVIDENCE
 *   @@MEASURED 8:04pm
 *   ...the command and its output, in fences...
 *
 * `@@WHEN` and `@@EVIDENCE` are optional to the parser — `@@EVIDENCE` becomes
 * mandatory in validateCard when the ask itself costs money or cannot be
 * undone. Anything before the first marker is an error rather
 * than silently-dropped text: a card whose first section got eaten is exactly
 * the failure this format exists to prevent.
 */
function parseCard(text) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = {};
  let current = null;
  const preamble = [];

  for (const line of lines) {
    const match = /^@@([A-Z]+)\s*$/.exec(line.trim());
    if (match) {
      const name = match[1];
      if (name === 'MEASURED') {
        // Not a section — it carries its value on the same line, so a bare one
        // is an author who has the right idea and the wrong shape. Saying
        // "@@MEASURED is not a card section" would be true and useless.
        throw new Error(
          '@@MEASURED takes the time on the SAME line — "@@MEASURED 8:04pm" — and it belongs\n' +
          'inside @@EVIDENCE. It is a line, not a section of its own.',
        );
      }
      if (!MARKERS.includes(name)) {
        throw new Error(
          `"@@${name}" is not a card section. Use ${MARKERS.map((m) => `@@${m}`).join(', ')}.`,
        );
      }
      if (sections[name] !== undefined) {
        throw new Error(`@@${name} appears twice — each section may only be given once.`);
      }
      sections[name] = [];
      current = name;
      continue;
    }
    if (current === null) preamble.push(line);
    else sections[current].push(line);
  }

  if (preamble.some((line) => line.trim())) {
    throw new Error(
      'There is text before the first @@ section. Every line of a card has to belong to a\n' +
      'section, or it would be dropped without anyone noticing. Start the file with @@ASKED.',
    );
  }

  const trim = (name) => (sections[name] || []).join('\n').trim();
  return {
    asked: trim('ASKED'),
    when: trim('WHEN'),
    context: trim('CONTEXT'),
    needed: trim('NEEDED'),
    evidence: trim('EVIDENCE'),
  };
}

/**
 * THE ONE-LINE MOVE (2026-10-31, SP-68). Every card's ask ends with one line
 * naming what he does next, `Your move: Merge`, `Your move: Close` or
 * `Your move: Reply`, then a short reason. The ticket page reads the same
 * line (tracker/web/render.mjs, `cardMove`) to draw the button for that move,
 * so he answers from the page instead of reading a paragraph to find it.
 *
 * SP-64's card told him to "move this ticket to Live yourself", which the
 * page has no way to do and no loop may ask: only the relay moves his
 * tickets, on his word. So a card saying that is refused outright.
 */
const YOUR_MOVES = Object.freeze(['Merge', 'Close', 'Reply']);
const YOUR_MOVE_LINE = /^\**\s*Your move:\s*\**\s*(Merge|Close|Reply)\b/i;
const MOVE_IT_YOURSELF = /\bmove\s+(?:this|the)\s+ticket\b[^\n]*\byourself\b/i;

/** The move a card's ask ends with ('Merge' | 'Close' | 'Reply'), or null. */
function readYourMove(needed) {
  const lines = String(needed || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const match = YOUR_MOVE_LINE.exec(lines.at(-1) || '');
  if (!match) return null;
  return YOUR_MOVES.find((m) => m.toLowerCase() === match[1].toLowerCase());
}

/** What is wrong with the ask's move line, as sentences; [] when it is good. */
function yourMoveProblems(needed) {
  const problems = [];
  if (!String(needed || '').trim()) return problems; // "@@NEEDED is empty" already says it
  if (!readYourMove(needed)) {
    problems.push(
      `@@NEEDED must END with one line naming his move: ${YOUR_MOVES.map((m) => `"Your move: ${m}"`).join(', ')},\n` +
      '  then a short reason ("Your move: Close — PR #43 already landed"). The ticket page draws the\n' +
      '  button for that move from this line.',
    );
  }
  if (MOVE_IT_YOURSELF.test(String(needed))) {
    problems.push(
      '@@NEEDED tells him to move the ticket himself. The page cannot, and only the relay moves his\n' +
      '  tickets, on his word: offer "Your move: Close" (or Merge) instead.',
    );
  }
  return problems;
}

/**
 * Everything wrong with a card, as plain sentences an agent can act on.
 * Returns an empty array when the card is good. Reports ALL problems at once
 * rather than the first — a one-at-a-time gate turns into three round trips.
 */
function validateCard(card) {
  const problems = [];
  const words = countWords(card.context);

  if (!card.asked) {
    problems.push(
      '@@ASKED is empty. It must carry the operator\'s own words that caused this ticket to\n' +
      '  exist, quoted verbatim. If there genuinely is no instruction, say so in that section\n' +
      '  and name what the ticket does descend from — never invent a quote.',
    );
  }
  if (!card.context) {
    problems.push('@@CONTEXT is empty. It must explain the problem and the fix in plain English.');
  } else if (words < CONTEXT_MIN_WORDS) {
    problems.push(
      `@@CONTEXT is ${words} words; the floor is ${CONTEXT_MIN_WORDS}. Under that it stops carrying\n` +
      '  enough for the operator to act without opening anything else.',
    );
  } else if (words > CONTEXT_MAX_WORDS) {
    problems.push(
      `@@CONTEXT is ${words} words; the ceiling is ${CONTEXT_MAX_WORDS}. The long version belongs in the\n` +
      '  task description (the left column) — put it there with `clickup describe`.',
    );
  }
  if (!card.needed) {
    problems.push(
      '@@NEEDED is empty. State the specific ask. "Nothing right now" is a perfectly good\n' +
      '  answer and a useful one — but it has to be written down, not left blank.',
    );
  }
  problems.push(...yourMoveProblems(card.needed));

  problems.push(...evidenceProblems(card));

  // @@ASKED is exempt: the card puts his words in a fence of its own, where a
  // "> " line of his is literal text and survives.
  for (const name of ['context', 'needed', 'evidence']) {
    const offending = findBlockquoteLines(card[name]);
    if (offending.length) {
      problems.push(
        `@@${name.toUpperCase()} uses a "> " blockquote (line ${offending.join(', ')}). ClickUp DELETES\n` +
        '  blockquote lines — they do not arrive unformatted, they arrive not at all.\n' +
        '  Use plain text, **bold**, or a fenced block instead.',
      );
    }
  }
  return problems;
}

/**
 * A clock time in the register the operator reads — "8:04pm", "8:04 PM",
 * optionally dated ("2026-08-23 8:04pm", "8/23 8:04pm").
 *
 * Only the operator's own register counts. A bare ISO instant or a unix epoch
 * is a number he has to convert before he can tell whether the measurement is
 * from ten minutes ago or from before the outage, and that conversion is
 * exactly the step nobody performs (OPERATIONS SOP 13).
 *
 * The trailing look-ahead is not decoration. Without it `cron next run 10:15
 * America/New_York` reads as "10:15 Am" and `9:30 ambient` as "9:30 am", so
 * the freshness check passes on text that is not a run time at all.
 */
const CLOCK = /((?:\d{4}-\d{2}-\d{2}\s+|\d{1,2}\/\d{1,2}\s+)?\d{1,2}:\d{2}\s*(?:am|pm))(?![A-Za-z0-9])/i;

const FENCE_MARK = /^\s*(`{3,}|~{3,})/;

/**
 * Every line of `text` with its place in the fences: 'open', 'close', 'body'
 * (inside a fence) or 'prose'. The ONE scanner the card check and the card
 * builders share, so they cannot disagree on where a fence ends. A fence opens
 * on ``` or ~~~ and closes only on the same character, at least as long,
 * with nothing after it: a ``` inside a ```` block is literal text. The
 * tracker page's renderer (tracker/web/render.mjs) follows the same rule.
 */
function fenceLines(text) {
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

/**
 * Split a section into the prose OUTSIDE its fences and the blocks inside
 * them. Both halves are needed and they mean different things: the fences hold
 * what the machine said, the prose holds what the author said about it.
 *
 * Fences are found by fenceLines, so a ``` line inside a ```` block stays
 * part of that block, and ~~~ fences count too.
 */
function splitFences(text) {
  const prose = [];
  const blocks = [];
  let open = null;
  for (const { line, role } of fenceLines(text)) {
    if (role === 'open') open = [];
    else if (role === 'close') { blocks.push(open); open = null; } else if (role === 'body') open.push(line);
    else prose.push(line);
  }
  // An unclosed fence still carried content; count what it holds rather than
  // discarding it, so a missing back-tick line reads as a formatting slip and
  // not as "you pasted no output".
  if (open !== null && open.length) blocks.push(open);
  return { prose: prose.join('\n'), fenced: blocks.map((lines) => lines.join('\n')).join('\n'), blocks };
}

/**
 * The non-empty lines of a fenced block, with shell line-continuations folded
 * into the single line they actually are.
 *
 * WHY (review round 3, 2026-08-26). The output rule counts pasted lines and
 * wants at least two — a command plus something it printed. A backslash-
 * continued command is two lines on its own, so
 *
 *   curl -s https://api.clickup.com/api/v2/team \\
 *     -H "Authorization: $TOKEN"
 *
 * satisfied the count with NO output under it at all — which is precisely "a
 * claim about what would happen", the thing the refusal message says it
 * rejects. Folding the continuation makes the count mean what it says.
 *
 * ONLY the backslash is folded. A trailing pipe looks like a continuation too,
 * but it is also how a markdown table row ends, and real pasted output is full
 * of those — folding them would undercount genuine output and refuse a good
 * card, which is the failure mode that gets a gate routed around.
 */
function contentLines(lines) {
  const out = [];
  let carry = '';
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    carry = carry ? `${carry} ${line}` : line;
    if (/\\$/.test(carry)) {
      carry = carry.replace(/\\+$/, '').trim();
      continue;
    }
    out.push(carry);
    carry = '';
  }
  if (carry) out.push(carry);
  return out;
}

/** The fenced blocks inside a section, as arrays of their content lines. */
function fencedBlocks(text) {
  return splitFences(text).blocks;
}

/**
 * The line that says when the check was run: `@@MEASURED 8:04pm`, alone on its
 * own line in the prose of @@EVIDENCE. Every other clock in the section — in
 * the prose and in the pasted output alike — is IGNORED.
 *
 * WHY IT IS DECLARED AND NOT INFERRED (Dane's decision, 2026-08-29, option A
 * on task 86bbk34ym). Four rounds of this gate each read the run time out of
 * the author's sentences, and each picked it by a different positional rule:
 * the first clock (round 1), the first clock in the prose (round 2), the last
 * cue-governed clock (round 3), the clock a cue introduces (round 4). Every
 * one of them was right on the sentences it was tested against and wrong on
 * the next one somebody wrote. The last version dated a card
 *
 *   **THE CHECK BEHIND THIS ASK — measured at 3:12pm**
 *
 * from the sentence "At 8:04pm I re-ran the failing call, well after the
 * outage began at 3:12pm" — the moment the outage STARTED, asserted to the
 * operator as the moment it was checked. That is the exact half of the
 * 2026-08-23 incident this timestamp exists to close, arriving through the
 * machinery meant to close it, and it did not refuse: it stated it plainly.
 *
 * The ticket's own Non-goals say this gate stays "cheap, narrow, and
 * mechanical" and does not take on reasoning tasks. Reading which clock in an
 * English sentence is the measurement is a reasoning task, and an open-ended
 * one — a fifth positional rule would have closed that shape and left the next
 * one open, which is what the four before it each did.
 *
 * So the writer says it, on one line, and nothing is guessed. The cost is one
 * line per costly ask. What it buys is that this class of bug cannot recur:
 * there is no sentence shape left to get wrong.
 *
 * It is a line rather than a `@@MEASURED` section because the section markers
 * (`MARKERS`) must sit alone on their line, and this one carries its value on
 * the same line — see parseCard, which says so when somebody writes it bare.
 */
const MEASURED_LINE = /^[ \t]*@@MEASURED\b[ \t]*(.*?)[ \t]*$/i;

/**
 * The whole line has to be the clock and NOTHING else.
 *
 * Anchored on purpose. Allowing trailing words puts them in the card's
 * heading, and "measured at 8:04pm I think, before the restart" is the same
 * hedged assertion the declared line exists to replace. A refusal here costs
 * one reword and says exactly what to write.
 */
const MEASURED_VALUE = new RegExp(`^${CLOCK.source}$`, 'i');

/** Does this text carry a `@@MEASURED` line anywhere in it? */
function hasMeasuredLine(text) {
  return String(text || '').split('\n').some((line) => MEASURED_LINE.test(line));
}

/**
 * Read the declared run time out of a section.
 *
 * Returns `{ time, ambiguous, reason, declared }`. A null `time` always carries
 * a `reason`, because the caller has a different sentence to say for each one
 * and "add a time" is unhelpful to an author who wrote one in the wrong place.
 *
 * Only the PROSE is read. A `@@MEASURED` line inside a fence is part of the
 * pasted output — something the machine printed, not something the author is
 * saying — and taking it at its word is how round 1 dated a card six days
 * stale off a log line. It is reported as its own problem rather than as
 * "missing", because the author plainly did write one.
 */
function readEvidenceTime(text) {
  const { prose, fenced } = splitFences(text);
  const declared = [];
  for (const line of prose.split('\n')) {
    const match = MEASURED_LINE.exec(line);
    if (match) declared.push(match[1].trim());
  }

  if (declared.length > 1) {
    return { time: null, ambiguous: true, reason: 'repeated-measured-line', declared };
  }
  if (!declared.length) {
    return {
      time: null,
      ambiguous: false,
      reason: hasMeasuredLine(fenced) ? 'measured-line-fenced' : 'no-measured-line',
      declared,
    };
  }
  if (!declared[0]) {
    return { time: null, ambiguous: false, reason: 'measured-line-empty', declared };
  }
  const match = MEASURED_VALUE.exec(declared[0]);
  if (!match) {
    return { time: null, ambiguous: false, reason: 'measured-line-unreadable', declared };
  }
  return { time: match[1].trim(), ambiguous: false, reason: null, declared };
}

/**
 * The evidence as the operator should see it — the declared line removed,
 * because its whole content is already the card's heading. Leaving it in
 * prints the time twice, once in a spelling that is machine syntax.
 */
function evidenceBody(text) {
  // Fence-aware: a `@@MEASURED` line inside a fence is something the machine
  // printed, and the paste is verbatim or it is worthless.
  return fenceLines(text)
    .filter(({ line, role }) => role !== 'prose' || !MEASURED_LINE.test(line))
    .map(({ line }) => line)
    .join('\n')
    .trim();
}

function evidenceTimestamp(text) {
  return readEvidenceTime(text).time;
}

/**
 * The evidence rule. An ask that costs money or cannot be undone must arrive
 * with the check that establishes it — see costlyAsk.js for the incident.
 *
 * Three things are demanded, and all three are mechanical:
 *
 *   1. the COMMAND or request, in runnable form — a fenced block, which is
 *      also the only verbatim form ClickUp is known to keep intact;
 *   2. its ACTUAL OUTPUT, pasted rather than summarised — so the fence has to
 *      hold more than the one command line. A command with nothing underneath
 *      it is a claim about what would happen, which is what went wrong;
 *   3. WHEN it was run, DECLARED on a `@@MEASURED 8:04pm` line in the
 *      operator's clock. Evidence gathered before a sixteen-hour outage is not
 *      evidence about now. It is declared rather than read out of the prose
 *      because four versions that read it were each wrong on the next sentence
 *      somebody wrote — see MEASURED_LINE.
 *
 * What is deliberately NOT checked: whether the evidence is CORRECT. That is
 * a reasoning task and it belongs to the reader. This gate only enforces that
 * a costly ask arrives with a reproducible check and the time it was run.
 */
function evidenceProblems(card) {
  const problems = [];
  const triggers = costlyTriggers(card.needed);
  const evidence = String(card.evidence || '').trim();

  if (!triggers.length) {
    // An ordinary ask is untouched — including one that volunteered evidence.
    // Narrowness is the value: a gate that fires on everything gets routed
    // around, and then it protects nothing.
    if (!evidence) return problems;
  } else if (!evidence) {
    problems.push(
      `@@EVIDENCE is missing, and this ask is a costly one: ${describeTriggers(triggers)}.\n` +
      '  An ask that spends money or cannot be undone has to carry the check that proves it —\n' +
      '  the command or request in runnable form, its ACTUAL output pasted in a fenced block,\n' +
      '  and when you ran it on a line of its own ("@@MEASURED 8:04pm").\n' +
      `  On 2026-08-23 an agent asked ${operatorName()} to pay for a plan upgrade on a diagnosis that was\n` +
      '  wrong; re-running the one failing call would have settled it in seconds.\n' +
      '  Re-run it now and paste what it says.',
    );
    return problems;
  }

  // From here the section exists, so its SHAPE is checked — for a costly ask
  // because it is owed, and for a volunteered one because half-evidence is
  // more misleading than none.
  const { blocks } = splitFences(evidence);
  const filled = blocks.filter((lines) => lines.some((line) => line.trim()));
  // Counted ACROSS the fences, not within one. The clearer layout puts the
  // command in its own fence and the output in a second, and the first version
  // of this rule told that author "you showed a command with no output" — which
  // was false. A gate that misdiagnoses good input is one people route around,
  // and then it protects nothing.
  const pastedLines = filled.reduce((total, lines) => total + contentLines(lines).length, 0);
  if (!filled.length) {
    problems.push(
      '@@EVIDENCE has no fenced block. Put the command and its output inside ``` fences:\n' +
      '  a fence is the only form ClickUp is known to keep verbatim, and verbatim is the\n' +
      '  whole point — a summary of the output is the judgment this gate exists to skip.',
    );
  } else if (pastedLines < 2) {
    problems.push(
      '@@EVIDENCE shows a command with no output under it. Paste what it actually printed,\n' +
      '  not what it should print — the 2026-08-23 escalation was wrong precisely because\n' +
      '  nobody re-ran the failing call before asking him to pay for the diagnosis.\n' +
      '  One fence holding both, or one for the command and one for its output, both count.',
    );
  }

  const timing = readEvidenceTime(evidence);
  if (!timing.time) {
    if (timing.reason === 'repeated-measured-line') {
      problems.push(
        '@@EVIDENCE has more than one @@MEASURED line, and the card shows one time. Picking\n' +
        '  between them is exactly what the four earlier versions of this rule did — each by a\n' +
        '  different rule, each wrong on the next card somebody wrote. Keep the one line that\n' +
        '  says when you ran the check; say everything else in ordinary prose, where it is\n' +
        '  read by nobody but him.',
      );
    } else if (timing.reason === 'measured-line-fenced') {
      problems.push(
        '@@EVIDENCE has its @@MEASURED line INSIDE the fenced block, where it reads as part of\n' +
        '  what the command printed rather than as something you are saying. The paste is the\n' +
        '  machine\'s word and the line is yours, and the card must not confuse them. Move it\n' +
        '  out to its own line in the prose: "@@MEASURED 8:04pm".',
      );
    } else if (timing.reason === 'measured-line-empty') {
      problems.push(
        '@@MEASURED has no time after it. The time goes on the SAME line, in his clock —\n' +
        '  "@@MEASURED 8:04pm", or "@@MEASURED 2026-08-23 8:04pm" if you did not run it today.',
      );
    } else if (timing.reason === 'measured-line-unreadable') {
      problems.push(
        `@@MEASURED says "${timing.declared[0]}", which is not a time in the register he reads.\n` +
        '  The line has to be the clock and nothing else — "@@MEASURED 8:04pm", or\n' +
        '  "@@MEASURED 2026-08-23 8:04pm" if it was not today. "Just now" is not a time by the\n' +
        '  hour he opens the card, and an ISO instant is a number he has to convert before he\n' +
        '  can tell whether your reading predates the outage you are reporting.',
      );
    } else {
      const stray = ['asked', 'when', 'context', 'needed']
        .filter((name) => hasMeasuredLine(card[name]));
      problems.push(
        '@@EVIDENCE does not say when you ran it. Add one line — "@@MEASURED 8:04pm" — in his\n' +
        '  clock, dated if it was not today. The card prints that time in its heading, so a\n' +
        '  stale proof is visible rather than implied: evidence gathered before a sixteen-hour\n' +
        '  outage is not evidence about now.\n' +
        '  It is a line you write rather than something read out of your sentences because\n' +
        '  four earlier versions of this gate guessed which clock you meant, and the last one\n' +
        '  dated a card by the outage it was reporting (task 86bbk34ym).' +
        (stray.length
          ? `\n  You DID write a @@MEASURED line, but in @@${stray[0].toUpperCase()}. It only counts inside\n  @@EVIDENCE, which is the section the card dates.`
          : ''),
      );
    }
  }
  return problems;
}

/**
 * The 1-based line numbers that start a markdown blockquote. Lines inside a
 * fenced block are exempt — a fence is literal, so a `>` in there is safe and
 * is often exactly what someone means to show.
 */
function findBlockquoteLines(text) {
  const found = [];
  fenceLines(text).forEach(({ line, role }, i) => {
    if (role === 'prose' && /^\s*>/.test(line)) found.push(i + 1);
  });
  return found;
}

/**
 * Did the card actually survive the trip? Compares the operator's words, as
 * ClickUp read them back, against what was sent. Returns a problem sentence,
 * or null when the words are intact.
 *
 * This is the check that caught the blockquote bug. It stays because the next
 * thing ClickUp silently swallows will not announce itself either.
 */
function cardSurvived(card, savedText) {
  const flatten = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const asked = flatten(card.asked);
  if (!asked) return null;
  if (flatten(savedText).includes(asked)) return null;
  return (
    "The card posted, but the operator's own words did NOT survive it. ClickUp read back a\n" +
    'comment that does not contain @@ASKED. That is the one part of a card nobody can\n' +
    'reconstruct later — fix the formatting and post it again before relying on this ticket.'
  );
}

/**
 * The colour of the banner. Dane's choice (2026-08-30, task 86bbq5ruz): the
 * muted red he used to see (#d16464) was ClickUp's default code-block colour,
 * not something anybody chose. Bold and #CC0000 are chosen.
 */
const BANNER_COLOR = '#CC0000';
const BANNER_ATTRS = Object.freeze({ bold: true, color: BANNER_COLOR });

/**
 * The card as a list of blocks — the ONE description both renderers read.
 *
 *   { kind: 'heading', text }   a bold line
 *   { kind: 'note', text }      an italic line (the @@WHEN stamp)
 *   { kind: 'fence', text }     verbatim, in a code block
 *   { kind: 'prose', text }     authored markdown (a small subset, see runs())
 *   { kind: 'banner', lines }   the NEEDED FROM DANE banner
 *
 * ORDER (Dane, 2026-08-30, task 86bbq5ruz): his words, what is going on, the
 * evidence if there is any, and the banner LAST. Nothing renders after the
 * banner. Anything added to a card later that needs a new action from him
 * goes at the bottom, which is where he has learned to look.
 */
function cardBlocks(card) {
  const blocks = [
    { kind: 'heading', text: `${operatorName().toUpperCase()}'S WORDS — the instruction behind this ticket` },
    // Fenced, not blockquoted: see the note at the top of this file. A fence
    // is the only form ClickUp keeps that also leaves the contents
    // uninterpreted, and "verbatim" is the whole promise of this section.
    { kind: 'fence', text: card.asked },
  ];
  if (card.when) blocks.push({ kind: 'note', text: `(${card.when})` });
  blocks.push(
    { kind: 'heading', text: "WHAT'S GOING ON" },
    { kind: 'prose', text: card.context },
  );
  if (card.evidence) {
    // The measurement time goes in the HEADING rather than being left inside
    // the paste, so a stale proof is visible at a glance instead of implied —
    // that is the half of the 2026-08-23 failure that survives even when
    // evidence is attached.
    const when = evidenceTimestamp(card.evidence);
    blocks.push(
      { kind: 'heading', text: `THE CHECK BEHIND THIS ASK${when ? ` — measured at ${when}` : ''}` },
      // The @@MEASURED line itself is lifted out: its whole content is the
      // heading above, and leaving it in prints the time twice, the second
      // time in a spelling that is machine syntax and means nothing to him.
      { kind: 'prose', text: evidenceBody(card.evidence) },
    );
  }
  blocks.push({ kind: 'banner', lines: bannerLines(card.needed) });
  return blocks;
}

/**
 * The banner, three lines when the ask is one line: rule, label + ask, rule.
 * The ask sits BETWEEN the label and the closing rule, on the label's own
 * line, so the thing he has to do is the thing his eye lands on. A multi-line
 * ask keeps its extra lines inside the rules.
 */
function bannerLines(needed) {
  const askLines = String(needed || '').trim().split('\n');
  return [BANNER_RULE, `${bannerLabel()}${askLines[0]}`, ...askLines.slice(1), BANNER_RULE];
}

/**
 * Authored markdown → ClickUp runs. ClickUp's structured comment body
 * (`comment: [{ text, attributes }]`) does NOT parse markdown — probed live
 * on 2026-08-30 (task 86bbgm68r, comment 90140249373780): `**bold**` came
 * back as literal asterisks. Colour is only available in that structured
 * form, so the whole card has to be posted that way, and the small subset
 * agents actually write into a card is converted here:
 *
 *   ``` fenced block ```   → a code-block run
 *   **bold**               → bold
 *   `inline code`          → code
 *
 * Anything else is carried as plain text, which is exactly what it would have
 * been before: ClickUp shows unsupported markdown literally either way.
 */
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
    if (role === 'open') {
      flush();
      open = true;
    } else if (role === 'close') {
      open = false;
      const body = (fences[fenceIndex++] || []).join('\n');
      runs.push({ text: `${body}\n`, attributes: { 'code-block': 'plain' } });
    } else if (role === 'prose') {
      paragraph.push(line);
    } // a body line is emitted whole when its fence closes
  }
  if (open) {
    // An unclosed fence still carried content; splitFences kept it.
    const body = (fences[fenceIndex] || []).join('\n');
    runs.push({ text: `${body}\n`, attributes: { 'code-block': 'plain' } });
  }
  flush();
  return runs;
}

/** `**bold**` and `` `code` `` inside one paragraph; everything else plain. */
function inlineRuns(text) {
  const runs = [];
  const pattern = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index) });
    if (match[1] !== undefined) runs.push({ text: match[1], attributes: { bold: true } });
    else runs.push({ text: match[2], attributes: { code: true } });
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}

/**
 * The card as ClickUp's structured comment body — what `ask` actually posts.
 * Every banner line is bold and red; nothing follows it.
 */
function renderCardComment(card) {
  const runs = [];
  for (const block of cardBlocks(card)) {
    switch (block.kind) {
      case 'heading':
        runs.push({ text: block.text, attributes: { bold: true } }, { text: '\n\n' });
        break;
      case 'note':
        runs.push({ text: block.text, attributes: { italic: true } }, { text: '\n\n' });
        break;
      case 'fence':
        runs.push({ text: `${block.text}\n`, attributes: { 'code-block': 'plain' } }, { text: '\n' });
        break;
      case 'prose':
        runs.push(...proseRuns(block.text), { text: '\n' });
        break;
      case 'banner':
        for (const line of block.lines) {
          runs.push({ text: line, attributes: { ...BANNER_ATTRS } }, { text: '\n' });
        }
        break;
      default:
        throw new Error(`unknown card block "${block.kind}"`);
    }
  }
  return runs;
}

/**
 * A backtick fence that `text` cannot close: one longer than its longest
 * backtick run, and never shorter than three. The operator's words may carry
 * their own ``` lines; a plain ``` round them would end at the first one.
 */
function fenceFor(text) {
  const longest = Math.max(0, ...(String(text || '').match(/`+/g) || []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The card as plain text — the same blocks, in markdown. This is what the
 * transcript and the tests read, and what `comment_text` on the posted
 * comment comes back as (minus the formatting), so `cardSurvived` and
 * `waitingOnOperator` can keep reading the text form.
 */
function renderCard(card) {
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

/**
 * Parse + validate + render in one call. Throws with every problem listed.
 * Returns the parsed card, the text rendering (for the transcript and the
 * read-back check) and the structured `comment` body (what is posted).
 * The caller needs the parsed `asked` again after posting, to run
 * `cardSurvived` against what ClickUp actually stored.
 */
function buildCard(text) {
  const card = parseCard(text);
  const problems = validateCard(card);
  if (problems.length) {
    throw new Error(
      `The card is not in the required shape:\n\n- ${problems.join('\n- ')}\n\n` +
      'Nothing was posted and no status was moved.',
    );
  }
  return { card, rendered: renderCard(card), comment: renderCardComment(card) };
}

module.exports = {
  fenceFor,
  fenceLines,
  MARKERS,
  CLOCK,
  evidenceTimestamp,
  readEvidenceTime,
  evidenceBody,
  MEASURED_LINE,
  MEASURED_VALUE,
  splitFences,
  fencedBlocks,
  contentLines,
  evidenceProblems,
  CONTEXT_MIN_WORDS,
  CONTEXT_MAX_WORDS,
  BANNER_RULE,
  bannerLabel,
  countWords,
  findBlockquoteLines,
  parseCard,
  YOUR_MOVES,
  readYourMove,
  yourMoveProblems,
  validateCard,
  cardSurvived,
  BANNER_COLOR,
  BANNER_ATTRS,
  cardBlocks,
  bannerLines,
  proseRuns,
  inlineRuns,
  renderCardComment,
  renderCard,
  buildCard,
  // Getters LAST. Node's ESM named-import detection reads this list top to
  // bottom and stops at the first entry that is not a plain name, so a
  // getter anywhere earlier hides every name after it from `import { … }`.
  // The getters themselves stay out of named imports on purpose: a named
  // import is copied once at load time, which would freeze the config read
  // they exist to defer. Read them through the module object instead.
  get BANNER_LABEL() { return bannerLabel(); },
};
