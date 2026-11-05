'use strict';

/**
 * Does this ask cost the operator MONEY, or something he cannot undo?
 *
 * WHY THIS EXISTS (2026-08-23). An agent escalated to Dane and asked him to
 * spend money on a diagnosis that was wrong. The bus chat channel had been
 * refusing every write for sixteen hours; a custom-field write failed the same
 * day with "Custom field usages exceeded for your plan"; the agent read
 * `GET /team/{id}/plan` back as `Free Forever`, joined the three, and wrote it
 * up with a clean evidence table and three options — option A being "put the
 * workspace back on a paid plan". Confident, well argued, and in his inbox.
 *
 * It was wrong. Re-measured hours later on the SAME token and the SAME
 * unchanged Free plan: chat POST 200 and verified in the channel, custom-field
 * write verified by read-back. The plan was Free before, during and after.
 * Paying would have fixed nothing; the outage was transient and cleared itself.
 *
 * The mistake was not the hypothesis — a plausible correlation on the day two
 * features broke is reasonable. It was that the hypothesis reached the
 * operator's WALLET without anyone re-running the failing call. One command
 * would have settled it, and the escalation was the last moment it was cheap
 * to run and the first moment being wrong was expensive.
 *
 * So the gate is deliberately NOT a checking agent. A general
 * assumption-checker adds a round trip, makes assertions of its own, and burns
 * tokens continuously to catch a class a free rule catches — and the evidence
 * for "assertions of its own" is this very incident, where the agent that
 * produced the wrong diagnosis was already the careful one. This is cheap,
 * narrow and mechanical: it fires only on asks that cost money or cannot be
 * undone, and it demands a command and its output rather than a judgment.
 *
 * Narrowness is the whole value. A gate that fires on every escalation gets
 * routed around, and then it protects nothing — so an ordinary ask (a design
 * question, a scope choice, an A-or-B with no cost) must sail through
 * untouched, and there is a test pinning exactly that.
 */

/**
 * The trigger words, each with the reason it is here. Adding one is a one-line
 * change with a test beside it — that is the contract this list is shaped for.
 *
 * `word` is matched case-insensitively on whole-word boundaries, so `spend`
 * does not fire on `spending` — every form that should fire is listed
 * explicitly rather than stemmed. Stemming is where a list like this quietly
 * grows a reach nobody reviewed.
 *
 * That explicitness has a cost, and it has been paid twice already. The first
 * version carried the base and gerund forms but no THIRD-PERSON ones, and
 * review (2026-08-26) found that "this deletes all 550 rows", "it rotates the
 * key" and "approving this upgrades the workspace" all posted with no evidence
 * at all. The fix added the `-s` forms — and the next review round found the
 * mirror image: `costs` was there and the BASE form `cost` was not, so "this
 * will cost about thirty dollars a month" was silent while "it costs about
 * thirty dollars a month" fired. **When you add a verb, add all three forms**,
 * and add it to the completeness test below the list, which is what actually
 * holds the rule up.
 *
 * PAST TENSE IS DELIBERATELY ABSENT. "We deleted the rows last week" and "the
 * plan was upgraded in July" describe something already done, and a report is
 * not a proposal. The gate fires on what the operator's YES would cause, so
 * base, gerund and third-person are the forms that belong here.
 *
 * `class` is one of:
 *   money         — he is being asked to part with money
 *   plan          — an account or subscription level changes
 *   irreversible  — it cannot be taken back once he does it
 *
 * `needsProposal: true` marks a BARE NOUN — see PROPOSAL_CUES below.
 *
 * EVERY BARE NOUN CARRIES ITS PLURAL, for the same reason every verb carries
 * its three forms. Review round 5 (2026-08-29) put the plurals through the
 * shipped function and every one was SILENT while its singular fired:
 * "Approve the deletions", "the migrations tonight", "the key rotations",
 * "the invoices", "the payments", "the subscriptions". Those are ordinary
 * English spellings of acts that are MORE costly than the singular, not less,
 * and they posted with no evidence demanded at all. The completeness test
 * below names the pairs, because a test that only asserts each LISTED word
 * fires stays green while a form is missing — the same blind spot that let
 * `cost` through in round 2 and these six through rounds 2-4.
 */
