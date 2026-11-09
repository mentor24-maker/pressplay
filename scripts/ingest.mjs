#!/usr/bin/env node
/**
 * Run the RSS ingestion from the command line.
 *   node scripts/ingest.mjs            → fetch feeds and upsert into Supabase
 *   node scripts/ingest.mjs --dry      → fetch feeds, print what would be written
 *   node scripts/ingest.mjs --local    → parse scripts/sample/sample-feed.xml (offline, no network)
 */
import { readFileSync } from "node:fs";
import { ingestAll, ingestXml } from "../src/lib/ingest.js";
import { fullCopyPolicy, RETENTION_DAYS } from "../src/lib/fullCopy.js";
import { supabaseAdmin } from "../src/lib/supabaseAdmin.js";
import { linkEvents, countEvents, EVENT_WINDOW_HOURS } from "../src/lib/events.js";

/** Lines about full copy: counts only, never the text itself. A failed step says so. */
function fullCopyLines(feedList, fc, writing) {
  const lines = [];
  const on = feedList.filter((f) => fullCopyPolicy(f).allowed).map((f) => f.name);
  if (!on.length) lines.push(`Full copy: off for all ${feedList.length} feeds (nothing stored privately).`);
  else {
    const head = `Full copy: on for ${on.length} feed(s) (${on.join(", ")}); ${fc.candidates} candidate stories`;
    if (!writing) lines.push(`${head} (dry run: no article page fetched, nothing stored).`);
    else if (fc.failed.some((s) => s !== "clean-up")) lines.push(`${head}; storing FAILED (${fc.failed.filter((s) => s !== "clean-up").join(", ")}), see the errors below.`);
    else lines.push(`${head}, ${fc.stored} newly stored in story_bodies.`);
  }
  if (writing) {
    lines.push(fc.failed.includes("clean-up")
      ? `Clean-up of full copy older than ${RETENTION_DAYS} days FAILED, see the errors below.`
      : `Clean-up: ${fc.deleted} full-copy row(s) older than ${RETENTION_DAYS} days deleted.`);
  }
  return lines.join("\n");
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
console.log(fullCopyLines(feeds, fullCopy, !!supabase));
if (supabase) {
  console.log(`Upserted ${written} rows into stories`);
  // Group the last 48 hours of stories into events (private tables).
  const ev = await linkEvents(supabase);
  console.log(ev.failed
    ? `Events: grouping FAILED (${ev.failed}):`
    : `Events: ${ev.considered} stories from the last ${EVENT_WINDOW_HOURS}h looked at; ${ev.linked} newly placed, ${ev.newEvents} new event(s).`);
  ev.errors.forEach((e) => console.log("  ×", e));
} else {
  const ev = countEvents(rows);
  console.log(`Events (dry run, nothing stored): these ${ev.stories} stories make ${ev.events} event(s), ${ev.multiSource} of them with more than one story.`);
  console.log("(dry run — nothing written). Top 10 by attention:\n");
  rows.sort((a, b) => b.attention - a.attention).slice(0, 10)
      .forEach((r) => console.log(`  [${String(r.attention).padStart(3)}] ${r.source} — ${r.title.slice(0, 70)}`));
}
if (errors.length) { console.log("\nFeed errors (non-fatal):"); errors.forEach((e) => console.log("  ×", e)); }
