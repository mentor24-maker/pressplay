## 2026-11-09 — Store the full copy of each story privately and build a neutral fact sheet per story from all sources (#6)

PressPlay can now keep the full text of a news story, privately, ready for
the neutral fact lists that come next. This is the first of three steps Dane
approved: this one builds the safe store; the next groups stories about the
same event (PP-4); the last has Claude write the fact sheet (PP-5).

Full text goes in its own locked table that only the server can open: the
public website key is refused access to it. Each news outlet has an on/off
switch, and every switch starts off, so nothing changes until an outlet says
yes. When a switch is on, the text comes either from the outlet's own
full-text feed or from the article page, and the page is only opened if the
site's rules for automatic readers allow it. The text never appears in a log,
and it is deleted after 30 days.

The written copyright rule was updated everywhere it appears: full copy may be
stored privately from outlets that agree, and only headlines, short snippets,
facts and the link back are ever published. Sixteen new automatic tests check
these rules on every change.
