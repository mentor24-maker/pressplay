'use strict';

/**
 * clickupTicketLink — what counts as "this PR names its ticket", defined ONCE.
 *
 * WHY THIS FILE EXISTS (2026-08-26, task 86bbmmv7t, finding 2). Two readers
 * answered that question and they did not agree. `pr-opened` accepted a bare
 * task id — `ClickUp: 86bbjt18r` — and let the PR through; the review gate
 * required a full `app.clickup.com/t/<id>` URL and refused the same body with
 * "the PR body carries no ClickUp ticket link". The failure direction was safe
 * (it refused rather than passed), but once the gate is REQUIRED it strands a
 * PR that the command which checked it calls traceable, with a message saying
 * the opposite of what the reader can plainly see in the body.
 *
 * The disagreement was possible only because each side had its own matcher. So
 * there is one matcher now, here, and both sides import it — the same shape
 * the verdict parser already uses (`mergeOnComment.isReviewPassed`, imported by
 * the gate and by `loopTrail` rather than re-implemented in either).
 *
 * WHICH WAY THE DISAGREEMENT WAS SETTLED: the **full URL wins**, and a bare id
 * is no longer enough. Two reasons, in order of weight:
 *
 *   1. A bare id cannot be recognised safely. Ids are lowercase alphanumeric
 *      (`86bbmmv7t`), which is also the shape of an abbreviated commit sha, a
 *      build hash, and half the tokens in a stack trace. Matching them in prose
 *      means either false positives or a workspace-specific prefix rule — and a
 *      matcher that fails OPEN on a coincidence is the worse of the two errors,
 *      because it certifies a PR as traceable to a ticket nobody can open.
 *   2. The URL is what the reader needs anyway. A link in a PR body is one
 *      click; an id is a copy, a paste and a search. `loop-build` step 7 has
 *      always asked for the URL on a line of its own, so this makes the
 *      shipped rule match the written one rather than the other way round.
 *
 * Both live URL shapes are accepted: the plain `app.clickup.com/t/<id>` form
 * the loop writes, and the `t/<workspace>/<id>` form ClickUp's own "copy link"
 * button produces. Ids are alphanumeric and workspace segments are all digits,
 * so the two are told apart by shape rather than by position.
 *
 * TRACKER IDS AND THE TRACKER'S OWN LINK (2026-10-28, SP-32). Since Spirality
 * moved off ClickUp (SP-31) its tickets are `SP-12`: the configured
 * `trackerPrefix`, a hyphen, a number. The id pattern above stopped at the
 * hyphen, so `app.clickup.com/t/SP-12` read as ticket "SP" and the tracker's
 * own `<trackerUrl>/tickets/SP-12` read as nothing. Both now read `SP-12`:
 *
 *   - a tracker id is read only with the CONFIGURED prefix (CLAUDE.md
 *     engineering rule 2), tried before the ClickUp id so the hyphen is kept;
 *   - the tracker link is `<origin>/t/<prefix>-<n>` (the ticket's web page)
 *     or `<origin>/tickets/<prefix>-<n>` (its API route, which PR #27 itself
 *     carries), on the configured tracker's port, whatever the host. A
 *     trackerUrl that spells out its scheme's default port (`:443`) is read
 *     with or without it. One tracker is reached by several
 *     names — `mac-mini.local` from the MacBook, `127.0.0.1` on the Mini,
 *     where Doppler's TRACKER_URL overrides the config file — so pinning the
 *     host would refuse a link to the right ticket depending on which machine
 *     reads it. The id is still the configured prefix's, and the gate still
 *     confirms the ticket records THIS PR (`reviewGate.ticketNamesThisPr`).
 *
 * The prefix and address come from the project config by default; every
 * reader takes `{ trackerPrefix, trackerUrl }` to say otherwise (tests, and a
 * caller that already holds a config).
 *
 * THE LINK A PERSON IS TOLD TO PASTE (review of SP-32, round 1) is the page,
 * `/t/<id>`: `/tickets/<id>` is the API and answers a signed-out browser with
 * a 401. And it is built from the address WRITTEN IN THE CONFIG FILE, not
 * Doppler's TRACKER_URL: on the Mini that override is `127.0.0.1`, which opens
 * nothing from the MacBook or from GitHub. Reading accepts any host; printing
 * uses the one everybody can reach.
 */

const { projectConfig, filedTrackerUrl } = require('./substrateConfig.js');

/**
 * The plain ClickUp link, any id shape. Kept for callers that only want the
 * ClickUp form; the readers below use `ticketLinkRe`, which also knows the
 * tracker's ids and link.
 */
const CLICKUP_LINK_RE = /https?:\/\/app\.clickup\.com\/t\/(?:\d+\/)?([a-z0-9]+(?:-\d+)?)/i;