const TRIGGERS = [
  // ---- money -------------------------------------------------------------
  { word: 'spend', class: 'money', why: 'the plainest form of the ask that started this: "spend money on X".' },
  { word: 'spending', class: 'money', why: 'the gerund form of the same ask — "spending on a paid plan".' },
  { word: 'spends', class: 'money', why: 'third person: "this spends the rest of the month\'s budget".' },
  { word: 'buy', class: 'money', why: 'a purchase is money out with no re-measurement in between.' },
  { word: 'buying', class: 'money', why: 'the gerund reads as an ask in progress — "buying the seat now".' },
  { word: 'buys', class: 'money', why: 'third person: "approving this buys another seat".' },
  { word: 'purchase', class: 'money', why: 'the noun and verb both read as an instruction to pay.' },
  { word: 'purchasing', class: 'money', why: 'the gerund — "purchasing the extra seat" — is the same ask.' },
  { word: 'purchases', class: 'money', why: 'third person, and the plural noun: "it purchases two more seats".' },
  { word: 'subscribe', class: 'money', why: 'a subscription is recurring money, so a wrong diagnosis keeps costing.' },
  { word: 'subscribing', class: 'money', why: 'the gerund — "subscribing would fix the limit" — is the same ask.' },
  { word: 'subscribes', class: 'money', why: 'third person: "this subscribes the workspace to the paid tier".' },
  { word: 'subscription', class: 'money', needsProposal: true, why: 'the noun names the recurring charge; it only proposes one when a cue governs it.' },
  { word: 'subscriptions', class: 'money', needsProposal: true, why: 'the plural of the same noun — "start the subscriptions" is the same recurring money.' },
  { word: 'pay', class: 'money', why: 'direct. Innocent uses ("pay attention") are stripped before matching.' },
  { word: 'paying', class: 'money', why: 'the gerund is how an ask is softened — "it means paying for the tier".' },
  { word: 'pays', class: 'money', why: 'third person: "this pays for a year up front". "Pays off" is stripped first.' },
  { word: 'payment', class: 'money', needsProposal: true, why: 'a payment to authorise is money leaving; a payment page is a screen.' },
  { word: 'payments', class: 'money', needsProposal: true, why: 'the plural — "approve the payments" is more money leaving, not less.' },
  { word: 'billing', class: 'money', needsProposal: true, why: 'a billing CHANGE is money wearing an administrative name; a billing page is not.' },
  { word: 'invoice', class: 'money', needsProposal: true, why: 'an invoice to approve is a bill to pay; an invoice screenshot is a picture.' },
  { word: 'invoices', class: 'money', needsProposal: true, why: 'the plural — "sign off on the invoices" is several bills to pay.' },
  { word: 'cost', class: 'money', why: 'the base form: "this will cost about thirty dollars a month". "Cost nothing" is stripped first.' },
  { word: 'costing', class: 'money', why: 'the gerund: "it would be costing us $30 a month from then on".' },
  { word: 'costs', class: 'money', why: 'the commonest third-person money sentence: "it costs $29 a month". "Costs nothing" is stripped first.' },

  // ---- plan / account level ---------------------------------------------
  { word: 'upgrade', class: 'plan', why: 'the exact word in the 2026-08-23 escalation. Upgrades cost money monthly.' },
  { word: 'upgrading', class: 'plan', why: 'the gerund is how the ask usually arrives — "upgrading would fix it".' },
  { word: 'upgrades', class: 'plan', why: 'third person: "approving this upgrades the workspace to Business".' },
  { word: 'downgrade', class: 'plan', why: 'the other direction is not free either — it can drop data or limits.' },
  { word: 'downgrading', class: 'plan', why: 'the gerund form of the same loss of data or limits.' },
  { word: 'downgrades', class: 'plan', why: 'third person, and the same loss of data or limits.' },
  { word: 'paid plan', class: 'plan', why: 'the literal phrase option A used, and it needs no verb: "put the workspace back on a paid plan". Bare "plan" is far too common to match.' },
  { word: 'plan change', class: 'plan', why: 'names the act directly, without saying which direction.' },

  // ---- irreversible ------------------------------------------------------
  { word: 'delete', class: 'irreversible', why: 'a deletion done on a wrong diagnosis cannot be undone by re-measuring.' },
  { word: 'deleting', class: 'irreversible', why: 'the gerund describes the act mid-proposal — "deleting the stale rows".' },
  { word: 'deletes', class: 'irreversible', why: 'third person: "this deletes all 550 untenanted rows".' },
  { word: 'deletion', class: 'irreversible', needsProposal: true, why: 'the administrative spelling — "approve the deletion" proposes one, "the deletion already happened" reports one.' },
  { word: 'deletions', class: 'irreversible', needsProposal: true, why: 'the plural — "approve the deletions" is more rows gone, and just as final.' },
  { word: 'rotate', class: 'irreversible', why: 'rotating a credential breaks every consumer of the old one at once.' },
  { word: 'rotating', class: 'irreversible', why: 'the gerund form — "rotating it will fix the 401" — is the same request.' },
  { word: 'rotates', class: 'irreversible', why: 'third person: "it rotates CHANNELS_ENCRYPTION_KEY".' },
  { word: 'rotation', class: 'irreversible', needsProposal: true, why: 'the noun form — "authorise the key rotation" proposes one, "the rotation is already done" does not.' },
  { word: 'rotations', class: 'irreversible', needsProposal: true, why: 'the plural — "authorise the key rotations" breaks every consumer of each old key.' },
  { word: 'revoke', class: 'irreversible', why: 'a revoked token cannot be un-revoked; it can only be re-minted.' },
  { word: 'revoking', class: 'irreversible', why: 'the gerund — "revoking the old key" — is the same act mid-proposal.' },
  { word: 'revokes', class: 'irreversible', why: 'third person: "this revokes the old publishable key".' },
  { word: 'migrate', class: 'irreversible', why: 'a database migration rewrites rows; the down path is rarely tested.' },
  { word: 'migrating', class: 'irreversible', why: 'the gerund — "migrating the pages tonight" — is the same act.' },
  { word: 'migrates', class: 'irreversible', why: 'third person: "this migrates every page to the new schema".' },
  { word: 'migration', class: 'irreversible', needsProposal: true, why: 'the noun — "run the migration" is an operator action; "the migration ran last month" is history.' },
  { word: 'migrations', class: 'irreversible', needsProposal: true, why: 'the plural — "run the migrations tonight" rewrites rows in more tables, not fewer.' },
  { word: 'force-push', class: 'irreversible', why: 'rewrites shared history; a standing deny rule in this repo already.' },
  { word: 'force push', class: 'irreversible', why: 'the same act, spelled without the hyphen.' },
  { word: 'wipe', class: 'irreversible', why: 'no partial wipe — it is all of it, and then it is gone.' },
  { word: 'wiping', class: 'irreversible', why: 'the gerund, and the same absence of a partial.' },
  { word: 'wipes', class: 'irreversible', why: 'third person, and the same absence of a partial.' },
  { word: 'purge', class: 'irreversible', why: 'as above, and usually applied to the backup as well.' },
  { word: 'purging', class: 'irreversible', why: 'the gerund — "purging the archive tonight".' },
  { word: 'purges', class: 'irreversible', why: 'third person: "it purges the archive too".' },
  { word: 'truncate', class: 'irreversible', why: 'empties a table with no row-level undo.' },
  { word: 'truncating', class: 'irreversible', why: 'the gerund — "truncating observe_usage_logs".' },
  { word: 'truncates', class: 'irreversible', why: 'third person: "this truncates observe_usage_logs".' },
];

