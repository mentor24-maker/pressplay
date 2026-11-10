-- PressPlay Today — Phase One schema
-- Run in the Supabase SQL editor. Every statement is safe to run again.
-- Copyright posture (since PP-3, 2026-11-09): the PUBLIC `stories` table holds
-- ONLY headline, snippet, attribution, timestamp, and link. Never full text.
-- Full text from outlets that have said yes lives ONLY in the private
-- `story_bodies` table below, for 30 days, readable by the service role alone.

create table if not exists stories (
  id            bigint generated always as identity primary key,
  guid          text not null unique,          -- upsert key from the feed
  title         text not null,
  url           text not null,
  source        text not null,                 -- attribution, always shown
  category      text not null default 'top',   -- top|pol|biz|tec|spt|ent|sci|loc|str
  snippet       text not null default '',
  published_at  timestamptz not null,
  attention     int  not null default 0,       -- 0–100, refreshed each ingest
  created_at    timestamptz not null default now()
);
create index if not exists stories_attention_idx on stories (attention desc, published_at desc);
create index if not exists stories_category_idx  on stories (category, published_at desc);

-- Full copy, PRIVATE. One row per story, only for feeds whose
-- data/feeds.json entry says fullCopy.allowed = true. Never shown on the site.
-- Ingestion deletes rows older than 30 days on every run.
create table if not exists story_bodies (
  story_guid  text primary key references stories(guid) on delete cascade,
  body        text not null,                   -- full article text; NEVER public
  method      text not null check (method in ('feed','page')),
  source      text not null,
  fetched_at  timestamptz not null default now()
);
create index if not exists story_bodies_fetched_idx on story_bodies (fetched_at);

-- Events, PRIVATE (PP-4). Stories from different outlets about the same news
-- event share one event, so the next step can write one fact sheet per event
-- from all its sources. Grouping is a plain word-matching rule run by the
-- ingester (src/lib/events.js). An event's key is the guid of the story that
-- started it, and a story keeps its event once linked, so re-running
-- ingestion never duplicates either table. The rule is a first pass: the
-- fact-sheet step (PP-5) checks each event and can move a story to another
-- event or split it off (moveStory). Never shown on the site.
create table if not exists events (
  id                  bigint generated always as identity primary key,
  key                 text not null unique,     -- guid of the story that started the event ('split:<guid>' for one split off later)
  first_published_at  timestamptz not null,
  created_at          timestamptz not null default now()
);

-- Each story's event: one row per story, kept apart from the public
-- `stories` table so the link stays private too.
create table if not exists story_events (
  story_guid  text primary key references stories(guid) on delete cascade,
  event_key   text not null references events(key) on delete cascade,
  -- who placed it: 'rule' = ingestion's word rule; 'check' = moved later by
  -- the fact-sheet step's check (moveStory), which ingestion never undoes
  linked_by   text not null default 'rule' check (linked_by in ('rule','check')),
  linked_at   timestamptz not null default now()
);
create index if not exists story_events_event_idx on story_events (event_key);

-- Fact sheets, PRIVATE (PP-5). One per event, written by Claude from the full
-- copy (story_bodies) of every outlet in the event (src/lib/factSheets.js):
-- neutral facts, each naming the outlets that report it, and the points where
-- outlets disagree. The input for drafting games. Never shown on the site.
create table if not exists fact_sheets (
  event_key      text primary key references events(key) on delete cascade,
  event          text  not null,               -- one neutral sentence: what happened
  facts          jsonb not null,               -- [{fact, sources: [{source, guid}]}]
  disagreements  jsonb not null default '[]',  -- [{about, accounts: [{claim, sources: [{source, guid}]}]}]
  story_guids    text[] not null,              -- the stories it was written from
  sources        text[] not null,              -- their outlets
  story_set      text  not null,               -- fingerprint of story_guids, to tell when the event has changed
  model          text  not null,
  cost_usd       numeric(10,6) not null default 0,
  written_at     timestamptz not null default now()
);

