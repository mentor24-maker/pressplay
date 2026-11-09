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