/**
 * The cues that turn a bare NOUN into a proposal.
 *
 * WHY (review round 2, 2026-08-26). `billing`, `invoice`, `deletion`,
 * `rotation` and `migration` name a thing rather than propose an act, so they
 * fired on cards that asked for nothing at all:
 *
 *   "Nothing right now. The billing page renders correctly again."
 *   "Nothing needed — the deletion already happened last week."
 *   "Just confirm you saw the invoice screenshot."
 *
 * All three were REFUSED, which means the agent could not hand the ticket off
 * until it reworded a card that was already correct. AC3's reasoning applies
 * exactly: a gate that fires on everything gets bypassed, and then it protects
 * nothing.
 *
 * A verb needs no cue — proposing IS what a verb does here, which is why past
 * tense is left out of the list above. A noun fires only when one of these
 * cues appears in the SAME sentence, so "approve the deletion", "run the
 * migration" and "authorise the key rotation" all still fire.
 *
 * EVERY CUE CARRIES ALL THREE FORMS — base, gerund, third-person — for exactly
 * the reason the TRIGGERS list does, and it was found the same way. Review
 * round 3 (2026-08-26) put natural inflections through the shipped function
 * and every one of them was SILENT: "proceeding with the deletion of the 550
 * rows", "performing the key rotation on Tuesday", "this executes the
 * migration tonight", "this triggers the migration of every page", "kicking
 * off the migration at 9pm", "signing off on the invoice". Those are ordinary
 * English spellings of exactly the acts criterion 1 names, and they posted
 * with no evidence demanded at all. The completeness test below names the cue
 * families, because the old test only asserted that each LISTED cue fires —
 * which is green while a form is missing, the same blind spot that let the
 * `cost` hole through round 2.
 *
 * PAST TENSE IS ABSENT HERE TOO, and for a sharper reason than on the triggers:
 * adding it would REGRESS round 2's own fix. "Nothing needed — I ran the
 * migration last week" is a report, and a past-tense `ran` cue would refuse it,
 * which is the precise false-positive class that fix was made to close. So
 * "Started the subscription on the paid tier" stays silent by design; it
 * describes something already done, and the gate fires on what a YES would
 * cause.
 *
 * The accepted cost of the third-person forms, said out loud rather than
 * discovered later: a cue can also read descriptively, so "Nothing needed —
 * the migration runs nightly now" fires and has to be reworded. That is the
 * cheap direction. A reword costs one line; silence on a costly ask is the
 * incident at the top of this file.
 *
 * The known limit, stated rather than hidden: a bare noun phrase with no verb
 * at all ("The key rotation — yes or no?") does not fire. The verb forms are
 * the primary net; this list only rescues the noun spellings.
 */
