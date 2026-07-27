/** Server-side Supabase client using the service-role key. NEVER import in client components. */
import { createClient } from "@supabase/supabase-js";

export function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null; // allows dry-run mode everywhere
  return createClient(url, key, { auth: { persistSession: false } });
}
