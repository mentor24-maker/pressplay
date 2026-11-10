/**
 * Vercel Cron endpoint: GET /api/cron/fact-sheets (PP-5)
 * Schedule lives in vercel.json (every 20 minutes, between ingestion runs).
 * Protected by CRON_SECRET, like /api/cron/ingest.
 * Writes up to MAX_EVENTS_PER_RUN fact sheets with Claude, inside the
 * $50-a-month cap. Answers with counts and dollars only, never text.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { writeFactSheets, reportLine } from "@/lib/factSheets";

// Each call to Claude can take a minute or two.
export const maxDuration = 300;

export async function GET(request) {
  const auth = request.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const r = await writeFactSheets(supabaseAdmin());
  return Response.json({
    ok: !r.failed,
    report: reportLine(r),
    off: r.off, due: r.due, written: r.written, noSheet: r.noSheet, split: r.split,
    spentThisMonth: r.spent, capped: r.capped, skipped: r.skipped, failed: r.failed, errors: r.errors,
  });
}
