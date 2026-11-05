---
name: loop-intake
description: Take the oldest "Requested" ticket (a request Dane filed from the tracker page), write it up as a proper spec (or several, one per pull request) with his words kept verbatim, and hand every resulting ticket to him in "Needs your input" to approve with "go". Runs unattended on the Mini as its own launchd lane. Never writes code, never queues anything itself.
---

# Loop: Intake

The step before step 1. `loop-spec` is a session with Dane; this is the
unattended version for the requests he files himself from the tracker page
(`/new`), which land in `Requested`. See `docs/LOOP_ENGINEERING.md` for the
whole system and `docs/LOOP_CONTRACT.md` for the statuses.

Each pass handles **at most one** `Requested` ticket. You write tickets; you
do NOT write code, open a worktree, or touch a pull request.

## Ticket access

Every touch goes through **`npm run clickup -- <command>`**, a full standalone
command each time. Doppler supplies the token; on the Mini the runner names
this lane's own sign-in (`TRACKER_TOKEN_LOOP_INTAKE`). The moves this pass
makes:

```bash
npm run clickup -- queue --status Requested                     # the requests, first line = the one to take
npm run clickup -- get --task <id>                              # his title and his words
npm run clickup -- comments --task <id>                         # anything he added since
npm run clickup -- task --name "..." --status Requested --tags <tag> --body-file -   # a further slice
npm run clickup -- describe --task <id> --body-file -           # REPLACE the description with the spec
npm run clickup -- ask --task <id> --status "Needs your input" --body-file -          # hand it to him
npm run clickup -- comment --task <id> --body-file -            # a plain note (failures)
```

Every one of those reads its own write back and exits non-zero when it did not
stick. **A non-zero exit is a failure you report**, never one you talk past.

## Workflow

1. **Find the request.**

   ```bash
   npm run clickup -- queue --status Requested
   ```

   Empty: print exactly one line, `loop-intake: no Requested ticket — nothing
   to do.`, and stop. Write nothing anywhere.

   Otherwise take the **first line** (the door orders priority-then-oldest;
   a request from the page carries no priority, so the first line is the
   oldest). Read it with `get` and `comments`.

   **One bad request must not block the ones behind it.** Look at this
   lane's own notes in `comments`, newest first, and stop at the first
   comment of Dane's (anything he wrote after a note answers it, so the
   ticket starts fresh):

   - The newest is `loop-intake GAVE UP:` → skip it and take the next line.
     Never write to it again; it waits for him.
   - The newest is `loop-intake FAILED:` → an earlier pass failed on it.
     Do not spec it again. Go to **step 8** (the stuck ticket) with it.
   - Neither → this is your request; carry on with step 2.

   If every line is skipped, print one line, `loop-intake: every Requested
   ticket has given up — nothing to do (<ids>).`, and stop.

2. **Keep his words.** His words are the ticket's **name** and its
   **description** exactly as `get` prints them, plus any comment of his on
   the ticket. Copy them byte for byte; never tidy, shorten or "fix" them.

   **A ticket that already has an `## Asked` heading was specced by an
   earlier pass that stopped before handing it over** (a slice filed just
   before a crash, say). Do not spec it again: his words are the fenced block
   under `## Asked`, the spec is already there; go straight to step 5 for that
   ticket alone.

   **A ticket without `## Asked` may still have been sliced** by a pass that
   stopped before its `describe`. Before you spec it, look for its slices:
   a `loop-intake slices filed:` comment on it (step 4 posts one), and, in
   case the pass stopped before that comment, any `Requested` ticket whose
   description says `Sliced from <this id>` (`get` each line of the queue).
   Found any: do not file them again. Reuse them, file only the slices still
   missing, then carry on from step 4's `describe`.

3. **Decide: clear, or a question.** Read the repository as far as you need
   to (`CLAUDE.md`, `docs/`, the files the request touches) to know what it
   would take. A request is **too unclear to spec** when two reasonable
   builders would build different things from it, or when the outcome he
   wants cannot be told from his words. Then do not guess:

   - Post the question with `ask` (step 5's card), with `@@NEEDED` holding the
     question, named options where you can give them.
   - **Change nothing else**: no `describe`, no new ticket.
   - Report and stop.

   Known gap (`docs/LOOP_CONTRACT.md`): his answer moves the ticket to
   `Queued` with its raw words still the description, and the build loop's
   own "too vague, ask" rule is what stops it there. Say so in `@@CONTEXT`
   ("your answer sends it to the build queue as written").

4. **Write the spec.** Build it from `.claude/skills/loop-spec/SKILL.md`
   step 2 and 3: the same sizing rules (one pull request's worth,
   independent, reviewable in a couple of minutes) and the same description
   shape, with one heading added first:

   ````
   ## Asked
   ```
   <his title>

   <his description, verbatim>
   ```

   ## Goal
   ## Scope
   ## Non-goals
   ## Affected files / artifacts
   ## Acceptance criteria
   ## How to test
   ## Risk
   ````

   **Pick a fence his text cannot close.** A fence closes only on a line of
   the same character, at least as long, with nothing after it. So if his
   text has a line starting with three backticks, open and close yours with
   four (more than his longest run); or use `~~~`, which no backtick line
   closes. A `> ` line of his is fine inside the fence. Outside a fence,
   never a `> ` blockquote: the script refuses them (`describe`, `task`,
   `comment` and `ask` all exit 2).

   **Affected files are real paths, checked**, and the "How to test" steps
   follow `loop-spec`'s rule: a link he can click, or an exact command with
   the output it should print.

   **One pull request's worth:** `describe` the request's own ticket with the
   spec. Keep its name unless it fails `loop-spec`'s naming rule (what breaks
   and who feels it); a name you cannot improve without changing his meaning
   stays as he wrote it.

   **More than one:** this ticket becomes the **first** slice (smallest and
   safest first). File each further slice FIRST, before you rewrite this
   one, so a failure leaves his request untouched:

   ```bash
   npm run clickup -- task --name "..." --status Requested --tags request-form --body-file -
   ```

   Each slice gets the same shape, the same `## Asked` block (his whole
   request, verbatim), the same tags as the original (`get` prints them;
   `request-form` when it has none), and, right under `## Asked`:

   ```
   ## Order
   Sliced from <original id> ("<original name>"), slice <n> of <total>.
   Waits on: <id of the slice it needs merged first>
   ```

   (Leave out the `Waits on:` line for a slice that needs nothing first.)
   They are filed as `Requested` so no build loop can claim one before he has
   approved it. **Before the `describe`, record what you filed** on the
   original, so a pass that stops here never slices it twice:

   ```bash
   npm run clickup -- comment --task <original id> --body-file -   # "loop-intake slices filed: <id>, <id> (slice 2 and 3 of 3)"
   ```

   Then `describe` the original with slice 1, whose `## Order` names the
   other slices' ids.

   File at **normal** priority or none. Never Urgent, never High.

