#!/usr/bin/env node
/**
 * Write fact sheets from the command line (PP-5).
 *   node scripts/fact-sheets.mjs        → write up to 3 due fact sheets with Claude (needs ANTHROPIC_API_KEY)
 *   node scripts/fact-sheets.mjs --due  → only list which events are due, and this month's spend; calls nothing
 * Prints counts, event keys and dollars only, never article text or facts.
 */
import { supabaseAdmin } from "../src/lib/supabaseAdmin.js";
import { writeFactSheets, eventsDue, spentThisMonth, reportLine, MONTHLY_CAP_USD } from "../src/lib/factSheets.js";

const supabase = supabaseAdmin();
if (!supabase) {
  console.log("No Supabase env vars found: nothing to read. Copy .env.example to .env.local.");
  process.exit(0);
}

if (process.argv.includes("--due")) {
  try {
    const due = await eventsDue(supabase);
    const spent = await spentThisMonth(supabase);
    console.log(`${due.length} event(s) due a fact sheet; $${spent.toFixed(2)} of $${MONTHLY_CAP_USD.toFixed(2)} spent this month.`);
    for (const e of due) console.log(`  ${e.key}  (${e.stories.length} stories from ${new Set(e.stories.map((s) => s.source)).size} outlets)`);
    process.exit(0);
  } catch (err) {
    console.log(`Reading what is due FAILED: ${err.message}`);
    process.exit(1);
  }
}

const r = await writeFactSheets(supabase);
console.log(reportLine(r));
r.errors.forEach((e) => console.log("  ×", e));
process.exit(r.failed ? 1 : 0);
