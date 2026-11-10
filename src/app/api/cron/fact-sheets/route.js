/**
 * Vercel Cron endpoint: GET /api/cron/fact-sheets (PP-5)
 * Schedule lives in vercel.json (every 20 minutes, between ingestion runs).
 * This step spends money, so it REFUSES to run when CRON_SECRET is not set
 * (unlike /api/cron/ingest, which lets anyone run it then).
 * Writes up to MAX_EVENTS_PER_RUN fact sheets with Claude, inside the
 * $10-a-month cap, starting a call only while a whole one still fits in the
 * run (RUN_BUDGET_MS, inside maxDuration below). Answers with counts and
 * dollars only, never text.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { writeFactSheets, reportLine } from "@/lib/factSheets";

// Must stay above RUN_BUDGET_MS (270 s) in src/lib/factSheets.js.
export const maxDuration = 300;

export async function GET(request) {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: "CRON_SECRET is not set: this step spends money, so it does not run unprotected" }, { status: 503 });
  }
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const r = await writeFactSheets(supabaseAdmin());
  return Response.json({
    ok: !r.failed,
    report: reportLine(r),
    off: r.off, due: r.due, written: r.written, noSheet: r.noSheet, keptFuller: r.keptFuller, split: r.split, outOfTime: r.outOfTime,
    spentThisMonth: r.spent, capped: r.capped, skipped: r.skipped, failed: r.failed, errors: r.errors,
  });
}
