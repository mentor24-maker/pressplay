---
name: loop-build
description: Pick the next claimable task (all "Rework" first, then "Queued") from the PressPlay queue in the tracker and build it end-to-end into a pull request — in its own git worktree, passing `npm run verify` — then move the task to "In review". Designed to be run on a timer with `/loop 30m loop-build`. Never edits main, never merges.
---

# Loop: Build

Step 2 of 3 in PressPlay's development loop (spec → build → review), the loop Spirality defines.
See `docs/LOOP_ENGINEERING.md` for the whole system.

Each run builds **one** task into **one** PR. Under `/loop` it repeats,
draining the queue one clean PR at a time.

## Before anything: one claimant

Claiming a ticket is check-then-act (a read, a comparison, a write), which is
only sound with exactly one build pass running. On the Mini the build lane's
runner (`scripts/loop_runner.sh`) holds a lock, `$LOG_DIR/$SLUG-loop-build.lock`,
so only one runner runs and its passes run one after another. A session
started by hand holds no lock, so **it does not build while the lane is
loaded**.

**First tell which one you are.** The lane's runner, `scripts/loop_runner.sh`,
exports `LOOP_RUNNER_PID` to every pass it starts:

```bash
echo "${LOOP_RUNNER_PID:-}"
```

- **Set** (a number): you ARE the build lane's own pass, and the runner's
  lock (`$LOG_DIR/$SLUG-loop-build.lock`) is yours: it is what makes you the only
  one. Carry on. A loaded lane, a held lock and a running `loop_runner.sh`
  are you, not a second builder. (On 11/4 two build passes in a row stood down
  here, each naming its own runner's process, and two tickets sat in Rework.)
- **Empty**: you were started by hand. Run
  `scripts/install_loop_runner.sh --status`; if `loop-build` shows
  `loaded:   yes`, stop and report that the lane is running, unless Dane has
  asked for this pass by hand (then claim only through `claim`, which is
  guarded on the ticket's status). Otherwise carry on.
- **Whenever you stop for this reason**, the first line of your report is
  exactly `LANE STOOD DOWN: <why, in one line>`, and nothing else ever starts
  with those words. The setup wizard reads a new product's first lane passes
  for that line (`npm run onboard:lanes`), never for wording, because a pass
  that is the lane says "I am the lane, not a second one" too.

A ticket in `Building` is not proof that a pass is building it. A pass that
dies (killed, out of time, out of session) leaves its ticket there, and
nothing claims from `Building` (SP-101: SP-92 sat a day that way). So every
pass begins with this, **once, before it claims, never later** (later, the
marker is your own claim and it would hand back the ticket you are building):

```bash
npm run clickup -- pass-reconcile
```

A `claim` made by the build runner's pass writes a claim marker naming the
ticket; the hand-off (`status` or `ask`) clears it. A hand-run session never
writes one, so its ticket is never taken back. `pass-reconcile` reads the
marker the last pass left: if that ticket is still in `Building`, its pass is
gone, and it goes back to `Rework` (it has a PR) or `Queued` (it has none),
guarded on `Building`, with one note read back naming the claim time and any
unpushed worktree from around then. **Nothing is deleted.** Run by hand while
the runner is running, it leaves the marker alone. Exit 0 nothing to do,
3 handed one back (both normal: carry on and claim). Exit 1 (a write failed)
or 2 (could not tell) keeps the marker for the next pass to retry: **stop the
pass there and report it**. `claim` refuses, with exit 1, to write over a
marker whose ticket is still in `Building` or cannot be read, because that
marker is the only record of the stranded ticket. A claim refused at its guard
(exit 3) clears the marker it wrote. Any other `Building` ticket is not yours:
leave it.

## Ticket access: the direct script, not the connector

Every ticket touch (the tracker, since the switch from ClickUp) goes through **`npm run clickup -- <command>`** — a full
standalone command each time (shell state does not survive between tool
calls). Doppler supplies the token; you never see or handle it. The moves this
loop makes:

```bash
npm run clickup -- pass-reconcile                                      # FIRST: hand back the ticket a dead pass left in Building
npm run clickup -- queue --claimable                                   # FIRST LINE is the task to claim (all Rework, then Queued)
npm run clickup -- claim --task <id>                                   # safe claim; exit 3 = moved or still waits on a ticket, take the next
npm run clickup -- get --task <id>                                     # header + body; also shows any recorded PR and send-back rounds
npm run clickup -- comments --task <id>                                # the review notes live here on a Rework ticket
npm run clickup -- pr-opened --task <id> --pr <pr-url> --human-hours <N> --body-file -   # record the PR — REQUIRED, and it verifies itself
npm run clickup -- status --task <id> --status "In review"             # hand off (assignees auto-cleared)
npm run clickup -- ask --task <id> --status "Needs your input" --body-file -   # escalate: card + status together
npm run clickup -- comment --task <id> --body-file -                   # a plain note
npm run clickup -- waiting [--task <id>]                               # read-only: is this ACTUALLY waiting on Dane?
npm run clickup -- describe --task <id> --body-file -                  # REPLACE the description (left column)
```

**`describe` REPLACES the description.** The spec and acceptance criteria live
there; an outcome report is a `comment`, never a `describe`.

**Escalating is one command, not two.** `status --status "Needs your input"`
refuses on its own. Use `ask`, whose body is the operator card:

```
@@ASKED     his own words that caused this ticket, verbatim — never invented
@@WHEN      optional — when and where he said it
@@CONTEXT   the problem and the fix in plain English, 50-100 words (enforced)
@@NEEDED    the specific ask; give him named options where you can.
            Its LAST line is his move: "Your move: Merge", "Your move: Close"
            or "Your move: Reply", then a short reason (enforced). Never tell
            him to move a ticket himself; offer "Your move: Close" instead.
@@EVIDENCE  required ONLY when the ask costs money or cannot be undone
```

**Hand-offs that are genuinely his** (CLAUDE.md names four): a real secret
value, a billing screen, a browser login, or a decision only he can make.
Each of those is an `ask`, saying which of the four it is. Anything else, you
run yourself.

## Never say something is waiting on Dane without checking

```bash
npm run clickup -- waiting --task <id>
```

Exit **0** nothing of his / **3** something IS his / **1** could not tell.

## Workflow

1. **Claim the next task.**

   ```bash
   npm run clickup -- pass-reconcile
   npm run clickup -- queue --claimable
   npm run clickup -- claim --task <id>
   ```

   `--claimable` returns every `Rework` ticket before any `Queued` one —
   rework oldest-first, then queued by priority-then-oldest. A `Rework` ticket
   is a send-back: it already has a branch, an open PR and review notes.
   Finishing one is cheaper than starting something new. If the list comes
   back empty, report "queue empty" and stop — do not invent work.

   `claim` reads the ticket's own status and guards the write on it. Exit 3
   means it moved underneath you, or its `Waits on:` line names a ticket
   still open (or a line it cannot read) — take the next task. Exit 1 on a
   `Waits on:` ticket that cannot be read: say so on the ticket, take the
   next.

   **On a `Rework` ticket, do NOT start a second branch.** `get` prints the
   recorded PR. Check out that branch into a worktree
   (`git worktree add .claude/worktrees/<slug> -b <branch> origin/<branch>`),
   read the send-back in `comments`, fix what it named, and push to the SAME
   PR. A `MAIN MOVED: ... — conflict` note newer than the send-back is part of
   the rework even when review did not name it.

   The eight statuses are `Requested → Rework → Queued → Building →
   In review → Needs your input / Ready to launch → Live`. `Requested` is
   Dane's unspecced words from the tracker page: never claimed, never built
   from; a spec pass owns it. Two belong to Dane and no loop
   may set or clear them except through `ask`. **Assignment is the handoff
   signal**: moving into his statuses assigns him; moving into a machine
   status clears assignees. `status` enforces both and verifies they stuck.

2. **Get an isolated workspace — MANDATORY.** One worktree and one branch per
   task, off the latest `main`. Never build in the main folder; never edit
   `main` (a hook blocks it). Run this as ONE command:

   ```bash
   MAIN="$(git rev-parse --path-format=absolute --git-common-dir | sed 's#/\.git$##')" && \
     git -C "$MAIN" fetch origin --quiet && \
     git -C "$MAIN" worktree add "$MAIN/.claude/worktrees/<task-slug>" -b <task-slug> origin/main && \
     cd "$MAIN/.claude/worktrees/<task-slug>" && \
     if [ -f package-lock.json ]; then npm ci; fi
   ```

   `<task-slug>` = short kebab-case name from the task. Do ALL work for this
   task inside that worktree.

3. **Build to the acceptance criteria.** Implement exactly what the task's
   Scope and Acceptance criteria describe. Respect the Non-goals. Keep every
   rule in `CLAUDE.md` → "Engineering rules": nothing project-specific
   hard-coded in substrate code; move StarCaster's modules with their tests,
   never rewrite; every ClickUp write read back; a failed step says so.

   **Verify the premise before building it.** A defect ticket is a claim to
   check, not a spec to obey. If the premise is wrong, post the correction on
   the ticket FIRST (a `comment`), then build what is true.

4. **Run the gates — the definition of done.**

   **Catch up with `main` first.** Another ticket may have merged while you
   built. Run `npm run clickup -- get --task <id>` and read its `main:` line:
   the relay writes a `MAIN MOVED:` note on your ticket after every merge.
   On anything but `no-overlap` (or always, it is cheap), merge it in now,
   before review finds it: `git fetch origin && git merge origin/main
   --no-edit`. A real conflict here is yours to resolve, inside the task's
   scope, with the conflicted files read and understood, never by taking one
   side blind.

   ```bash
   npm run verify
   ```

   `verify` is the ONE name for the gates; CI runs the same script. If your
   task adds a new kind of check (typecheck, build, a test suite), add it to
   `verify` in `package.json` so every later task inherits it. If a gate fails
   and you cannot fix it **within the task's scope**, `ask` and stop. Do not
   force a broken build through, and do not widen scope to chase an unrelated
   failure.

   If the change has a visible surface, open it (the `run` skill, or
   `npm run dev` once it exists) and walk the ticket's "How to test" steps
   yourself. Say in the PR where you looked and what you saw.

5. **Add a plain-English work-log entry.** Write one new file,
   `docs/work-log/<YYYY-MM-DD>-<branch>.md` (today's date, Mountain time, and
   this task's branch name): a heading `## <date> — <title> (#PR)`, then what
   changed and why it mattered, the way you would explain it to a
   non-programmer. One file per PR, so two PRs built at once never clash on
   the log. This entry rides in the task's own PR, so the log lands on `main`
   with the work. Never add entries directly on `main`. `docs/WORK-LOG.md` is
   the older history, closed to new entries: never edit it.

   You do not have the PR number yet. **Never amend a pushed commit to add
   it** — that needs a force-push, which is forbidden. Either commit the code,
   push, open the PR, then add the work-log entry as a second commit; or open
   the PR as a draft first, read the number, then write the entry.

6. **Commit and open the PR.**
   - Inspect `git diff --cached` before committing: no stray edits, no
     generated files, no `.env`. **This repository is public.**
   - Commit message ends with the Co-Authored-By trailer.
   - **The PR title is the ticket name, copied exactly**
     (`npm run clickup -- task-name --task <id>` prints it). Dane pairs the
     Live tickets against the deploy list by name.
   - Push the branch and open a PR to `main` with `gh pr create`. The body
     must include **the ticket link `pr-opened` reads**, on a line of its
     own: the ticket's page, `Ticket: <trackerUrl>/t/SP-12`, with the
     `trackerUrl` written in `spirality.project.json`
     (`Ticket: http://mac-mini.local:4180/t/SP-12`). Not the `url:` line
     `get` prints: that is the API address the loop itself uses. `pr-opened`
     refuses
     without it and prints the exact line, a plain-language
     summary, and the task's "How to test" steps. End with the Generated-with
     trailer.
   - Wait for the `verify` check: `gh pr checks <pr> --watch`. If no check
     appears after a couple of minutes, `gh pr view <pr> --json
     mergeable,mergeStateStatus`: `CONFLICTING` means merge `origin/main` in
     (`git merge origin/main --no-edit && git push`); only on `MERGEABLE` is
     an empty nudge commit the right move.
   - **Only ordinary pushes.** If a push is rejected because the branch is
     behind, merge `origin/main` in — never rebase-and-force.

7. **Record the PR on the ticket — with the command, and check what it says.**

   ```bash
   echo "Why that estimate: <one line>" | \
     npm run clickup -- pr-opened --task <id> --pr <pr-url> --human-hours <N> --body-file -
   ```

   It refuses if the PR body has no link back to the ticket, posts the one
   line the review and merge steps read (`PR opened: <url>`), and parses it
   back. **A non-zero exit fails the run** — do not hand the ticket to review.

   **`--human-hours` goes on every time.** It is the Reporting page's count of
   how much human programmer work the loops did (SP-78). Estimate it from the
   finished pull request, the same way every time: the hours an experienced
   programmer **new to this code** would take to read the ticket, find their
   way around the files it touches, make the change, write the tests and get
   it through review. Not how long this pass took, and not a guess at what
   Dane would pay. Whole or half hours, more than 0 and at most 200 (anything
   else exits 2 and writes nothing; a job worth more than 200 should have been
   sliced). The reason is ONE line on stdin, starting `Why that estimate:`,
   naming what drove the number (e.g. "Why that estimate: a new module with
   tests, two existing tests extended, one skill file edited"). On a `Rework`
   ticket, the newest `PR opened:` comment is the one counted, so if you
   record the PR again, estimate the whole pull request as it now stands.

8. **Hand off to review.** `npm run clickup -- status --task <id> --status
   "In review"`. Leave it unassigned (it is the machine's turn). **Do NOT
   merge** — merges happen only on Dane's explicit say-so. `loop-review` takes
   it from here.

9. **Report** which task you built and the PR number, then finish.

## Guardrails

- **A PASS MAY NOT END WITH ITS TICKET STILL IN `Building`.** `Building` is a
  status no loop claims from, so a ticket left there is unreachable, not late.
  Before you report, the ticket is in `In review` (finished), `Rework` or
  `Queued` (handed back on purpose, with a comment saying why), or
  `Needs your input` (escalated with `ask`).
- **YOU CANNOT PROMISE TO COME BACK.** A pass ends when it stops producing
  output. If you are waiting on checks, wait inside the pass, then move the
  ticket. If you cannot wait, hand it back to `Rework` with an honest note.
- **One task, one worktree, one PR.** Never build two tasks in one branch.
- **The PR and the ticket must name each other.** `pr-opened` enforces both
  directions.
- **Never touch a task that is not `Rework` or `Queued`.** `claim` refuses them.
- **Never set `Ready to launch` and never clear `Needs your input`.** Those
  are Dane's. A build loop never sets either one and never merges.
- If the task description is too vague to build safely, `ask` for a
  `loop-spec` pass — don't guess. Name in `@@NEEDED` what is missing.
- **If a task is bigger or riskier than one unattended pass should build**,
  `ask` before building and offer named slices, smallest-and-safest first.
  Then build only the slice he names, narrowing the description with
  `describe` first.
- **Ticket titles say in plain words what breaks and who feels it.** Fix a
  cryptic name on the ticket first, then copy it to the PR.
- Leave the worktree in place until the PR merges; `loop-review` may reuse it.
