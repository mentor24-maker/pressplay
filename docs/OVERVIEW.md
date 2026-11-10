# PressPlay Today: what is built so far

*Written 8 November 2026, checked line by line against the code on `main` at
that date. Updated 9 November 2026 for the private full-copy store (PP-3). If the code changes, this document can go out of date; the code is
always the final word.*

PressPlay Today ("Where the News Becomes a Game") is meant to turn the day's
biggest news stories into short games people play every day. **None of the
games exist yet.** What exists is the foundation underneath them:

1. a **news pipeline** that collects headlines from ten news sites and ranks them,
2. a **database** ready to hold stories, games, players and their scores,
3. a one-page **website** that lists the top-ranked stories,
4. three **design mockups** showing what the finished product should look like, and
5. the **work loop** that builds and checks every change.

Each is described below, then a closing list of what is not built yet.

---

## 1. The news pipeline: collecting and ranking stories

### Where the stories come from

Most news sites publish an **RSS feed**: a machine-readable list of their
latest headlines, each with a short summary, a date and a link. PressPlay
reads those feeds instead of the websites themselves.

The list of feeds lives in one file, `data/feeds.json`. It holds **10 feeds**
today, each tagged with a **category** (a short code such as `top` or `tec`):

| Feed | Category |
|---|---|
| NPR Top Stories | Top Story |
| BBC News | Top Story |
| NYT Home Page | Top Story |
| MarketWatch Top | Business |
| The Verge | Technology |
| Ars Technica | Technology |
| ESPN News | Sports |
| Variety | Entertainment |
| ScienceDaily | Science |
| The Denver Post | Local |

Nine categories are defined (Top Story, Politics, Business, Technology,
Sports, Entertainment, Science, Local, Strange but True); Politics and Strange
but True have no feed yet. Adding or removing a feed is just an edit to that
file. The file itself carries a reminder to check each publisher's RSS terms
of use before going live.

### What happens to each story ("ingestion")

**Ingestion** means fetching the feeds and storing what they contain. The
logic is in `src/lib/ingest.js`. For every feed, at the same time:

1. **Fetch** the feed (giving up on a feed after 15 seconds).
2. **Clean** each item: strip out web formatting so only plain text is left.
3. **Skip** an item that has no headline or no link, or whose date is
   unreadable.
4. **Drop anything older than 48 hours.**
5. **Keep only five things in public**: the headline, a snippet of at most
   280 characters (cut at a word, ending in "…"), the source's name, the
   publication time, and the link. Plus the feed's category. (Full article
   text, only for outlets that allow it, goes somewhere private: see
   "Full copy, kept private" below.)
6. **Score it.** Each story gets an **attention score** from 0 to 100. Today
   this is purely about freshness: a brand-new story scores 100 and the score
   halves roughly every 8.3 hours (about 37 at 12 hours old, about 2 at 48).
   The code notes this is a placeholder; ideas for a smarter score (the same
   story appearing in several feeds, social sharing, search trends, what
   readers click) are listed in the README but not built.
7. **Save it** to the `stories` table in the database. Each story is
   identified by the feed's own ID for it (or its link, if the feed gives
   none), so running ingestion again **updates** a story already saved
   (refreshing its score) instead of saving a second copy. This
   save-or-update is called an **upsert**.

If one feed fails (site down, bad data), the others carry on; the failure is
reported as a "non-fatal" error rather than stopping the run.

### Full copy, kept private

Since PP-3 (9 November 2026), PressPlay can also keep the **full text** of a
story, to build neutral fact lists from all sources later. It is never shown
anywhere. The rules, in `src/lib/fullCopy.js`:

- **Only for outlets that said yes.** Each feed in `data/feeds.json` has a
  `fullCopy` setting. `allowed` is **off** for all ten feeds today; it is
  turned on for an outlet once that outlet agrees.
