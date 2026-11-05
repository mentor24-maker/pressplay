'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TRIGGERS,
  PROPOSAL_CUES,
  INNOCENT_PHRASES,
  costlyTriggers,
  isCostlyAsk,
  describeTriggers,
} = require('./costlyAsk.js');

// ------------------------------------------------- the asks that must fire

test('the ask that started this fires', () => {
  // Verbatim option A from the 2026-08-23 escalation.
  assert.ok(isCostlyAsk('Put the workspace back on a paid plan.'));
});

test('each class of costly ask fires', () => {
  assert.ok(isCostlyAsk('Approve the $29/month spend and I will re-enable it.'), 'money');
  assert.ok(isCostlyAsk('Upgrade the workspace and tell me when it is done.'), 'plan');
  assert.ok(isCostlyAsk('Delete the 550 untenanted rows so the backfill can run.'), 'irreversible');
  assert.ok(isCostlyAsk('Rotate CHANNELS_ENCRYPTION_KEY when you get a minute.'), 'credential');
});

test('a dollar figure fires however it is phrased', () => {
  // There is no word to list for this one, so it is matched on its own.
  assert.ok(isCostlyAsk('It comes to $4.50 a day at current volume — your call.'));
  assert.equal(costlyTriggers('$25')[0].word, '$ amount');
});

test('every listed trigger word actually fires on its own', () => {
  // Otherwise a word could sit in the list looking protective while matching
  // nothing — the shape of a check that silently does not run (DOCTRINE 3.11).
  // A bare noun is put in the frame it is meant to fire in, since on its own
  // it names a thing rather than proposing one — see PROPOSAL_CUES.
  for (const trigger of TRIGGERS) {
    const sentence = trigger.needsProposal
      ? `Please approve the ${trigger.word}.`
      : `Please ${trigger.word} it.`;
    assert.ok(
      isCostlyAsk(sentence),
      `"${trigger.word}" is in the list but does not fire on "${sentence}"`,
    );
  }
});

test('a hyphenated spelling fires — the whole gate used to vanish on one', () => {
  // Found by review round 2, 2026-08-26. Each word was bounded by "not a word
  // character OR HYPHEN", so a trigger preceded by a hyphen never matched and
  // these posted with no evidence demanded at all — not refused and reworded,
  // never checked. They are ordinary English spellings of exactly the
  // irreversible acts criterion 1 names.
  assert.ok(isCostlyAsk('Approve the hard-delete of the 550 rows.'), 'hard-delete');
  assert.ok(isCostlyAsk('Authorise a force-delete of the archive.'), 'force-delete');
  assert.ok(isCostlyAsk('Run the auto-purge tonight.'), 'auto-purge');
  assert.ok(isCostlyAsk('Approve the key re-rotation.'), 're-rotation');
  // And the hyphenated trigger the old boundary was written for still works.
  assert.ok(isCostlyAsk('It needs a force-push to land.'), 'force-push');
});

test('the base form of a money verb fires, not only the -s form', () => {
  // The mirror image of the missing third-person forms, found the same day:
  // `costs` was listed and `cost` was not, so the commoner phrasing was silent.
  assert.ok(isCostlyAsk('This will cost about thirty dollars a month.'), 'cost');
  assert.ok(isCostlyAsk('It costs about thirty dollars a month.'), 'costs');
  assert.ok(isCostlyAsk('It would be costing us thirty dollars a month.'), 'costing');
});

test('a bare noun needs a cue that PROPOSES it, not a sentence that mentions it', () => {
  // Review round 2: these five nouns fired on cards that asked for nothing,
  // so `buildCard` threw and the agent could not hand the ticket off until it
  // reworded a card that was already correct. Criterion 3's reasoning applies
  // directly — a gate that fires on everything gets bypassed, and then it
  // protects nothing.
  for (const needed of [
    'Nothing right now. The billing page renders correctly again.',
    'Nothing needed — the deletion already happened last week.',
    'Nothing right now; the rotation is already done.',
    'Just confirm you saw the invoice screenshot.',
    'The migration ran last month, so nothing is needed from you.',
  ]) {
    assert.equal(isCostlyAsk(needed), false, needed);
  }
  // ...and the same nouns still fire when something actually proposes them.
  for (const needed of [
    'Approve the deletion of the 550 untenanted rows.',
    'Run the migration on Tuesday when the site is quiet.',
    'Authorise the credential rotation.',
    'Please go ahead with the rotation tonight.',
    'Start a subscription on the paid tier.',
    'Sign off on the invoice so I can file it.',
  ]) {
    assert.ok(isCostlyAsk(needed), needed);
  }
});

