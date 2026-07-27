import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const revalidate = 300; // re-render at most every 5 minutes

const CAT = { top:"Top Story", pol:"Politics", biz:"Business", tec:"Technology",
              spt:"Sports", ent:"Entertainment", sci:"Science", loc:"Local", str:"Strange but True" };

export default async function Home() {
  const supabase = supabaseAdmin();
  // Safe to display: this is the NEXT_PUBLIC_ url, not a secret. Showing it
  // makes "pointed at the wrong Supabase project" obvious at a glance.
  const host = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/^https?:\/\//, "") || "not set";

  if (!supabase) {
    return (
      <main className="wrap">
        <h1>Almost there.</h1>
        <p className="sub">The app is running — connect Supabase to see live stories.</p>
        <div className="setup">
          <ol>
            <li>Create a free project at supabase.com and run <code>supabase/schema.sql</code> in the SQL editor.</li>
            <li>Copy <code>.env.example</code> to <code>.env.local</code> and fill in your project keys.</li>
            <li>Run <code>npm run ingest</code> to pull your first stories, then refresh this page.</li>
          </ol>
        </div>
      </main>
    );
  }

  const { data: stories, error } = await supabase
    .from("stories")
    .select("id,title,url,source,category,snippet,published_at,attention")
    .order("attention", { ascending: false })
    .limit(20);

  // A failed query returns data:null, which is indistinguishable from an empty
  // table unless we look at `error`. Say which it is — a silent empty page sent
  // us chasing the ingester when the real fault was upstream.
  if (error) {
    return (
      <main className="wrap">
        <h1>Can&apos;t read the stories table.</h1>
        <p className="sub">
          The app reached Supabase at <code>{host}</code> but the query failed.
        </p>
        <div className="setup">
          <p><strong>{error.message}</strong>{error.code ? ` (${error.code})` : ""}</p>
          <ol>
            <li>Confirm that host is the PressPlay project — not Starcaster or Normie.</li>
            <li>Confirm <code>supabase/schema.sql</code> has been run on it.</li>
            <li>Check <code>SUPABASE_SERVICE_ROLE_KEY</code> for a truncated paste or a trailing comment.</li>
          </ol>
        </div>
      </main>
    );
  }

  return (
    <main className="wrap">
      <h1>Today&apos;s most viral stories, curated.</h1>
      <p className="sub">
        Pulled from your feed list, ranked by attention. Next step: attach one game per story.
      </p>
      {(stories ?? []).map((s) => (
        <article className="story" key={s.id}>
          <div className="meta">
            <span className="chip">{CAT[s.category] ?? s.category}</span>
            <span className="att">Attention {s.attention}</span>
            <span>{s.source}</span>
            <span>· {new Date(s.published_at).toLocaleString()}</span>
          </div>
          <h3>{s.title}</h3>
          {s.snippet && <p className="snippet">{s.snippet}</p>}
          <p style={{ marginTop: 8 }}>
            <a href={s.url} target="_blank" rel="noreferrer">Read the original →</a>
          </p>
        </article>
      ))}
      {!stories?.length && (
        <p>
          The <code>stories</code> table on <code>{host}</code> is empty — run{" "}
          <code>npm run ingest</code>. (The query itself succeeded, so the
          connection and schema are fine.)
        </p>
      )}
    </main>
  );
}
