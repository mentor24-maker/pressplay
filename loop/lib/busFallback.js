'use strict';

/**
 * WHERE AN ALARM GOES WHEN THE PARTY LINE WILL NOT TAKE IT.
 *
 * WHY THIS EXISTS (task 86bbwab1n, measured 2026-09-07/08)
 * The bus is the ONLY surface on which this pipeline raises an alarm. Every
 * one of these posts there and nowhere else:
 *
 *   heartbeat --check / --stale-check   a scheduled job stopped firing
 *   throughput --check                  the queue is STALLED, or UNKNOWN
 *   report_job_failure.mjs              a scheduled job failed
 *   reconcile --check                   ClickUp and the branches disagree
 *   stale_answer / checkout_currency    an answer or a checkout went stale
 *
 * On 2026-09-07 ClickUp's chat write endpoint began returning
 * `400 Invalid Request` for every message on the party line, including the
 * single word `test`. Reads on the same channel with the same token return
 * 200, and task-comment writes with the same token succeed — so it is not the
 * token, not the quota and not the channel id. The last message that landed
 * was 2026-09-07T21:39:49Z; every alarm raised after it was discarded with no
 * trace anywhere but the calling job's own console.
 *
 * This is the SECOND time. `scripts/clickup_direct.mjs` already carries a
 * comment naming "the 2026-08-23 chat outage", and records the one thing that
 * kept working through it: task comments. The relay grew a durable fallback
 * out of that day (`deliverToBus`), but it covers RELAYED messages only —
 * they have a ticket to fall back to, because the message is about one. The
 * alarms above have no ticket, so they got no fallback, so they are lost.
 *
 * WHAT THIS FILE DECIDES
 * An alarm with no ticket of its own still has somewhere to go: a standing
 * ticket whose whole job is to hold alarms the bus refused. Its identity is
 * its NAME, not an id in a config file — the same choice `nodeHeartbeat`'s
 * roll call and `pulseDigest`'s report make, for the same reason: a recorded
 * id rots the moment somebody deletes the ticket, and an id nobody can resolve
 * fails in exactly the way this whole ticket is about.
 *
 * The rendering lives here rather than in the command so it can be tested
 * without a network, and so the words a dropped alarm arrives wearing are one
 * reviewable thing rather than a template buried in a 5,000-line CLI.
 */

/**
 * THE TEAM CHAT (task 86bc0mmyu, Dane's answer "(B) Stay on the free plan",
 * 2026-09-21).
 *
 * ClickUp's chat channel is not on the Free Forever plan — the ClickUp app
 * says so in words ("Chat Messages isn't available on your current plan"),
 * the API reduces it to `400 Invalid Request`. Dane chose not to upgrade, so
 * this ticket stops being the place refused alarms are kept and becomes the
 * team chat on purpose: a plain name, and posts that do not arrive dressed as
 * errors. The chat channel is still tried first, so an upgrade later would put
 * messages back in the channel with no code change.
 *
 * The ticket's identity is still its NAME. `LEGACY_TASK_NAMES` are the names
 * it has had before: a ticket under one of them is the SAME ticket, renamed on
 * first contact (`saveUndeliveredAlarm`), because a machine still running the
 * old code looks it up by the old name and would otherwise create a second one.
 */
const { operatorName } = require('./substrateConfig.js');

const FALLBACK_TASK_NAME = 'Team chat';
const LEGACY_TASK_NAMES = ['Undelivered alarms'];

/** Every name the team chat ticket answers to, current name first. */
const ALL_TASK_NAMES = [FALLBACK_TASK_NAME, ...LEGACY_TASK_NAMES];

/** Is this ticket the team chat, under its current name or an old one? */
function isTeamChatTask(task) {
  const name = String(task?.name ?? '').trim().toLowerCase();
  return ALL_TASK_NAMES.some((n) => n.toLowerCase() === name);
}

/** Does it still carry an old name, so the first new-code post renames it? */
function needsRename(task) {
  return isTeamChatTask(task)
    && String(task?.name ?? '').trim().toLowerCase() !== FALLBACK_TASK_NAME.toLowerCase();
}

/**
 * Its status. A status no loop claims from, for the same reason the roll call
 * uses one: this ticket is a noticeboard, not work. Overridable because a list
 * that lacks the status would otherwise refuse the create and lose the message
 * at the exact moment it is trying to save it.
 */
const FALLBACK_TASK_STATUS = 'Live';

/** The seed description, written when the ticket is created or renamed. */
function renderFallbackSeed() {
  return [
    `The **${FALLBACK_TASK_NAME}**. Do not build this, do not close it, do not delete it.`,
    '',
    'This is where the machines and agent sessions post what they would otherwise',
    'say in a chat channel: pass reports, decisions, and alarms when a scheduled',
    'job stops or fails. ClickUp\'s chat channel is not on the free plan, and on',
    `2026-09-21 ${operatorName()} chose to stay on the free plan and use this ticket instead.`,
    '',
    'Each comment starts with which machine posted it and when. Most are routine.',
    'An alarm says what broke in its own words.',
    '',
    `**This ticket puts itself in ${operatorName()}'s ClickUp "Assigned to me" list** whenever`,
    'something is posted. That is the notification: every script here posts as',
    `${operatorName()}, and ClickUp does not notify anyone about their own comments, so`,
    'following the ticket would show nothing new. Unassign yourself once you have',
    'read what is here; the next post puts it back. (Before the assignment existed,',
    'the pipeline was dead for 90 hours from 2026-09-16 and the alarm that said so',
    'sat here unread, because nothing put this ticket in front of anyone.)',
    '',
    'It used to be called "Undelivered alarms", when the chat channel was expected',
    'to come back. The older comments below still carry that wording.',
  ].join('\n');
}