test('a proposal cue only rescues the noun in ITS OWN sentence', () => {
  // Otherwise "approve the copy tweak" anywhere in the ask would drag every
  // later mention of a noun into the gate.
  assert.equal(
    isCostlyAsk('Approve the copy tweak on the header. The deletion already ran last week.'),
    false,
  );
});

test('third-person forms fire — the natural way to phrase an approval', () => {
  // Found by review, 2026-08-26. The list carried `delete`/`deleting`/
  // `deletion` but not `deletes`, so every one of these posted with no
  // evidence at all — and describing what the operator's YES will do is the
  // most natural phrasing there is.
  assert.ok(isCostlyAsk('This deletes all 550 untenanted rows.'), 'deletes');
  assert.ok(isCostlyAsk('It rotates CHANNELS_ENCRYPTION_KEY.'), 'rotates');
  assert.ok(isCostlyAsk('Approving this upgrades the workspace to Business.'), 'upgrades');
  assert.ok(isCostlyAsk('This migrates every page to the new schema.'), 'migrates');
  assert.ok(isCostlyAsk('Approving this purchases another seat.'), 'purchases');
});

test('every verb carries its base, gerund and third-person form together', () => {
  // Criterion 4 in the shape that actually protects it: the gap review found
  // was one missing form on verbs whose other forms were all present, and
  // nothing was watching for that.
  const listed = new Set(TRIGGERS.map((t) => t.word));
  for (const [base, gerund, third] of [
    ['spend', 'spending', 'spends'],
    ['buy', 'buying', 'buys'],
    ['pay', 'paying', 'pays'],
    // `cost` is here because it was the one that went missing next: review
    // round 2 found `costs` listed and the base form absent, and this test
    // passed with the hole open because it did not name the verb.
    ['cost', 'costing', 'costs'],
    ['purchase', 'purchasing', 'purchases'],
    ['subscribe', 'subscribing', 'subscribes'],
    ['upgrade', 'upgrading', 'upgrades'],
    ['downgrade', 'downgrading', 'downgrades'],
    ['delete', 'deleting', 'deletes'],
    ['rotate', 'rotating', 'rotates'],
    ['revoke', 'revoking', 'revokes'],
    ['migrate', 'migrating', 'migrates'],
    ['wipe', 'wiping', 'wipes'],
    ['purge', 'purging', 'purges'],
    ['truncate', 'truncating', 'truncates'],
  ]) {
    for (const form of [base, gerund, third]) {
      assert.ok(listed.has(form), `"${form}" is missing from TRIGGERS`);
    }
  }
});

test('every bare noun carries its plural, and every plural fires', () => {
  // THE ROUND-5 FINDING. Every needsProposal noun fired in the singular and
  // was silent in the plural — "Approve the deletions" demanded no evidence
  // while "Approve the deletion" did. A plural act is more costly than its
  // singular, not less, so this was the gate declining on exactly the asks it
  // most exists for.
  //
  // Checked BOTH ways, like the cue-family test: every pair fully listed, and
  // every needsProposal noun belonging to a pair — so a singular cannot be
  // added later without its plural, which is the shape of the hole.
  const listed = new Set(TRIGGERS.map((t) => t.word));
  const pairs = [
    ['subscription', 'subscriptions'],
    ['payment', 'payments'],
    ['invoice', 'invoices'],
    ['deletion', 'deletions'],
    ['rotation', 'rotations'],
    ['migration', 'migrations'],
  ];
  for (const pair of pairs) {
    for (const form of pair) {
      assert.ok(listed.has(form), `"${form}" is missing from TRIGGERS`);
    }
  }
  // `billing` is the one bare noun with no plural in use — "billings" is not
  // English anyone writes here. Named rather than silently skipped.
  const covered = new Set([...pairs.flat(), 'billing']);
  for (const trigger of TRIGGERS) {
    if (!trigger.needsProposal) continue;
    assert.ok(covered.has(trigger.word), `"${trigger.word}" is a bare noun with no plural in this test`);
  }

  // ...and the sentences the reviewer actually wrote, end to end.
  assert.ok(isCostlyAsk('Approve the deletions tonight.'), 'deletions');
  assert.ok(isCostlyAsk('Approve the migrations tonight.'), 'migrations');
  assert.ok(isCostlyAsk('Authorise the key rotations.'), 'rotations');
  assert.ok(isCostlyAsk('Sign off on the invoices.'), 'invoices');
  assert.ok(isCostlyAsk('Approve the payments.'), 'payments');
  assert.ok(isCostlyAsk('Start the subscriptions.'), 'subscriptions');
  assert.ok(isCostlyAsk('Approve the purchases.'), 'purchases');
});

