## 2026-11-08 — Write an overview of the application in it's current state (#5)

PressPlay now has a single plain-English document, `docs/OVERVIEW.md`, that
explains what the app actually does today: how it collects headlines from ten
news sites and ranks them by freshness, what the database is set up to hold,
what the homepage shows in each situation, what the design mockups are, and
the copyright rule it keeps. It ends with an honest list of what is not built
yet: the games themselves, the editor's screen, sign-in and more.

Every statement was checked against the code, not copied from the README.
That turned up a few things worth knowing. The database has six tables, not
five. The offline test, `npm run ingest:local`, now finds no stories because
its sample news is too old. These are written down in the overview as
observations, not fixed, so each can become its own ticket.
