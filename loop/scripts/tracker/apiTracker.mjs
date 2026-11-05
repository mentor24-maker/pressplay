/**
 * apiTracker.mjs — the tracker's own API behind the door's tracker methods
 * (task 86bctjb8j, Phase 2 of docs/TRACKER_MVP.md). The same methods as
 * clickupTracker.mjs, calling tracker/server.mjs over HTTP with the loop's
 * own token, so `npm run clickup -- <command>` can work a queue in the
 * tracker with every command, guard and output unchanged.
 *
 * Every method answers the raw `{ res, json, text }` the door reads, and the
 * objects in `json` are ClickUp-shaped (`comment_text`, `user.id`, `date`,
 * `status.status`, `status.type`, `assignees`, `priority.priority`), so
 * neither the door nor `lib/` reads anything new. The translation lives here
 * and only here:
 *
 *   ClickUp                         the tracker
 *   a list id                       a project slug: the configured Loop Queue
 *                                   list means `project`; any other value is
 *                                   taken as a slug itself
 *   assignees { add, rem }          the one `assignee` (actor id) a ticket has
 *   priority 1..4                   "urgent" .. "low"
 *   markdown_description            description
 *   a rich-text comment (blocks)    its markdown: bold, italic, code and
 *                                   code-block runs keep their marks
 *   a ticket id, any case           the store's id, upper case (`AL-1`):
 *                                   ClickUp ids are lower case and lib/
 *                                   lowercases what it reads (waitsOn)
 *   a ticket's web page             the API's own `<trackerApiUrl>/tickets/<id>`
 *                                   (JSON, signed in; no web page until
 *                                   Phase 3): one word ending in the id, as
 *                                   lib/conflictWork reads a filed ticket back
 *   a reply on comment C            a comment on C's ticket with parent C
 *
 * A guarded write (`updateTask(..., { ifStatus })`) is the store's atomic
 * guard: a raced claim is refused by the store and answers HTTP 409 with
 * `moved: true`, writing nothing. ClickUp has no such guard; the door's own
 * read-then-compare still runs before it on either tracker.
 *
 * With this tracker the project config's operator and machine ids are the
 * tracker's actor ids, so `user.id` compares as it does on ClickUp.
 *
 * The machine stamp keeps being written (the non-goal of this phase): a
 * comment or reply this tracker posts ends with the [machine] line, exactly
 * as on ClickUp, so the readers stay correct on either tracker.
 *
 * The token is handed in, never printed and never logged.
 */

import { stampCommentBody } from '../lib/machineComment.mjs';
import { PRIORITY_VALUE, QUEUED, TERMINAL_STATUSES } from '../lib/loopStatuses.mjs';
import { TRACKER_SEATS } from '../lib/expectedSecrets.mjs';
import { fenceFor } from '../lib/operatorCard.mjs';

/** ClickUp's priority number -> the tracker's name. */
const PRIORITY_NAME = Object.freeze(Object.fromEntries(Object.entries(PRIORITY_VALUE).map(([k, v]) => [v, k])));

/** fetch says only "fetch failed"; the reason (ECONNRESET, ECONNREFUSED, ...) is on its cause. */
function unreachable(err) {
  const cause = err?.cause ? [err.cause.code, err.cause.message].filter(Boolean).join(': ') : '';
  const why = [err?.message || String(err), cause].filter(Boolean).join(' — ');
  return { res: { ok: false, status: 0, headers: { get: () => null } }, json: null, text: `the request never reached the tracker (${why})` };
}

/** An answer made here, not by the server: a refusal the door reports like any failed write. */
function refused(status, message, extra = {}) {
  const json = { err: message, ...extra };
  return { res: { ok: false, status, headers: { get: () => null } }, json, text: JSON.stringify(json) };
}

/** Swap an answer's body for the ClickUp-shaped one, keeping its HTTP status. */
function withJson(out, json) {
  return { ...out, json, text: JSON.stringify(json) };
}

/** One ClickUp rich-text run as markdown, keeping the marks the operator card uses. */
function runMarkdown(run) {
  const text = String(run?.text ?? '');
  const a = run?.attributes || {};
  // The fence is longer than any backtick run inside, so a ``` of Dane's
  // own cannot close the block early.
  if (a['code-block']) { const fence = fenceFor(text); return `${fence}\n${text.endsWith('\n') ? text : `${text}\n`}${fence}`; }
  if (!text.trim()) return text;
  // Marks go round the words, never round the spaces either side of them.
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (a.code) return `${lead}\`${core}\`${trail}`;
  if (a.bold && a.italic) return `${lead}***${core}***${trail}`;
  if (a.bold) return `${lead}**${core}**${trail}`;
  if (a.italic) return `${lead}*${core}*${trail}`;
  return text;
}

