## 2026-11-09 — Write a neutral fact sheet for each news event from all its sources, using Claude, capped at $50 a month (#9)

This is the last of the three steps Dane approved. The first step stored each
story's full text privately (#6). The second grouped stories from different
outlets into one news event (#8). Now Claude, Anthropic's AI, reads the full
text of every outlet covering an event and writes one neutral fact sheet: a
list of facts, each naming the outlets that report it, plus a list of the
places where the outlets disagree. It gives no opinions and uses no loaded
wording. Sheets are kept in a private table the public website cannot read,
ready for drafting games later.

Before writing, Claude checks the grouping, which is what Dane chose on PP-4.
The word rule sometimes groups two different stories, such as one leader
doing two different things. Claude names any story that doesn't belong. That
story is moved into a group of its own and marked as moved by the check, so
ingestion never puts it back. The sheet is written from the stories that are
left.

Spending is capped at $50 a month. Before each call, the most it could
possibly cost is written into a private spending table. The month's total is
then read back with that entry included, and if it would pass $50, the call
is not made and the step says so. When Claude answers, the entry is replaced
by the real cost. If a call never reports back, its worst-case entry stays,
so the total can come out too high but never too low. An event goes to Claude
again only when new stories join it, so nothing is paid for twice. A sheet
should cost about ten cents.

Nothing will run yet, for two reasons. No outlet has full text switched on,
and the Anthropic key isn't set. Without the key, the step reports "not run"
rather than failing quietly. Nineteen new automatic tests use a stand-in for
Claude to cover the sheet, the split, the cap, bad answers, failed steps, and
a check that article text never shows up in a log.

**Fixes after review.** The reviewer found ways the step could waste the
budget, and these are now closed. A slow answer could time out and then be
retried every 20 minutes forever, paying each time with nothing to show. Now
Claude's reply is streamed, piece by piece, so a long answer is not cut off.
A call that still gets no answer is tried at most twice for the same stories.
Each run also stops starting new calls once a whole call would no longer fit
in Vercel's time limit, so a run is never killed mid-call. When an outlet's
stored text expires after 30 days, the event is no longer sent again, and a
fuller fact sheet is never replaced by a thinner one. Stories that belong
together but not with the event are now moved out together, so they can get
a sheet of their own. A too-large event no longer takes a run's slot. The
address also refuses to run without its password, because it spends money.
Twenty-six automatic tests now cover the step, seven more than before.