5. **Hand every ticket to him.** For the original and each slice, one `ask`:

   ````
   @@ASKED
   <his title and description, verbatim — the same words as under ## Asked,
   with NO fence of your own round them>
   @@CONTEXT
   What you understood him to want and what this ticket does about it, in
   plain English, 50-100 words. For a slice: which slice of how many, and
   what the others cover.
   @@NEEDED
   Reply "go" to queue it as written, or reply with what to change.
   Your move: Reply — "go", or what to change.
   ````

   The last line of `@@NEEDED` is always his move, `Your move: Reply` here
   (`ask` refuses a card without one).

   His words go into `@@ASKED` bare. The card puts that section in a code
   block of its own, with a fence longer than any backtick run in his text,
   so his `> ` lines and his own ``` lines arrive as he wrote them. A fence
   you add there would land inside the card's and break it on the page.

   **Retry only on the one refusal that is safe to retry.** If `ask` exits 2
   and its output says `REFUSED — Dane's own comment is the NEWEST one`,
   that comment is part of the request you just read, not an answer to a
   question: run the same `ask` again with `--after-his-answer`. Exit 2 for
   anything else (a card word count, a blockquote, a bad status) is a
   mistake in your card: fix the card and run it once more; if it still
   refuses, it is a failure for step 6.

   **Exit 1 is never retried in the same pass.** It means the card may
   already be on the ticket (`Card posted ... the status did NOT move` or
   `did NOT stick`); a second `ask` would post a second card. Record it as a
   failure (step 6) and let step 8 finish it on a later pass.

6. **Account for every write.** Collect the outcome of each `task`,
   `describe` and `ask`. If any one failed (non-zero exit, a read-back that
   did not match):

   - Post a `comment` starting `loop-intake FAILED:` on **each ticket a step
     failed for**, naming the failed step, its exit and the first line of its
     error, and what was left in which status. On the original, also name
     any slice that failed.
   - Print the same, starting `FAILED:`.
   - Never print a success line for that step.

   That note is what step 1 reads: the next pass does not spec the ticket
   again, it goes to step 8 with it. If the note itself cannot be posted,
   print `FAILED:` saying so; the next pass simply retries the ticket.

7. **Report** in a few lines: the request (id and exact name), each ticket
   now in `Needs your input` (id and exact name), any ticket skipped as
   given up, and anything that failed.

8. **The stuck ticket** (step 1 sent you here: its newest note is
   `loop-intake FAILED:`). Make **one** attempt to hand it to him as it is:
   no spec, no `describe`, no new slice.

   - If a card from this lane is already on the ticket (the `ask` exit 1
     case), say in `@@CONTEXT` that the card above did not finish handing
     it over and this one does.
   - The card: `@@ASKED` is **his title only**, bare (his full text may be
     what failed); `@@CONTEXT` says in plain words that the intake
     pass could not finish this request and why (the FAILED note's step and
     error); `@@NEEDED`: reply with the request reworded, or "go" to send it
     to the build queue as it is.
   - **If it was sliced** (it has a `loop-intake slices filed:` note, or a
     `Requested` ticket says `Sliced from <this id>`), his whole request is
     no longer the only copy of the work. `@@CONTEXT` names each filed slice
     by id and exact name and what it covers, and `@@NEEDED` says it plainly:
     "go" queues this full request as well as the slices, so the same work
     would be built twice; to avoid that, reply with only the part the slices
     leave out. (Any reply queues this ticket, the contract's known gap; the
     build loop reads his reply before building.) Never offer a bare "go" on
     a sliced original.
   - `ask` it, with `--after-his-answer` only on the refusal step 5 names.

   It works: that is this pass's one request; report it and stop. It fails:
   post `loop-intake GAVE UP:` with the step and error (step 1 then skips
   the ticket for good), print `FAILED:` the same, and go back to step 1
   for the next line. A give-up does not count as the pass's one request.

## Guardrails

- **One request per pass.** Never a second `Requested` ticket in the same
  pass, even when the first was quick. (A ticket given up in step 8 does
  not count; the pass moves on to the next.)
- **No ticket gets more than two cards from this lane**: step 5's, and one
  more from step 8. Never a third.
- **Never move a ticket anywhere but `Needs your input`**, and only with
  `ask`. Never `Queued`: his "go" is what queues it (the relay's hand-back).
- **Never invent his words.** `@@ASKED` and `## Asked` are his, verbatim.
- **Never code.** No worktree, no branch, no pull request, no edit to the
  repository.
- **Never Urgent.** Urgent is his lane.
- **Plain language** in names, specs and cards: the reader is Dane.
