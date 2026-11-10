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
