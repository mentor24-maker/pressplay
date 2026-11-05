/**
 * The loops post under Dane's own ClickUp seat — `whoami` says "Acting as:
 * Dane" — so nothing downstream can tell a machine's comment from his by the
 * author alone. Every comment a script posts therefore ends with a marker
 * line, stamped at the door (the one place comments are posted), and the
 * readers that ask "did Dane speak last?" skip stamped comments.
 *
 * Same marker string as StarCaster's scripts/builder/machineComment.js, so a
 * reader from either repo recognises the other's comments.
 */

export const MACHINE_MARKER = '[machine]';
export const MACHINE_MARKER_LINE = `${MACHINE_MARKER} posted by a loop under Dane's token — not his word`;

function unescapeMarkdown(text) {
  return String(text == null ? '' : text).replace(/\\([[\]()*_`~#!>+\-.])/g, '$1');
}

export function lastNonEmptyLine(text) {
  const lines = String(text == null ? '' : text).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return '';
}

export function isMachineComment(text) {
  const s = unescapeMarkdown(text);
  if (!s.trim()) return false;
  return lastNonEmptyLine(s).startsWith(MACHINE_MARKER);
}

export function stampMachineComment(text) {
  const s = String(text == null ? '' : text);
  if (isMachineComment(s)) return s;
  const trimmed = s.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n\n${MACHINE_MARKER_LINE}` : MACHINE_MARKER_LINE;
}

function blocksToText(blocks) {
  return Array.isArray(blocks) ? blocks.map((b) => String(b && b.text != null ? b.text : '')).join('') : '';
}

export function stampMachineCommentBlocks(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  if (isMachineComment(blocksToText(blocks))) return blocks;
  return blocks.concat([{ text: `\n${MACHINE_MARKER_LINE}` }]);
}

/** Stamp whichever comment body shape ClickUp is being sent. */
export function stampCommentBody(body) {
  if (!body || typeof body !== 'object') return body;
  if (typeof body.comment_text === 'string') return { ...body, comment_text: stampMachineComment(body.comment_text) };
  if (Array.isArray(body.comment)) return { ...body, comment: stampMachineCommentBlocks(body.comment) };
  return body;
}

/** A top-level comment on a task, or a threaded reply on a comment: the relay
 *  writes its markers as replies, and a machine's reply is still a machine's.
 *  Same two shapes as StarCaster's scripts/builder/machineComment.js. */
export function isCommentPostPath(path) {
  const p = String(path || '');
  return /^\/api\/v2\/task\/[^/]+\/comment(\?|$)/.test(p)
    || /^\/api\/v2\/comment\/[^/]+\/reply(\?|$)/.test(p);
}

/** The comment without its marker line, for display. */
export function stripMachineMarker(text) {
  const lines = String(text == null ? '' : text).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.startsWith(MACHINE_MARKER)) break;
    return lines.slice(0, i).join('\n').trim();
  }
  return String(text == null ? '' : text).trim();
}
