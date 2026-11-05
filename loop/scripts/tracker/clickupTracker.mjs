/**
 * clickupTracker.mjs — the ClickUp tracker: every ClickUp web address the
 * door uses, behind named methods (task 86bcrvz14). The door
 * (scripts/clickup.mjs) talks to a "tracker" object and never to ClickUp
 * directly, so a second tracker can stand behind the same commands later
 * (docs/TRACKER_MVP.md, "How the loops switch over without a rewrite").
 *
 * Moved out of the door unchanged: the request function, its timeout, the
 * 429 retry, the rate-limit bookkeeping and the machine stamp. Every method
 * answers the raw `{ res, json, text }` the door has always read, so its
 * guards, messages and exit codes stay exactly as they were, and the objects
 * in `json` are ClickUp-shaped, so `lib/` and `scripts/lib/` read them as
 * before. Nothing here decides what a failure means; that is the caller's.
 *
 * The token is handed in, never printed and never logged.
 */

import { stampCommentBody, isCommentPostPath } from '../lib/machineComment.mjs';
import { commentsReadable } from '../lib/loopTrail.mjs';
import { pageComments } from '../../lib/commentPages.js';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function unreachable(err) {
  return { res: { ok: false, status: 0, headers: { get: () => null } }, json: null, text: `the request never reached ClickUp (${err?.message || err})` };
}

/**
 * `token` is the ClickUp API token. `apiBase` and `timeoutMs` default to
 * ClickUp itself and one minute (CLICKUP_API_BASE / CLICKUP_HTTP_TIMEOUT_MS
 * in the door's environment). `log` takes the retry notices and the limit
 * line; it is stderr in the door.
 */
export function createClickupTracker({ token, apiBase, timeoutMs, log = console.error } = {}) {
  const API = apiBase || 'https://api.clickup.com';
  const HTTP_TIMEOUT_MS = Number(timeoutMs) || 60 * 1000;
  let requests = 0;
  const limits = { limit: null, remaining: null, reset: null };

  async function callOnce(method, path, body) {
    requests += 1;
    // THE ONE PLACE A MACHINE COMMENT IS MARKED. The loops post under Dane's own
    // seat, so a reader cannot tell their writing from his by author alone.
    const sendBody = (method === 'POST' && isCommentPostPath(path)) ? stampCommentBody(body) : body;
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: sendBody ? JSON.stringify(sendBody) : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      return unreachable(err);
    }
    limits.limit = res.headers.get('x-ratelimit-limit') ?? limits.limit;
    limits.remaining = res.headers.get('x-ratelimit-remaining') ?? limits.remaining;
    limits.reset = res.headers.get('x-ratelimit-reset') ?? limits.reset;
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { res, json, text };
  }

  /** A 429 is ClickUp itself throttling; it clears within a minute and is safe to repeat. */
  async function call(method, path, body) {
    for (let attempt = 1; ; attempt += 1) {
      const out = await callOnce(method, path, body);
      if (out.res.status !== 429 || attempt >= 3) return out;
      const reset = Number(out.res.headers.get('x-ratelimit-reset'));
      const waitMs = Number.isFinite(reset) && reset > 0 ? Math.max(1000, reset * 1000 - Date.now()) : 15000;
      log(`  ClickUp rate limit (attempt ${attempt}) — waiting ${Math.round(waitMs / 1000)}s and trying again`);
      await sleep(Math.min(waitMs, 65000));
    }
  }

  return {
    name: 'clickup',

    /** The one line saying how much of ClickUp's per-minute budget is left. */
    reportLimits() {
      if (limits.limit == null && limits.remaining == null) return;
      log(`  ClickUp's own limit: ${limits.remaining ?? '?'} of ${limits.limit ?? '?'} left this minute (${requests} request(s) this run)`);
    },

    whoAmI: () => call('GET', '/api/v2/user'),
    listsInSpace: (space) => call('GET', `/api/v2/space/${space}/list?archived=false`),
    foldersInSpace: (space) => call('GET', `/api/v2/space/${space}/folder?archived=false`),

    /** One page of a list's tasks; `json.last_page` says whether more follow.
     *  `markdown: true` adds `markdown_description` to each ticket. */
    listTasksPage: (list, page, { includeClosed = false, markdown = false } = {}) =>
      call('GET', `/api/v2/list/${list}/task?archived=false${includeClosed ? '&include_closed=true' : ''}${markdown ? '&include_markdown_description=true' : ''}&page=${page}`),

    /** `markdown: true` adds `markdown_description` to the ticket. */
    getTask: (task, { markdown = false } = {}) =>
      call('GET', `/api/v2/task/${task}${markdown ? '?include_markdown_description=true' : ''}`),
    createTask: (list, fields) => call('POST', `/api/v2/list/${list}/task`, fields),
    updateTask: (task, fields) => call('PUT', `/api/v2/task/${task}`, fields),
    setTag: (task, name, on) => call(on ? 'POST' : 'DELETE', `/api/v2/task/${task}/tag/${encodeURIComponent(name)}`),

    /**
     * Every comment on the ticket, newest first, across all pages
     * (lib/commentPages.js). Answers `{ paged, bad }`: `bad` is the first
     * response that was not a readable comment list, or null.
     */
    async listComments(task) {
      let bad = null;
      const get = async (path) => {
        const out = await call('GET', path);
        const ok = out.res.ok && commentsReadable(out.json);
        if (!ok) bad = out;
        return { ok, json: out.json };
      };
      const paged = await pageComments({ get, taskId: task });
      return { paged, bad };
    },
    postComment: (task, body) => call('POST', `/api/v2/task/${task}/comment`, body),
    replyToComment: (commentId, body) => call('POST', `/api/v2/comment/${commentId}/reply`, body),
    listReplies: (commentId) => call('GET', `/api/v2/comment/${commentId}/reply`),
  };
}