const PROPOSAL_CUES = [
  { word: 'approve', why: 'the commonest way an operator ask is phrased: "approve the deletion".' },
  { word: 'approving', why: 'the gerund — "approving the rotation" — is the same request.' },
  { word: 'approves', why: 'third person: "this approves the deletion of all 550 rows".' },
  { word: 'authorise', why: 'the British spelling of the same act; both are in use here.' },
  { word: 'authorising', why: 'gerund, British spelling — "authorising the rotation".' },
  { word: 'authorises', why: 'third person, British spelling: "this authorises the deletion".' },
  { word: 'authorize', why: 'the American spelling of the same act.' },
  { word: 'authorizing', why: 'gerund, American spelling — "authorizing the rotation".' },
  { word: 'authorizes', why: 'third person, American spelling: "this authorizes the deletion".' },
  { word: 'run', why: '"run the migration" is the plainest instruction there is.' },
  { word: 'running', why: 'the gerund — "running the migration tonight".' },
  { word: 'runs', why: 'third person: "approving this runs the migration on every page".' },
  { word: 'start', why: '"start a subscription" proposes a recurring charge.' },
  { word: 'starting', why: 'the gerund form of the same proposal.' },
  { word: 'starts', why: 'third person: "this starts the subscription on the paid tier".' },
  { word: 'perform', why: 'the formal register — "perform the rotation".' },
  { word: 'performing', why: 'the gerund, and the form review found silent: "performing the key rotation on Tuesday".' },
  { word: 'performs', why: 'third person: "this performs the rotation across every consumer".' },
  { word: 'execute', why: 'the same as run, in the register a runbook uses.' },
  { word: 'executing', why: 'the gerund — "executing the migration against production".' },
  { word: 'executes', why: 'third person, and the form review found silent: "this executes the migration tonight".' },
  { word: 'trigger', why: '"trigger the migration" is how a scheduled job is asked for.' },
  { word: 'triggering', why: 'the gerund — "triggering the migration from the admin screen".' },
  { word: 'triggers', why: 'third person, and the form review found silent: "this triggers the migration of every page".' },
  { word: 'proceed', why: '"proceed with the deletion" is an approval with the verb moved.' },
  { word: 'proceeding', why: 'the gerund, and the form review found silent: "proceeding with the deletion of the 550 rows".' },
  { word: 'proceeds', why: 'third person: "this proceeds with the rotation on both keys".' },
  { word: 'go ahead', why: '"go ahead with the rotation" — the plainest English form of yes.' },
  { word: 'going ahead', why: 'the gerund — "going ahead with the deletion tonight".' },
  { word: 'goes ahead', why: 'third person: "this goes ahead with the migration".' },
  { word: 'sign off', why: '"sign off on the invoice" is an approval of a bill.' },
  { word: 'signing off', why: 'the gerund, and the form review found silent: "signing off on the invoice".' },
  { word: 'signs off', why: 'third person: "this signs off on the invoice for the month".' },
  { word: 'kick off', why: '"kick off the migration" — the same instruction, informally.' },
  { word: 'kicking off', why: 'the gerund, and the form review found silent: "kicking off the migration at 9pm".' },
  { word: 'kicks off', why: 'third person: "this kicks off the migration across every tenant".' },
];