- **Two ways to get it**, chosen per feed by `method`: `"feed"` reads the full
  text the feed itself carries in its `content:encoded` field (some publishers
  offer a full-text feed; the ordinary description is a teaser and is never
  used); `"page"` opens the article page and keeps its paragraphs, but only if
  the site's **robots.txt** (a file where a site says which pages automatic
  readers may open) allows our reader. Per feed per run, at most 15 pages are
  stored and at most 25 page requests are sent, so links that keep failing
  cannot block the stories behind them. Feeds fetch side by side, and each
  feed's text is saved as soon as that feed is done. There is no time limit on
  the run as a whole yet, so a run cut off by the scheduled run's 60-second
  limit loses the text of any feed it was still fetching.
  If robots.txt cannot be read, the page is not opened. No paywall or login is
  ever got around.
- **Stored privately** in the `story_bodies` table (below), never in the
  public `stories` table. Text shorter than 200 characters is a teaser, not
  the article, and is not stored.
- **Never in a log.** Errors name the feed and the link, never the text; the
  run reports only counts ("Full copy: off for all 10 feeds").
- **Kept 30 days**, then deleted on the next run.
- **Not safe to switch on yet.** The PP-3 review (9 November 2026) found
  these must be fixed before any outlet's `allowed` is turned on:
  - one time limit for the whole run, with text saved in batches as it
    arrives, so a cut-off run keeps what it fetched;
  - robots.txt matching our reader's name on the part before the "/", so a
    site that writes `PressPlayToday/0.1` gets the rules it wrote for us;
  - keeping the article itself, not the first `<article>` on the page (often
    a related-story card), since stored text is kept for good;
  - a limit on the size and type of a downloaded page, and closing a page we
    stop reading after a redirect or an error;
  - one shared page cap when two feeds come from the same outlet;
  - not trying failed or teaser links again, and logging them, on every run.

A dry run never opens an article page and stores nothing.

### Three ways to run it by hand

The command-line tool is `scripts/ingest.mjs`, run through these three
shortcuts:

| Command | What it does |
|---|---|
| `npm run ingest` | Fetches all 10 feeds and saves the results to the database. If the database settings are missing, it says so and falls back to a dry run. |
| `npm run ingest:dry` | Fetches all 10 feeds, prints the top 10 by attention score, **writes nothing**. |
| `npm run ingest:local` | Needs no internet: reads a sample feed file kept in the repository (`scripts/sample/sample-feed.xml`) and prints what it found. Writes nothing. |

All three read the settings file `.env.local` if one exists (see section 5).

### The automatic run every 20 minutes

The site is hosted on **Vercel**, a service that runs websites, and Vercel can
call a web address on a timer (a **cron job**). `vercel.json` tells it to call
`/api/cron/ingest` every 20 minutes. That address is handled by
`src/app/api/cron/ingest/route.js`, which runs exactly the same ingestion as
`npm run ingest` and replies with how many stories it fetched, how many it
saved, and any feed errors.

To stop strangers triggering it, the address checks a password,
`CRON_SECRET`, which Vercel sends automatically.

---

## 2. The database

The database runs on **Supabase**, a hosted service that provides a
**Postgres** database (an industry-standard database) plus user sign-in.
Its whole design is in one file, `supabase/schema.sql`, which is run once in
Supabase's editor to create the **tables** (think: spreadsheets with fixed
columns).

| Table | What it is for | Used by anything today? |
|---|---|---|
| `stories` | One row per news story: headline, link, source, category, snippet, publication time, attention score. | **Yes.** Ingestion writes it; the homepage reads it. |
| `games` | A game built from a story: its type (quiz, prediction, poll or satire), its questions and answers, and a status: draft, approved, published or retired. Designed so the AI drafts and a human approves; it records who approved it. | No. |
| `profiles` | One row per signed-in player: a handle (public name), total points, current streak, last day played. | No. |
| `plays` | One row each time a player plays a game: their answer, whether it was right, the points earned. A player can play each game only once. | No. |
| `predictions` | "What happens next?" questions tied to a story, with the options, when it resolves, and (later) the outcome. | No. |
| `prediction_picks` | Each player's pick on a prediction, and the points awarded. One pick per player per prediction. | No. |
| `story_bodies` | **Private.** The full text of a story, from outlets that allow it: how it was fetched (`feed` or `page`), the outlet, and when. Deleted after 30 days, and with its story. | Written by ingestion only for feeds with full copy on (none yet). |
| `events` | **Private.** One row per news event: stories from different outlets about the same thing share one event, so one fact sheet can be written per event. Its key is the first story's guid. | **Yes.** Ingestion writes it every run (`src/lib/events.js`). |
| `story_events` | **Private.** Which event each story belongs to, one row per story. Deleted with its story. | **Yes.** Ingestion writes it every run. |

