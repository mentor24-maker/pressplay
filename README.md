# PressPlay Today — Phase One starter

> Where the News Becomes a Game · pressplay.today

A working Next.js + Supabase foundation for Phase One: real RSS ingestion,
attention-ranked story storage, a branded homepage, and the database schema for
games, plays, streaks, and predictions.

For a plain-English tour of everything built so far, read [docs/OVERVIEW.md](docs/OVERVIEW.md).

## What's here

```
data/feeds.json                  Your feed list (edit freely)
src/lib/ingest.js                RSS fetch → clean → score → upsert (headline+snippet+link ONLY)
src/lib/supabaseAdmin.js         Server-side Supabase client
scripts/ingest.mjs               CLI: npm run ingest | ingest:dry | ingest:local
scripts/sample/sample-feed.xml   Offline test fixture
src/app/page.jsx                 Homepage: top 20 stories by attention
src/app/api/cron/ingest/route.js Vercel Cron endpoint (every 20 min)
supabase/schema.sql              stories, games, profiles, plays, predictions + RLS
vercel.json                      Cron schedule
```

## Quick start

```bash
npm install
npm run ingest:local     # offline smoke test — parses the sample fixture
npm run ingest:dry       # fetches your real feeds, prints top stories, writes nothing
```

Then connect the database:

1. Create a free project at supabase.com → run `supabase/schema.sql` in the SQL editor.
2. `cp .env.example .env.local` and fill in the three Supabase keys.
3. `npm run ingest` — your first stories land in the `stories` table.
4. `npm run dev` — open http://localhost:3000 to see them ranked by attention.

## Deploy

Push to GitHub → import into Vercel → add the env vars → done. `vercel.json`
schedules ingestion every 20 minutes automatically (set `CRON_SECRET`).

## How ingestion works

For each feed: fetch → parse → **keep only headline, ≤280-char snippet, source
name, timestamp, and link** → drop items older than 48h → compute an attention
score (v1: recency decay, half-life ~8h) → upsert on `guid` so re-runs never
duplicate. Feed failures are per-feed and non-fatal.

**Copyright posture (do not weaken):** never display or publish full article
text or images: the site, the public API and games shown to players carry only
headline, snippet, facts, attribution and the link out. Full article text is
stored **privately** (the `story_bodies` table, server-only, kept 30 days) and
only for outlets that have said yes: each feed's `fullCopy.allowed` in
`data/feeds.json`, off by default. Never get around a paywall, a login or
robots.txt. Verify each publisher's RSS terms before production use; replace
or remove any feed on request.

## Attention score v2 ideas

Recency is a placeholder. Real "viral" ranking should blend: the same story
appearing across multiple feeds (bigger story), social share velocity, search
trends, and your own click-through data.

## Next build steps (in order)

1. **Editorial queue** — an `/admin` page listing today's top stories; editor
   picks Today's Five.
2. **AI game drafting** — send the chosen story's headline+snippet+source link
   to an LLM to draft quiz questions into `games` (status `draft`).
3. **Approval → publish** — editor reviews, edits, and flips status to
   `published`. Nothing ships without a human.
4. **Play UI** — quiz component with streaks, points, and the shareable
   ▶▶▷▶▶ result card (see the HTML prototypes for the exact design).
5. **Auth** — Supabase email/magic-link sign-in wired to `profiles`.

The clickable prototypes in `prototypes/` (`pressplay-homepage.html`,
`pressplay-directory.html`, `pressplay-story.html`) are the design spec for
steps 4–5. Open them straight in a browser — they have no build step.

Business and strategy documents live in `docs/`.