/**
 * The comment a message arrives as: who posted it, when, and the message.
 *
 * The message's own text is reproduced VERBATIM. It was already written for a
 * reader; re-summarising it here would put a second author between the fault
 * and the person reading about it.
 *
 * `why` (the chat channel's refusal) is deliberately NOT on the comment any
 * more. With the channel off the plan it is the same `HTTP 400` on every post,
 * and printing it on each one is what made the team chat read as an error log.
 * The calling job's own output still carries it (`renderRouteLine`).
 */
function renderFallbackComment({ text, node, at }) {
  const who = String(node || '').trim() || 'an unnamed machine';
  const when = String(at || '').trim();
  return [
    `**From ${who}**${when ? ` · ${when}` : ''}`,
    '',
    String(text || '').trim(),
  ].join('\n');
}

/**
 * The line the command prints about where the message actually went.
 *
 * Separate from the comment because the two readers are different: this one is
 * for the log of the job that raised the alarm, and its job is to make
 * "delivered somewhere else" impossible to mistake for "delivered as normal".
 */
function renderRouteLine({ via, channel, why, url, assignedToOperator, assignWhy }) {
  if (via === 'chat') return `Posted to channel ${channel}.`;
  if (via === 'ticket') {
    return [
      '',
      `Posted to the "${FALLBACK_TASK_NAME}" ticket.`,
      url ? `  ${url}` : '',
      `  (The ClickUp chat channel${channel ? ` ${channel}` : ''} did not take it: ${why}. That is expected on the`
        + ` free plan — ${operatorName()} chose the ticket over an upgrade on 2026-09-21.)`,
      // SAVED AND SEEN ARE DIFFERENT CLAIMS (task 86bc3t0n1). The 90-hour
      // outage of 2026-09-16 was reported correctly, saved correctly here, and
      // read by nobody — the ticket had no assignee, so it appeared in no view
      // Dane opens. The assignment is what makes it seen; say when it failed.
      assignedToOperator
        ? `The ticket is in ${operatorName()}'s ClickUp "Assigned to me" list, which is how he sees it.`
        : `NOBODY HAS BEEN PUT ON IT: ${assignWhy || 'the assignment was not attempted'}. The message is saved`
          + ' and durable, and it is on a ticket that appears in no view anyone opens. Say so out loud.',
    ].filter(Boolean).join('\n');
  }
  return `Delivered nowhere (${why}).`;
}

/**
 * WHY A LOOP NOTE REFUSED, IN THE TERMS THAT CHANGE WHAT A PASS SHOULD DO.
 *
 * Two causes print the same failure today and they are opposites:
 *
 *   "not found"      the field has never been created. The pass carries on;
 *                    only the note is missing, and nothing was ever depending
 *                    on it. This is what the skills tell a pass to expect.
 *   "plan exhausted" the field EXISTS and refuses writes, because the
 *                    workspace is out of custom-field usages. The Loop note is
 *                    the only surface on which a pass in flight is visible to
 *                    another pass, so a refusal here means THIS PASS'S CLAIM
 *                    IS INVISIBLE and another pass may take the ticket out
 *                    from under it. That is the 2026-08-22 double-review
 *                    failure (PR #362) with the guard switched off.
 *
 * The skills say a stamp failure is not a failure of the build. That was right
 * when the only cause was "not set up yet". Told apart, the second cause can
 * say the thing that is actually true.
 */
function classifyFieldRefusal({ status, body }) {
  const text = String(body || '');
  if (/custom field usages exceeded/i.test(text)) {
    return {
      kind: 'plan-exhausted',
      lines: [
        '',
        'THE LOOP NOTE EXISTS AND IS REFUSING WRITES — this is NOT "the field is not set up yet".',
        `ClickUp says: ${text.slice(0, 200)}`,
        '',
        'What this costs, in plain words: the Loop note is the only place another pass',
        'can see that this ticket is already being worked on. With it refusing writes,',
        'every pass reads an empty note and takes the ticket — which is exactly the',
        '2026-08-22 failure the field was added to prevent (two review passes verified',
        'PR #362 at the same time and the second overwrote the first one\'s verdict).',
        '',
        'Your claim is invisible. The ClickUp status move still happened and is still',
        'the real claim, so carry on — but say in your run report that the queue could',
        'not be stamped, and do not treat a ticket with an empty Loop note as free.',
        '',
        'DO NOT ASK ANYONE TO PAY FOR THIS. On 2026-08-23 the identical pair of',
        'symptoms — every chat write 400, every custom-field write "usages exceeded" —',
        'was diagnosed as the Free Forever plan and the proposed fix was an upgrade.',
        'It was wrong. The plan was unchanged before, during and after, and the window',
        'closed on its own after about sixteen hours. See docs/LOOP_ENGINEERING.md,',
        '"The party line is not the only way out". Check whether it is a window before',
        'you go looking for a permission: read the plan, read the party line timestamps,',
        'and try again in an hour.',
      ],
    };
  }
  return { kind: 'other', lines: [], status: status ?? null };
}

module.exports = {
  ALL_TASK_NAMES,
  FALLBACK_TASK_NAME,
  FALLBACK_TASK_STATUS,
  LEGACY_TASK_NAMES,
  classifyFieldRefusal,
  isTeamChatTask,
  needsRename,
  renderFallbackComment,
  renderFallbackSeed,
  renderRouteLine,
};