(The ticket for this overview listed five tables; the schema had six, with
`prediction_picks` the sixth. `story_bodies` made seven on 9 November 2026; `events` and `story_events`
made nine the same day.)

**Row Level Security** (database rules about who may read or change which
rows) is switched on for every table: anyone may read stories, published
games and predictions; a player may see and update their own profile, and
see and add their own plays and picks. `story_bodies`, `events` and
`story_events` have **no** rule letting
anyone read it, and the public and signed-in keys are refused access to it
outright, so only the server can read full copy or the event groups. The server's own master key
(below) skips these rules, which is how ingestion writes stories.

---

## 3. The website

The website is built with **Next.js**, a framework (a ready-made structure)
for building websites with **React**, a popular tool for building web pages.
Today it has **one page**, the homepage, in `src/app/page.jsx`, wrapped by
`src/app/layout.jsx`, which adds the top bar with the "PressPlay Today" name
and sets the browser-tab title. The colours (navy, royal blue, teal) are the
brand colours from the strategy document.

What the homepage shows depends on the database:

- **Database settings missing:** an "Almost there." page with three setup
  steps (create the Supabase project and run the schema, fill in the settings
  file, run `npm run ingest`).
- **Database reachable but the read fails** (wrong project, schema not run,
  bad key): a "Can't read the stories table." page that shows the database's
  web address (not a secret), the actual error message, and three things to
  check. This was added in an earlier fix so a broken connection no longer
  looks like an empty list.
- **Working, but no stories yet:** the heading, plus a note that the
  `stories` table is empty and to run `npm run ingest` (and that the
  connection itself is fine).
- **Working, with stories:** "Today's most viral stories, curated." and the
  **top 20 stories by attention score**. Each card shows the category, the
  attention score, the source, the publication time, the headline, the
  snippet, and a "Read the original →" link that opens the publisher's page
  in a new tab.

The page is rebuilt at most every **5 minutes**, so a new ingestion run can
take up to five minutes to appear.

There is nothing to sign into, no game, and no other page.

---

## 4. The design mockups (`prototypes/`)

Three self-contained web pages, opened straight in a browser with no setup:

| File | What it shows |
|---|---|
| `prototypes/pressplay-homepage.html` | The intended homepage: the headline banner, "Today's Five" stories, a playable five-question daily quiz with a score and shareable result, a "What happens next?" prediction, and a pitch to publishers. |
| `prototypes/pressplay-directory.html` | A directory of the day's most viral stories, each one playable. |
| `prototypes/pressplay-story.html` | A single story's page (a sample city-council transit story) with its quiz, a prediction, and related stories to play. |

They are **clickable mockups only**. Their stories and questions are made up
and written into the files; they do not read the database or talk to the real
app in any way. They are the design target for the game and sign-in work.

---

## 5. Tech stack and setup

| Piece | Role |
|---|---|
| **Next.js 16** with **React 19** | The website and its server-side code (the homepage and the cron address). |
| **Supabase** | The database (and, later, player sign-in). |
| **Vercel** | Hosting, plus the 20-minute cron job. |
| `rss-parser` | A small ready-made **package** (code library) that reads RSS feeds. |
| **Node.js** | Runs the command-line tools. |

All of these are listed in `package.json`.

### Settings (environment variables)

Settings that differ per computer, including passwords, are kept out of the
code in **environment variables**. `.env.example` lists them with placeholder
values; a real copy, `.env.local`, is never committed (the repository is
public). The four names:

