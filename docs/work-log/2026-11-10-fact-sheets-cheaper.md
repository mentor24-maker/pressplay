## 2026-11-10 — The fact sheets cost more than they need to: cap Claude spending at $10 a month and use the cheapest Claude model (#10)

The neutral fact sheets are now written by Claude Haiku 5.5, Anthropic's
cheapest model, in place of Opus 5.5, and spending on them stops at $10 a
month instead of $50. A typical sheet used to cost about ten cents and now
costs about a quarter of a cent, so $10 covers thousands of them.

One thing the plan didn't expect: Haiku has two prices. A very long request
(over 100,000 tokens, which our biggest news events can reach) pays five
times the normal rate. The spending count now knows both prices and books
every call at the most it could cost, so the $10 limit holds even for those
long requests. The smaller model may write weaker sheets, so it's worth
reading the first few it produces.

After review: the "most it could cost" guess had a gap right at the
100,000-token line. A long event the step guessed was just under the line
was booked at the cheap rate, but if its text was denser than usual (lots of
numbers, tables, or non-English copy) the real bill could land over the line
at five times the price. The step now assumes the densest text (one token
per character) when it books a call, so any event that could cross the line
is booked at the higher price. Small events still book at under a cent. The
booking is only a hold; it settles to the real cost afterwards. A leftover
"$50" in the database notes now says $10.