const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The tracker settings a reader uses: the ones given, else the project config's. */
function trackerOptions(opts) {
  if (opts && ('trackerPrefix' in opts || 'trackerUrl' in opts || 'tracker' in opts)) {
    return {
      tracker: opts.tracker || null,
      trackerPrefix: opts.trackerPrefix || null,
      trackerUrl: opts.trackerUrl || null,
      pageUrl: opts.trackerPageUrl || opts.trackerUrl || null,
    };
  }
  const config = projectConfig();
  const trackerUrl = (config && config.trackerUrl) || null;
  return {
    tracker: (config && config.tracker) || null,
    trackerPrefix: (config && config.trackerPrefix) || null,
    trackerUrl,
    pageUrl: (config && filedTrackerUrl()) || trackerUrl,
  };
}

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' };

/** `{ origin, path, port, defaultPort }` of a tracker address, or null when it does not parse. */
function trackerAddress(trackerUrl) {
  try {
    const u = new URL(trackerUrl);
    return {
      origin: u.origin,
      path: u.pathname.replace(/\/+$/, ''),
      port: u.port,
      defaultPort: DEFAULT_PORTS[u.protocol] || '',
    };
  } catch {
    return null;
  }
}

/**
 * One regex for every ticket link a body may carry, built from the config.
 * Group 1 is the id in a ClickUp link, group 2 the id in a tracker link.
 */
function ticketLinkRe(opts, flags = 'i') {
  const { trackerPrefix, trackerUrl } = trackerOptions(opts);
  const trackerId = trackerPrefix ? `${escapeRe(trackerPrefix)}-\\d+(?!\\d)` : '';
  const clickupId = trackerId ? `(?:${trackerId}|[a-z0-9]+)` : '[a-z0-9]+';
  const shapes = [`https?:\\/\\/app\\.clickup\\.com\\/t\\/(?:\\d+\\/)?(${clickupId})`];
  if (trackerId && trackerUrl) {
    // projectConfig validated it; an unreadable one reads as no path, any port-less host.
    const { port, path, defaultPort } = trackerAddress(trackerUrl) || { port: '', path: '', defaultPort: '' };
    // URL() drops a default port, so "https://host:443" has none: a link may still spell it out.
    const portRe = port ? `:${port}(?!\\d)` : defaultPort ? `(?::${defaultPort}(?!\\d))?(?!:)` : '(?!:)';
    const host = `https?:\\/\\/[^\\s/:?#<>()\\[\\]]+${portRe}`;
    shapes.push(`${host}${escapeRe(path)}\\/(?:t|tickets)\\/(${trackerId})`);
  } else {
    shapes.push('(?!)()'); // never matches; keeps the tracker id in group 2
  }
  return new RegExp(shapes.join('|'), flags);
}

/** Every ticket a body links to, in the order they appear, lowercased. */
function findTicketIds(prBody, opts) {
  return [...String(prBody || '').matchAll(ticketLinkRe(opts, 'gi'))]
    .map((m) => String(m[1] || m[2] || '').toLowerCase())
    .filter(Boolean);
}

/**
 * The ticket id a PR body points at, or '' if it points at none.
 *
 * This is the FIRST link in the body, which is a convention and not a fact —
 * see `reviewGate.ticketNamesThisPr` for the check that confirms the ticket it
 * lands on is actually this PR's own.
 */
function findTicketId(prBody, opts) {
  const m = ticketLinkRe(opts).exec(String(prBody || ''));
  return m ? (m[1] || m[2]) : '';
}

/**
 * Does this body link to THIS ticket? Accepts the task id, the task URL, or
 * both; a body that links to some other ticket does not count, which is the
 * case that let two PRs ship on 2026-08-22 pairable only by their titles.
 */
function bodyNamesTicket(body, taskId, taskUrl, opts) {
  const wanted = String(taskId || '').trim().toLowerCase()
    || findTicketId(taskUrl, opts).toLowerCase();
  if (!wanted) return false;
  return findTicketIds(body, opts).includes(wanted);
}

/**
 * The link to a ticket that a person can open: the tracker's page
 * `<trackerUrl>/t/<id>` on "api" (the config file's address, see above), the
 * ClickUp link otherwise. What a refusal tells the reader to paste, and what
 * the gate prints.
 */
function ticketLink(id, opts) {
  const { tracker, pageUrl } = trackerOptions(opts);
  const address = tracker === 'api' && pageUrl ? trackerAddress(pageUrl) : null;
  if (address) return `${address.origin}${address.path}/t/${id}`;
  return `https://app.clickup.com/t/${id}`;
}

/** The line a PR body carries to name its ticket: `Ticket: <link>`. */
function ticketLine(id, opts) {
  return `Ticket: ${ticketLink(id, opts)}`;
}

module.exports = {
  CLICKUP_LINK_RE,
  ticketLinkRe,
  findTicketId,
  findTicketIds,
  bodyNamesTicket,
  ticketLink,
  ticketLine,
};
