## 2026-11-09 — Group stories from different outlets that are about the same news event, so each event can get one fact sheet (#8)

PressPlay can now tell when several news outlets are reporting the same event,
and groups their stories together. This is the second of the three steps Dane
approved: the first stored each story's full text privately (#6); this one
works out which stories belong together; the last (PP-5) will have Claude
write one neutral fact sheet per event from all its sources.

The grouping uses a plain rule, not AI, so it can be read and tested. Two
stories count as the same event when they came out within two days of each
other, their headlines share at least two meaningful words, and at least one
of those words is a name, such as a person, place or company. Everyday words
like "says", "linked" or "risk" are not enough on their own.

On today's live news it grouped 12 real events, for example Russell Brand's
sentencing as reported by the New York Times, NPR and the BBC. A first try had
wrongly joined two different Alzheimer's studies and two sports polls; the
"must share a name" part fixed that, and those cases are now permanent tests.
It still split one big Nvidia story into two groups. Missing a match like that
is the safer mistake, and the rule can be tuned later.

The groups live in two new private tables that the public website key cannot
open, just like the full text. Running ingestion again never makes duplicate
groups: a story keeps its group once it has one. Fourteen new automatic tests
check all of this.

**Second round, after review.** Review found two ways different events could
still end up in one group. First, a big institution counted as the shared
name: "Supreme Court hears arguments in abortion pill case" and "... in gun
rights case" were grouped, and so were "Stock Market Falls Sharply" and
"Stock Market Rises Sharply". Now an institution like the Supreme Court, the
White House or the stock market only counts when the headlines also share
three words about what actually happened (the border wall ruling still
groups). A headline Written In Title Case no longer turns ordinary words into
"names" either. Second, chaining: a story could join a group by matching
just one member, so a string of near matches could pull together stories
that share nothing. Now a story has to match at least half of a group to join
it. Both review cases and a chaining case are now permanent tests, and the
same 12 real groups still form on today's live news.

**Third round, after review.** Review found the real cause behind the first
round's cases: a name that is in the news every day (Trump, Musk, Apple) says
*who*, not *what happened*, just like "Supreme Court" did. "Trump signs
executive order on tariffs" and "... on immigration" were grouped, and so were
two Senate bills and two new Apple products. Instead of adding words to a list
one at a time, the rule now spots the pattern itself. When two headlines are
mostly the same words in the same order and each has swapped in a word of its
own ("tariffs" / "immigration", "defense" / "farm"), that swapped word is what
happened, so they are different events. Outlets covering one event in their own
words rarely line up that closely. The one exception is when the headlines
share two different names (France and Iran, Nvidia and Jensen Huang). That pins
down the event twice over, so a swap there is only wording ("hacking" / "cyber
attacks"). A full name like "Donald Trump" counts as one name, not two. Swapping
opposites ("buys" / "sells", "rises" / "falls") always means different events.

The cost, stated plainly: on today's news, 11 of the 12 real groups still form.
The two Lindsay Clancy court stories ("motion to dismiss" / "request to throw
out") are now kept apart, because a plain rule cannot tell that swap from
"tariffs" / "immigration". Missing a match means a second fact sheet. A wrong
match is permanent and would mix two different stories into one fact sheet, so
missing is the safer mistake. The five review cases and six more of the same
shape are now permanent tests.

**Fourth round, Dane's decision.** Review found more different events that
still group: a leader and their own country ("Putin says Russia will respond
to sanctions" / "Putin says Russia will host Xi"), or a CEO and their company.
It measured today's news and showed that no word-counting rule can keep these
apart without also splitting real groups. So it asked Dane, and he chose
option A: keep the word rule as a quick first sort, and let the AI in the next
step (PP-5) check each group before writing its fact sheet, splitting off any
story that does not belong.

For that, a story's group can now be changed after the fact. A new function,
`moveStory`, moves a story into another group, or splits it into a group of its
own. It checks that nothing else moved the story first, and reads the change
back, so it never overwrites someone else's move. Each story's link now also
records who placed it: the word rule, or the check. Ingestion never re-sorts a
story that already has a group, so a story the check moved stays moved. Three
new tests cover a split, a move into another group, and every way a move can
fail, and the database file was run in a throwaway Postgres to confirm the new
column and the guarded move work there.