-- AI spending, PRIVATE (PP-5). Every call to Claude is booked here BEFORE it
-- is made, at its worst possible cost (reserved_usd); when the reply comes
-- back, cost_usd holds what it really cost. A month's spend is each row's
-- cost_usd, or its reserved_usd while cost_usd is empty. The fact-sheet step
-- stops when that passes $10 for the month (UTC).
create table if not exists ai_spend (
  id             bigint generated always as identity primary key,
  month          text not null,                -- 'YYYY-MM', UTC
  purpose        text not null,                -- 'fact_sheet'
  event_key      text,
  story_set      text,
  story_guids    text[],                       -- the stories sent; only a NEW story makes the event due again
  model          text not null,
  reserved_usd   numeric(10,6) not null,
  cost_usd       numeric(10,6),
  input_tokens   int,
  output_tokens  int,
  -- booked | written | no_sheet | invalid | kept_fuller | no_answer | write_failed | api_error | over_cap
  outcome        text not null default 'booked',
  created_at     timestamptz not null default now()
);
-- For a table made before story_guids was added (safe to run again).
alter table ai_spend add column if not exists story_guids text[];
create index if not exists ai_spend_month_idx on ai_spend (month);
create index if not exists ai_spend_event_idx on ai_spend (event_key);

-- Games are AI-drafted, human-approved. Nothing publishes from status='draft'.
create table if not exists games (
  id            bigint generated always as identity primary key,
  story_id      bigint references stories(id) on delete cascade,
  type          text not null check (type in ('quiz','predict','poll','satire')),
  status        text not null default 'draft' check (status in ('draft','approved','published','retired')),
  payload       jsonb not null,                -- questions/options/answers/explanations
  created_by    text not null default 'ai',
  approved_by   uuid,                          -- editor user id; required before publish
  published_at  timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  handle       text unique,
  points       int not null default 0,
  streak       int not null default 0,
  last_played  date
);

create table if not exists plays (
  id          bigint generated always as identity primary key,
  profile_id  uuid references profiles(id) on delete cascade,
  game_id     bigint references games(id) on delete cascade,
  answer      jsonb,
  correct     boolean,
  points      int not null default 0,
  created_at  timestamptz not null default now(),
  unique (profile_id, game_id)                 -- one play per game per person
);

create table if not exists predictions (
  id          bigint generated always as identity primary key,
  story_id    bigint references stories(id) on delete cascade,
  question    text not null,
  options     jsonb not null,                  -- ["Beats projections", ...]
  resolves_at timestamptz not null,
  outcome     int                              -- index into options; null = unresolved
);

create table if not exists prediction_picks (
  id             bigint generated always as identity primary key,
  prediction_id  bigint references predictions(id) on delete cascade,
  profile_id     uuid references profiles(id) on delete cascade,
  pick           int not null,
  points_awarded int,
  created_at     timestamptz not null default now(),
  unique (prediction_id, profile_id)
);

-- Row Level Security: public read for published content, users own their rows.
alter table stories enable row level security;
drop policy if exists "stories are public" on stories;
create policy "stories are public" on stories for select using (true);

-- story_bodies: Row Level Security ON and deliberately NO policy, plus no
-- grants, so the public (anon) and signed-in keys can read nothing. Only the
-- service-role key, which skips these rules, reads or writes it.
alter table story_bodies enable row level security;
revoke all on story_bodies from anon, authenticated;

alter table games enable row level security;
drop policy if exists "published games are public" on games;
create policy "published games are public" on games for select using (status = 'published');

alter table profiles enable row level security;
drop policy if exists "read own profile" on profiles;
create policy "read own profile"   on profiles for select using (auth.uid() = id);
drop policy if exists "update own profile" on profiles;
create policy "update own profile" on profiles for update using (auth.uid() = id);

alter table plays enable row level security;
drop policy if exists "read own plays" on plays;
create policy "read own plays"   on plays for select using (auth.uid() = profile_id);
drop policy if exists "insert own plays" on plays;
create policy "insert own plays" on plays for insert with check (auth.uid() = profile_id);

alter table predictions enable row level security;
drop policy if exists "predictions are public" on predictions;
create policy "predictions are public" on predictions for select using (true);

alter table prediction_picks enable row level security;
drop policy if exists "read own picks" on prediction_picks;
create policy "read own picks"   on prediction_picks for select using (auth.uid() = profile_id);
drop policy if exists "insert own picks" on prediction_picks;
create policy "insert own picks" on prediction_picks for insert with check (auth.uid() = profile_id);

-- events and story_events: private like story_bodies (RLS on, no policy, no grants).
alter table events enable row level security;
revoke all on events from anon, authenticated;
alter table story_events enable row level security;
revoke all on story_events from anon, authenticated;

-- fact_sheets and ai_spend: private the same way.
alter table fact_sheets enable row level security;
revoke all on fact_sheets from anon, authenticated;
alter table ai_spend enable row level security;
revoke all on ai_spend from anon, authenticated;

-- Service-role key (used by the ingester and editorial tools) bypasses RLS.
