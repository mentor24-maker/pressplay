/**
 * Vercel Cron endpoint: GET /api/cron/ingest
 * Schedule lives in vercel.json (every 20 minutes).
 * Protected by CRON_SECRET (Vercel sends it as a Bearer token automatically).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ingestAll } from "@/lib/ingest";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { linkEvents } from "@/lib/events";

export const maxDuration = 60;

export async function GET(request) {
  const auth = request.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const file = path.join(process.cwd(), "data", "feeds.json");
  const { feeds } = JSON.parse(readFileSync(file, "utf8"));
  const supabase = supabaseAdmin();
  // fullCopy is counts only; the text itself never leaves the server.
  const { fetched, written, errors, fullCopy } = await ingestAll(feeds, supabase);
  // Group the last 48 hours of stories into events (private tables; counts only here).
  let events = null;
  if (supabase) {
    const ev = await linkEvents(supabase);
    errors.push(...ev.errors);
    events = { considered: ev.considered, linked: ev.linked, newEvents: ev.newEvents, failed: ev.failed };
  }
  return Response.json({ ok: true, fetched, written, fullCopy, events, dryRun: !supabase, errors });
}