/** A ClickUp comment body as the markdown text the tracker stores. */
function commentText(body) {
  if (typeof body?.comment_text === 'string') return body.comment_text;
  if (Array.isArray(body?.comment)) return body.comment.map(runMarkdown).join('');
  return '';
}

const ms = (iso) => String(Date.parse(iso));

/**
 * Which environment variable holds this caller's tracker token. Each loop
 * has its own sign-in, kept in Doppler under its own name
 * (`TRACKER_TOKEN_LOOP_BUILD`, ...). Its runner sets `TRACKER_TOKEN_NAME` to
 * that NAME, never the value, so the token reaches only the door's own
 * process (through `doppler run`) and never the loop session's environment.
 * Without it (a session started by hand), the hand-run seat's
 * (`TRACKER_TOKEN_HAND_RUN`). Only a machine seat's secret is accepted
 * (TRACKER_SEATS): any other name is refused, above all the operator's own,
 * so a loop can never sign in as him or be pointed at another key.
 */
export function trackerTokenEnv(env = process.env, seats = TRACKER_SEATS) {
  const name = env.TRACKER_TOKEN_NAME;
  if (name == null || name === '') {
    const handRun = seats.find((s) => s.handRun && s.kind === 'machine');
    if (!handRun) throw new Error('no TRACKER_TOKEN_NAME is set and no hand-run seat is listed in TRACKER_SEATS.');
    return handRun.secret;
  }
  const machine = seats.filter((s) => s.kind === 'machine').map((s) => s.secret);
  if (!machine.includes(name)) {
    throw new Error(`TRACKER_TOKEN_NAME must name a loop's own tracker secret (${machine.join(', ')}), not "${name}".`);
  }
  return name;
}

/**
 * `token` is the loop's tracker token (see trackerTokenEnv). `baseUrl` is the
 * project config's `trackerApiUrl` (the address the loops call). `project` is the tracker's project slug and
 * `listId` the configured Loop Queue list it stands for. `timeoutMs`
 * defaults to one minute. `log` takes the one request-count line (stderr in
 * the door).
 */
