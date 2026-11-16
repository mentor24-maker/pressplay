## 2026-11-14 — Add a feed for the Politics and Strange but True categories (#11)

Two of the nine sections on the front page, Politics and Strange but True,
were always empty because no news feed was assigned to them.

Politics now draws on BBC News Politics. Before adding it, we read BBC's feeds
page, which openly encourages websites to show its headlines as long as BBC is
credited. The practice run (`npm run ingest:dry`) also prints a count of fresh
stories per section, so an empty section now shows as a 0 instead of going
unnoticed.

Strange but True was harder. Every strange-news source we checked was too
quiet, limited to personal use, or had terms we couldn't read. Which one to use
is a legal call, so it went to Dane. He read UPI's terms and said "UPI ok", so
Strange but True now draws on UPI Odd News. UPI posts odd news on weekdays
only, so the section is empty from Sunday afternoon until Monday's first
stories. The new count also exposed a separate
problem: The Denver Post is refusing our reader, so Local is empty too.