/**
 * Phrases that contain a trigger word but ask for nothing costly. They are
 * removed from the text BEFORE matching, so "pay attention to the second
 * column" does not demand a command and its output.
 *
 * Keep this list short and obvious. It is an escape hatch, and a long escape
 * hatch is a hole: anything genuinely ambiguous should fire and be answered
 * with evidence, which costs one paste.
 */
const INNOCENT_PHRASES = [
  'pay attention',
  'pays attention',
  'paying attention',
  // "it pays off later" is a figure of speech, not a payment.
  //
  // THE BARE FORM IS DELIBERATELY NOT HERE, and it was here for one round.
  // Round 2 added it for symmetry with the other two, and round 3 found what
  // that cost: `pay off` also spells the literal sense, so "Pay off the
  // outstanding invoice." and "Pay off the balance on the card." went SILENT —
  // money asks of exactly the kind this file exists for, escaping through an
  // escape hatch. The list's own rule settles it: anything genuinely ambiguous
  // should fire and be answered with a paste. So "that will pay off later" now
  // fires and costs a reword, which is the cheap direction.
  'pays off',
  'paying off',
  // "costs" earns its place on "it costs $29 a month", but the same word is
  // how an agent says an option is free. Both spellings of that, in both the
  // base and third-person forms, and nothing more — anything genuinely
  // ambiguous should fire and be answered with a paste.
  'cost nothing',
  'cost you nothing',
  'costs nothing',
  'costs you nothing',
];

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * An innocent phrase, matched on whole-word boundaries so it is lifted out of
 * the text as a PHRASE and not as a run of characters.
 *
 * Raw substring removal was the shipped behaviour until review round 3
 * (2026-08-26) pointed out that "We can pay offshore contractors" loses
 * "pay off" out of the middle of a word, leaving "shore contractors" and
 * disarming the trigger. Contrived on its own, but the bounded matcher this
 * file already carries fixes the whole shape for free.
 */
function innocentPattern(phrase) {
  const body = String(phrase).trim().split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(`\\b${body}\\b`, 'gi');
}

