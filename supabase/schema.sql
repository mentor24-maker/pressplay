-- PressPlay Today — Phase One schema
-- Run in the Supabase SQL editor. Copyright posture: stories hold ONLY
-- headline, snippet, attribution, timestamp, and link. Never full text.

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
create policy "stories are public" on stories for select using (true);

alter table games enable row level security;
create policy "published games are public" on games for select using (status = 'published');

alter table profiles enable row level security;
create policy "read own profile"   on profiles for select using (auth.uid() = id);
create policy "update own profile" on profiles for update using (auth.uid() = id);

alter table plays enable row level security;
create policy "read own plays"   on plays for select using (auth.uid() = profile_id);
create policy "insert own plays" on plays for insert with check (auth.uid() = profile_id);

alter table predictions enable row level security;
create policy "predictions are public" on predictions for select using (true);

alter table prediction_picks enable row level security;
create policy "read own picks"   on prediction_picks for select using (auth.uid() = profile_id);
create policy "insert own picks" on prediction_picks for insert with check (auth.uid() = profile_id);

-- Service-role key (used by the ingester and editorial tools) bypasses RLS.