test('a plural noun still needs a cue, so a report is not refused', () => {
  // The plurals inherit needsProposal for the reason round 2 added it: a noun
  // names a thing as readily as it proposes one, and a gate that refuses
  // "nothing needed" cards is one people route around.
  assert.equal(isCostlyAsk('Nothing needed — the deletions already happened last week.'), false);
  assert.equal(isCostlyAsk('Nothing right now. The invoices render correctly again.'), false);
});

// -------------------------------------------- the asks that must NOT fire

test('"costs" fires on a price but not on "costs nothing"', () => {
  // The word earns its place on "it costs $29 a month", and the same word is
  // how an agent says an option is free.
  assert.ok(isCostlyAsk('Running it hourly costs about $6 a month.'));
  assert.equal(isCostlyAsk('Leaving it as it is costs nothing.'), false);
});

test('an ordinary ask is untouched', () => {
  // Criterion 3, and the whole value of the gate: one that fires on everything
  // gets routed around, and then it protects nothing.
  assert.equal(isCostlyAsk('Should the chip show the count or the label?'), false);
  assert.equal(isCostlyAsk('A or B — I have no preference, but you might.'), false);
  assert.equal(isCostlyAsk('Nothing right now. Flagging it so you know it landed.'), false);
  assert.equal(isCostlyAsk('Confirm the scope: pages only, or posts as well?'), false);
});

test('innocent phrases that contain a trigger word do not fire', () => {
  for (const phrase of INNOCENT_PHRASES) {
    assert.equal(isCostlyAsk(`Please ${phrase} to the second column.`), false, phrase);
  }
});

test('a trigger word inside a longer word does not fire', () => {
  // Whole-word matching: "buy" must not fire on "buyer", "pay" on "payload".
  assert.equal(isCostlyAsk('Delete the payload from the buyer feed.'), true,
    'the same sentence with a real trigger in it — proof the sample is not inert');
  assert.equal(isCostlyAsk('The payload came back from the buyer feed.'), false);
});

// ------------------------------------------------------------- reporting

test('describeTriggers names the words and their classes', () => {
  const described = describeTriggers(costlyTriggers('spend to upgrade'));
  assert.match(described, /spend/);
  assert.match(described, /upgrade/);
  assert.match(described, /money/);
  assert.match(described, /plan/);
});

test('every trigger carries its reasoning, so adding one means saying why', () => {
  for (const trigger of TRIGGERS) {
    assert.ok(trigger.why && trigger.why.length > 15, `${trigger.word} has no reasoning`);
    assert.ok(['money', 'plan', 'irreversible'].includes(trigger.class), `${trigger.word} has an unknown class`);
  }
});

test('every proposal cue carries its reasoning and actually rescues a noun', () => {
  // Same contract as the trigger list: adding a cue means saying why, and a
  // cue that matches nothing is a check that silently does not run.
  for (const cue of PROPOSAL_CUES) {
    assert.ok(cue.why && cue.why.length > 15, `${cue.word} has no reasoning`);
    assert.ok(isCostlyAsk(`Please ${cue.word} the migration.`), `${cue.word} does not fire`);
  }
});

// ----------------------------------------- review round 3: cue inflections

