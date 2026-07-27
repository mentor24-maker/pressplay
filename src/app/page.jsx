import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const revalidate = 300; // re-render at most every 5 minutes

const CAT = { top:"Top Story", pol:"Politics", biz:"Business", tec:"Technology",
              spt:"Sports", ent:"Entertainment", sci:"Science", loc:"Local", str:"Strange but True" };

export default async function Home() {
  const supabase = supabaseAdmin();

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

  const { data: stories } = await supabase
    .from("stories")
    .select("id,title,url,source,category,snippet,published_at,attention")
    .order("attention", { ascending: false })
    .limit(20);

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
      {!stories?.length && <p>No stories yet — run <code>npm run ingest</code>.</p>}
    </main>
  );
}