/**
 * A whole-word, whitespace-flexible matcher for one trigger. Multi-word
 * triggers ("paid plan") tolerate a line break between the words, because a
 * card wrapped by an editor should read the same as one that was not.
 *
 * PLAIN `\b` BOUNDARIES, and that is load-bearing. The first version bounded
 * each word with "not a word character or hyphen", on the reasoning that `\b`
 * would not fire next to a hyphen. That reasoning was wrong — `/\bdelete\b/`
 * matches "hard-delete" perfectly well, and `/\bforce-push\b/` matches too —
 * so the custom boundary only ever REMOVED matches. Review (round 2,
 * 2026-08-26) found "hard-delete", "force-delete", "auto-purge" and
 * "key re-rotation" posting with no evidence demanded at all: not
 * refused-and-reworded, never checked. Those are ordinary English spellings of
 * exactly the irreversible acts this gate exists for.
 */
function triggerPattern(word) {
  const body = String(word).trim().split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(`\\b${body}\\b`, 'i');
}

/** Does this sentence propose an act, rather than mention a thing? */
function proposesAction(sentence) {
  return PROPOSAL_CUES.some((cue) => triggerPattern(cue.word).test(sentence));
}

/**
 * Sentences, split the way a card is actually written: full stops, question
 * and exclamation marks, semicolons and line breaks. The semicolon matters —
 * "Nothing right now; the rotation is already done" is two clauses, and only
 * the first one is the ask.
 */
function sentences(text) {
  return String(text || '').split(/[.!?;\n]+/);
}

/**
 * Which triggers does this ask contain? Returns the matched trigger entries,
 * in list order, deduplicated by word. An empty array means an ordinary ask.
 */
function costlyTriggers(text) {
  let haystack = String(text || '').toLowerCase();
  for (const phrase of INNOCENT_PHRASES) {
    haystack = haystack.replace(innocentPattern(phrase), ' ');
  }
  const clauses = sentences(haystack);
  const matches = TRIGGERS.filter((trigger) => {
    const pattern = triggerPattern(trigger.word);
    if (!trigger.needsProposal) return pattern.test(haystack);
    // A bare noun fires only where a cue in the SAME sentence proposes it.
    return clauses.some((clause) => pattern.test(clause) && proposesAction(clause));
  });
  // A bare dollar amount is a money ask however it is phrased — "$25/month",
  // "$0.02 a call". It has no word form to list, so it is matched separately.
  //
  // IT IS DELIBERATELY NOT `needsProposal`, and the cost of that is real. Review
  // round 3 (2026-08-26) pointed out that "Nothing right now. The Vercel bill
  // came to $30 last month." is refused — the same false-positive class the
  // bare NOUNS were given cues for, and a live collision with the weekly-report
  // ticket, which will put figures in cards that ask for nothing.
  //
  // It stays because the trade runs the other way here. A noun has verb forms
  // covering it; a figure has nothing else, and a figure with no verb and no
  // cue is a real ask — "It comes to $4.50 a day at current volume, your call",
  // "$29/month for Business or $49 for the tier above?" — which a cue rule
  // would silence. A false refusal costs a reword; silence on a money ask is
  // the incident at the top of this file. Whether that balance is right is a
  // product question about how much natural language a keyword gate should
  // chase, and it is the operator's to settle, not this module's to guess at.
  if (/\$\s?\d/.test(haystack)) {
    matches.unshift({ word: '$ amount', class: 'money', why: 'a figure in dollars is a money ask whatever words surround it.' });
  }
  return matches;
}

/** True when this ask costs money or cannot be undone. */
function isCostlyAsk(text) {
  return costlyTriggers(text).length > 0;
}

/** "spend, upgrade (money, plan)" — for naming the reason in a refusal. */
function describeTriggers(triggers) {
  const words = triggers.map((t) => t.word);
  const classes = [...new Set(triggers.map((t) => t.class))];
  return `${words.join(', ')} (${classes.join(', ')})`;
}

module.exports = {
  TRIGGERS,
  PROPOSAL_CUES,
  INNOCENT_PHRASES,
  triggerPattern,
  innocentPattern,
  proposesAction,
  costlyTriggers,
  isCostlyAsk,
  describeTriggers,
};
