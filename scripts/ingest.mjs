#!/usr/bin/env node
/**
 * Run the RSS ingestion from the command line.
 *   node scripts/ingest.mjs            → fetch feeds and upsert into Supabase
 *   node scripts/ingest.mjs --dry      → fetch feeds, print what would be written
 *   node scripts/ingest.mjs --local    → parse scripts/sample/sample-feed.xml (offline, no network)
 */
import { readFileSync } from "node:fs";
import { ingestAll, ingestXml } from "../src/lib/ingest.js";
import { fullCopyPolicy } from "../src/lib/fullCopy.js";
import { supabaseAdmin } from "../src/lib/supabaseAdmin.js";

/** One line about full copy: counts only, never the text itself. */
function fullCopyLine(feedList, fc, writing) {
  const on = feedList.filter((f) => fullCopyPolicy(f).allowed).map((f) => f.name);
  if (!on.length) return `Full copy: off for all ${feedList.length} feeds (nothing stored privately).`;
  const head = `Full copy: on for ${on.length} feed(s) (${on.join(", ")}); ${fc.candidates} candidate stories`;
  return writing
    ? `${head}, ${fc.stored} newly stored in story_bodies, ${fc.deleted} older than 30 days deleted.`
    : `${head} (dry run: no article page fetched, nothing stored).`;
}

const args = new Set(process.argv.slice(2));
const feeds = JSON.parse(readFileSync(new URL("../data/feeds.json", import.meta.url))).feeds;

if (args.has("--local")) {
  const xml = readFileSync(new URL("./sample/sample-feed.xml", import.meta.url), "utf8");
  const sampleFeed = { name: "Sample Wire", category: "top" };
  const rows = await ingestXml(xml, sampleFeed);
  console.log(`Parsed ${rows.length} stories from local fixture:\n`);
  console.log(`  Full copy for ${sampleFeed.name}: ${fullCopyPolicy(sampleFeed).allowed ? "on" : "off"}\n`);
  for (const r of rows) console.log(`  [${r.attention}] ${r.title}\n      ${r.source} · ${r.published_at}\n      ${r.snippet.slice(0, 90)}…\n      ${r.url}\n`);
  process.exit(0);
}

const supabase = args.has("--dry") ? null : supabaseAdmin();
if (!supabase && !args.has("--dry")) {
  console.log("No Supabase env vars found — running as --dry. Copy .env.example to .env.local to enable writes.");
}
const t0 = Date.now();
const { fetched, written, errors, rows, fullCopy } = await ingestAll(feeds, supabase);
console.log(`\nFetched ${fetched} fresh stories from ${feeds.length} feeds in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(fullCopyLine(feeds, fullCopy, !!supabase));
if (supabase) console.log(`Upserted ${written} rows into stories`);
else {
  console.log("(dry run — nothing written). Top 10 by attention:\n");
  rows.sort((a, b) => b.attention - a.attention).slice(0, 10)
      .forEach((r) => console.log(`  [${String(r.attention).padStart(3)}] ${r.source} — ${r.title.slice(0, 70)}`));
}
if (errors.length) { console.log("\nFeed errors (non-fatal):"); errors.forEach((e) => console.log("  ×", e)); }
