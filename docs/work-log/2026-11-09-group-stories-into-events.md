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