export function createApiTracker({ token, baseUrl, project, listId, timeoutMs, log = console.error } = {}) {
  if (!baseUrl) throw new Error('the api tracker needs a trackerApiUrl (or a trackerUrl).');
  if (!project) throw new Error('the api tracker needs a project slug.');
  const BASE = String(baseUrl).replace(/\/+$/, '');
  const HTTP_TIMEOUT_MS = Number(timeoutMs) || 60 * 1000;
  let requests = 0;
  /** Actor names, read once per run: the API's answers carry ids only. */
  const names = new Map();
  /** Comment id -> its ticket, from every comment this run has read or written.
   *  A reply is posted on the ticket, so the ticket must be known. */
  const commentTicket = new Map();

  async function call(method, path, body) {
    requests += 1;
    let res;
    try {
      // One connection per request, never a kept-alive one (SP-102). The door
      // runs `gh` and `git` synchronously, which freezes this process; after
      // `gh pr merge` (six seconds) the server had already closed the idle
      // connection (its keep-alive is five), the next POST went out on it and
      // was reset, and fetch retries only a GET. On the relay that POST was
      // the merge marker, after every merge. A fresh connection to the Mini
      // costs a millisecond; retrying a write instead could post it twice.
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Connection: 'close' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      return unreachable(err);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    // The door prints `json.err`; the server says `message`.
    if (!res.ok && json && json.message && !json.err) json = { ...json, err: json.message };
    return { res, json, text };
  }

  // Tracker ids are a capital prefix and a number (tracker/store.mjs refuses
  // any other prefix), and the store looks them up exactly; lib/waitsOn.js
  // lowercases the ids it reads, as ClickUp's are. So any case is the same id.
  const ticketPath = (id) => `/tickets/${encodeURIComponent(String(id).toUpperCase())}`;
  const projectFor = (list) => (list == null || String(list) === String(listId) ? project : String(list));

  /** An actor's name, or `actor <id>` when it cannot be read. Never fails the caller. */
  async function nameOf(id) {
    if (id == null) return null;
    if (!names.has(id)) {
      const out = await call('GET', `/actors/${encodeURIComponent(id)}`);
      names.set(id, out.res.ok && out.json?.name ? out.json.name : `actor ${id}`);
    }
    return names.get(id);
  }

  async function taskFromTicket(t) {
    const assignees = t.assignee == null ? [] : [{ id: t.assignee, username: await nameOf(t.assignee) }];
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      markdown_description: t.description,
      text_content: t.description,
      status: { status: t.status, type: TERMINAL_STATUSES.includes(t.status) ? 'closed' : 'custom' },
      priority: t.priority ? { priority: t.priority, id: String(PRIORITY_VALUE[t.priority] ?? '') } : null,
      assignees,
      tags: (t.tags || []).map((name) => ({ name })),
      list: { id: t.project, name: t.project },
      // The API route tracker/server.mjs serves for this ticket (a web page
      // comes in Phase 3). It must stay one word whose last path part is the
      // id: the relay's conflict trail reads the filed ticket's id back from
      // it (lib/conflictWork.js findConflictTicket).
      url: `${BASE}/tickets/${t.id}`,
      date_created: ms(t.createdAt),
      date_updated: ms(t.updatedAt),
      version: t.version,
    };
  }

  async function commentFromRow(c) {
    commentTicket.set(String(c.id), c.ticket);
    return {
      id: String(c.id),
      comment_text: c.body,
      comment: [{ text: c.body }],
      user: { id: c.author, username: await nameOf(c.author) },
      date: ms(c.createdAt),
      parent: c.parent == null ? null : String(c.parent),
    };
  }

  /** The ticket with its comments (oldest first), as the server answers it. */
  const readTicket = (id) => call('GET', ticketPath(id));

  /** ClickUp's `{ add, rem }` as the one assignee a ticket can carry; undefined = untouched. */
  function assigneeChange(assignees) {
    if (!assignees) return { value: undefined };
    const add = assignees.add || [];
    const rem = assignees.rem || [];
    if (add.length > 1) return { error: `the tracker holds one assignee per ticket; asked to add ${add.length} (${add.join(', ')}).` };
    if (add.length === 1) return { value: Number(add[0]) };
    if (rem.length) return { value: null };
    return { value: undefined };
  }

  async function postOn(ticket, body, parent = null) {
    const text = commentText(stampCommentBody(body));
    const out = await call('POST', `${ticketPath(ticket)}/comments`, parent == null ? { body: text } : { body: text, parent: Number(parent) });
    if (!out.res.ok) return out;
    return withJson(out, await commentFromRow(out.json));
  }

  return {
    name: 'api',

    /** The one line saying how many requests this run made; the tracker has no per-minute budget. */
    reportLimits() {
      if (requests) log(`  tracker: ${requests} request(s) this run`);
    },

    async whoAmI() {
      const out = await call('GET', '/me');
      if (!out.res.ok) return out;
      names.set(out.json.id, out.json.name);
      return withJson(out, { user: { id: out.json.id, username: out.json.name, email: `${out.json.kind} actor in the tracker` } });
    },

    /** The configured project's details (name, prefix, GitHub repository, ...). Read-only. */
    projectDetails: () => call('GET', `/projects/${encodeURIComponent(project)}`),

    /** The tracker has no spaces: its one "list" is the configured project. */
    listsInSpace: async () => ({ res: { ok: true, status: 200, headers: { get: () => null } }, json: { lists: [{ id: project, name: `${project} (tracker project)` }] }, text: '' }),
    foldersInSpace: async () => ({ res: { ok: true, status: 200, headers: { get: () => null } }, json: { folders: [] }, text: '' }),

    /** The whole queue on page 0; `last_page` is always true. Closed (Live)
     *  tickets only with `includeClosed`, as on ClickUp. Descriptions are
     *  always included, so `markdown` needs no extra request. */
    async listTasksPage(list, page, { includeClosed = false } = {}) {
      const slug = projectFor(list);
      if (page > 0) {
        const json = { tasks: [], last_page: true };
        return { res: { ok: true, status: 200, headers: { get: () => null } }, json, text: JSON.stringify(json) };
      }
      const out = await call('GET', `/projects/${encodeURIComponent(slug)}/tickets${includeClosed ? '' : '?open=true'}`);
      if (!out.res.ok || !Array.isArray(out.json?.tickets)) return out;
      const tasks = [];
      for (const t of out.json.tickets) tasks.push(await taskFromTicket(t));
      return withJson(out, { tasks, last_page: true });
    },

    async getTask(task) {
      const out = await readTicket(task);
      if (!out.res.ok || !out.json?.id) return out;
      for (const c of out.json.comments || []) commentTicket.set(String(c.id), c.ticket);
      return withJson(out, await taskFromTicket(out.json));
    },

    async createTask(list, fields) {
      const body = {
        name: fields.name,
        description: fields.markdown_description ?? fields.description ?? '',
        status: fields.status || QUEUED,
      };
      if (fields.priority != null) body.priority = PRIORITY_NAME[fields.priority] ?? fields.priority;
      if (fields.tags) body.tags = fields.tags;
      const out = await call('POST', `/projects/${encodeURIComponent(projectFor(list))}/tickets`, body);
      if (!out.res.ok) return out;
      return withJson(out, await taskFromTicket(out.json));
    },

    /**
     * Change a ticket. `ifStatus` is the store's atomic guard: if the ticket
     * is no longer in that status nothing is written and the answer is HTTP
     * 409 with `moved: true`. The answer on success is the ticket as the
     * store read it back inside the same write.
     */
    async updateTask(task, fields, { ifStatus } = {}) {
      const body = {};
      if (fields.status !== undefined) body.status = fields.status;
      if (fields.name !== undefined) body.name = fields.name;
      if (fields.markdown_description !== undefined) body.description = fields.markdown_description;
      else if (fields.description !== undefined) body.description = fields.description;
      if (fields.priority !== undefined) body.priority = fields.priority == null ? null : (PRIORITY_NAME[fields.priority] ?? fields.priority);
      const who = assigneeChange(fields.assignees);
      if (who.error) return refused(400, who.error);
      if (who.value !== undefined) body.assignee = who.value;
      if (ifStatus !== undefined && ifStatus !== null) body.ifStatus = ifStatus;
      const out = await call('PATCH', ticketPath(task), body);
      if (out.res.status === 409) return { ...out, moved: true };
      if (!out.res.ok || !out.json?.ticket) return out;
      return withJson(out, await taskFromTicket(out.json.ticket));
    },

    /** Add or drop one tag, guarded on the version read just before, so a
     *  tag written by someone else in between is never overwritten. Any
     *  write in between (a status move, a comment) bumps that version, so a
     *  refused write is re-read and tried once more before it says "moved";
     *  ClickUp's tag call has no guard and never refuses for that. */
    async setTag(task, name, on) {
      const has = (t) => t.toLowerCase() === String(name).toLowerCase();
      let out;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const read = await readTicket(task);
        if (!read.res.ok || !read.json?.id) return read;
        const tags = read.json.tags || [];
        const next = on ? (tags.some(has) ? tags : [...tags, name]) : tags.filter((t) => !has(t));
        out = await call('PATCH', ticketPath(task), { tags: next, ifVersion: read.json.version });
        if (out.res.status !== 409) return out;
      }
      return { ...out, moved: true };
    },

    /**
     * Every top-level comment on the ticket, newest first, in one read.
     * Replies are not in this list, as on ClickUp; `listReplies` reads them.
     * Answers `{ paged, bad }` like the ClickUp tracker.
     */
    async listComments(task) {
      const out = await readTicket(task);
      if (!out.res.ok || !Array.isArray(out.json?.comments)) {
        return { paged: { complete: false, comments: [], failed: out, capped: false }, bad: out };
      }
      const comments = [];
      for (const c of out.json.comments) {
        const shaped = await commentFromRow(c);
        if (c.parent == null) comments.push(shaped);
      }
      comments.reverse();
      return { paged: { complete: true, comments, failed: null, capped: false }, bad: null };
    },

    postComment: (task, body) => postOn(task, body),

    async replyToComment(commentId, body) {
      const ticket = commentTicket.get(String(commentId));
      if (!ticket) return refused(404, `comment ${commentId} was not read in this run, so its ticket is unknown; read the ticket's comments first.`);
      return postOn(ticket, body, commentId);
    },

    /** A comment's replies, oldest first, in ClickUp's `{ comments }` shape. */
    async listReplies(commentId) {
      const ticket = commentTicket.get(String(commentId));
      if (!ticket) return refused(404, `comment ${commentId} was not read in this run, so its ticket is unknown; read the ticket's comments first.`);
      const out = await readTicket(ticket);
      if (!out.res.ok || !Array.isArray(out.json?.comments)) return out;
      const replies = [];
      for (const c of out.json.comments) {
        if (String(c.parent) === String(commentId)) replies.push(await commentFromRow(c));
      }
      return withJson(out, { comments: replies });
    },
  };
}