test('the natural inflections of a proposal cue fire', () => {
  // Review round 3, 2026-08-26, ran these through the shipped function and
  // every one was SILENT: PROPOSAL_CUES carried only base forms, so an
  // ordinary English spelling of exactly the acts criterion 1 names posted
  // with no evidence demanded at all — never refused, never checked.
  assert.ok(isCostlyAsk('Proceeding with the deletion of the 550 untenanted rows'), 'proceeding');
  assert.ok(isCostlyAsk('Performing the key rotation on Tuesday'), 'performing');
  assert.ok(isCostlyAsk('This executes the migration tonight.'), 'executes');
  assert.ok(isCostlyAsk('This triggers the migration of every page.'), 'triggers');
  assert.ok(isCostlyAsk('Kicking off the migration at 9pm'), 'kicking off');
  assert.ok(isCostlyAsk('Signing off on the invoice'), 'signing off');
});

test('every proposal cue carries its base, gerund and third-person form together', () => {
  // The mirror of the TRIGGERS completeness test, and it is here for the same
  // reason: the old cue test only asserted that each LISTED cue fires, which
  // stays green for as long as a form is simply absent. That is the blind spot
  // that let `cost` through round 2 and every cue inflection through round 3.
  // Checked BOTH ways — every family is fully listed, and every listed cue
  // belongs to a family, so a lone form cannot be added without its siblings.
  const families = [
    ['approve', 'approving', 'approves'],
    ['authorise', 'authorising', 'authorises'],
    ['authorize', 'authorizing', 'authorizes'],
    ['run', 'running', 'runs'],
    ['start', 'starting', 'starts'],
    ['perform', 'performing', 'performs'],
    ['execute', 'executing', 'executes'],
    ['trigger', 'triggering', 'triggers'],
    ['proceed', 'proceeding', 'proceeds'],
    ['go ahead', 'going ahead', 'goes ahead'],
    ['sign off', 'signing off', 'signs off'],
    ['kick off', 'kicking off', 'kicks off'],
  ];
  const listed = new Set(PROPOSAL_CUES.map((cue) => cue.word));
  for (const family of families) {
    for (const form of family) {
      assert.ok(listed.has(form), `"${form}" is missing from PROPOSAL_CUES`);
    }
  }
  const known = new Set(families.flat());
  for (const cue of PROPOSAL_CUES) {
    assert.ok(known.has(cue.word), `"${cue.word}" is a cue with no family in this test`);
  }
});

test('a past-tense cue stays silent, because a report is not a proposal', () => {
  // Deliberate, and the reason is sharper than it is on the triggers: adding
  // past tense here would REGRESS round 2's own fix, which exists so that
  // "the deletion already happened" can be said without being refused.
  assert.equal(isCostlyAsk('Started the subscription on the paid tier'), false);
  assert.equal(isCostlyAsk('Nothing needed — I ran the migration last week.'), false);
});

test('the literal sense of "pay off" is a money ask and must fire', () => {
  // Round 2 added the bare phrase to INNOCENT_PHRASES for symmetry; round 3
  // found what that cost — the literal spelling went silent, which is a money
  // ask escaping through an escape hatch. The list's own rule settles it:
  // anything genuinely ambiguous fires and is answered with a paste.
  assert.ok(isCostlyAsk('Pay off the outstanding invoice.'), 'literal, an invoice');
  assert.ok(isCostlyAsk('Pay off the balance on the card.'), 'literal, a card balance');
  assert.ok(isCostlyAsk('It will pay off later.'), 'the figurative sense costs a reword, which is the cheap direction');
});

test('an innocent phrase is lifted out as a phrase, not as a run of characters', () => {
  // The phrases were removed with a raw substring split, so "pays offshore"
  // lost "pays off" out of the middle of a word and left "shore" behind —
  // disarming the trigger on a sentence that never contained the phrase.
  // Deliberately no dollar figure and no other trigger: the `$ amount` matcher
  // fires on its own and would make this assertion inert, which is how a
  // break-test says "caught" without the fix being present.
  assert.ok(isCostlyAsk('The agency pays offshore contractors weekly.'));
  assert.equal(isCostlyAsk('The retainer pays off over a year.'), false,
    'the real phrase is still lifted out');
});