| Name | What it is |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | The database's web address. Not secret. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase's public "visitor" key, meant for code running in a visitor's browser. |
| `SUPABASE_SERVICE_ROLE_KEY` | The database's **master key**: server only, never shown to a browser. `src/lib/supabaseAdmin.js` uses it to connect. |
| `CRON_SECRET` | The password the 20-minute cron job sends. |

`.env.example` also warns against putting a comment on the same line as a
value: Vercel's settings screen keeps the comment as part of the value, which
once broke the master key.

### The "done" check

`npm run build` builds the whole site and fails if anything is broken.
`npm run verify` runs that build, then the app's own tests (`npm run
test:app`, the `*.test.mjs` files in `src/`), then the work loop's own tests; it is the
check GitHub runs on every pull request (a **pull request** is a proposed
change, reviewed before it joins `main`, the live copy of the code).

---

## 6. The copyright rule

The rule changed on 9 November 2026 (PP-3), on Dane's decision, because
PressPlay is being built for the news outlets that own the stories.

- **Published** (the site, the public API, games shown to players): **only
  the headline, a short snippet (at most 280 characters), the facts, the
  source's name, the publication time, and a link to the original.** Never
  the full article and never images. Every story is credited and links out to
  its publisher.
- **Stored privately:** full article text, only from outlets that have said
  yes, in the server-only `story_bodies` table, for 30 days (see "Full copy,
  kept private" in section 1).

Games are to be built from facts in the story, always credited and linked.
The rule is written in four places: the database design
(`supabase/schema.sql`) states it in its opening comment, and three carry a
warning marker, the README ("do not weaken"), the ingestion code
(`src/lib/ingest.js`, "do not change casually") and the full-copy code
(`src/lib/fullCopy.js`, "do not weaken casually"). The README adds: check
each publisher's RSS terms before going live, and remove any feed a publisher
asks to be removed.

---

## 7. The work loop

Changes to PressPlay are made through a ticket system (the **tracker**,
running on the Mac Mini) and a spec, build and review loop of agent sessions,
with Dane approving every merge. The `loop/` folder is that loop's ticket
tooling, copied from Spirality and never edited here. How it all works is in
`docs/LOOP_ENGINEERING.md`.

---

## Observations (found while checking, not fixed)

These are notes, not changes; each would be its own ticket.

- **The offline test now finds nothing.** `npm run ingest:local` printed
  "Parsed 0 stories from local fixture" on 8 November 2026. The sample feed's
  dates are from late July 2026, so the 48-hour cutoff drops every item. The
  sample needs fresh dates (or dates set relative to "now") to be useful.
- **The cron address is open if `CRON_SECRET` is not set.** The password
  check only runs when that setting exists. Anyone could then trigger
  ingestion (harmless in effect, but it costs fetches).
- **The public "visitor" key is not used yet.** No code reads
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`; the homepage reads stories with the server's
  master key. It will matter once pages run in the visitor's browser.
- **Old stories are never removed and their scores freeze.** Once a story is
  older than 48 hours, ingestion stops updating it, so it keeps its last score
  (about 2) and stays in the table indefinitely. It sinks below fresh stories,
  so the homepage is unaffected for now.

---

## Not built yet

Everything below is planned in the README and the business documents in
`docs/`. **None of it has been started.**

1. **Editorial queue**: an admin page listing today's top stories, where an
   editor picks "Today's Five".
2. **AI game drafting**: sending a chosen story's headline, snippet and link to
   an AI model to draft quiz questions, saved as drafts in the `games` table.
3. **Approval and publishing**: an editor reviews and edits the draft, then
   publishes it. Nothing goes live without a person approving it.
4. **The play screen**: the quiz itself, with streaks, points and the
   shareable result card shown in the mockups.
5. **Sign-in**: email or magic-link sign-in through Supabase, connected to
   the `profiles` table.

Also named in the Phase One plan (`docs/PressPlay-Strategy-and-Phase-One-Plan.docx`)
and not started: the daily "What happens next?" prediction, a newsletter
signup, topic filters, a trend signal for spotting fast-rising stories, and
analytics (measuring visits, completions, shares and clicks through to the
original articles).
