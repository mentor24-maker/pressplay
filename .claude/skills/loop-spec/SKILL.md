---
name: loop-spec
description: Turn a rough idea from Dane into a set of small, well-scoped, independently-shippable work items filed as tickets in the PressPlay queue in the tracker, each with acceptance criteria and test steps. This is the ONLY manual step of the loop — run it at the start of a work session to feed the build/review loops.
---

# Loop: Spec

Step 1 of 3 in PressPlay's development loop (spec → build → review), the loop Spirality defines.
See `docs/LOOP_ENGINEERING.md` for the whole system.

Your job: interview Dane about an idea, then break it into a queue of small
tasks that the `loop-build` skill can build one pull request at a time. You do
NOT write any code here. You produce well-formed tasks.

## Inputs

- A rough idea or goal from Dane (one sentence is fine to start).
- The target is the PressPlay queue in **the tracker** (the script's
  default; ids like `SP-12`). File tasks through the direct script, which carries
  priority and tags and verifies the body saved:

  ```bash
  npm run clickup -- task --name "..." --status Queued --priority high --tags "epic-name" --body-file -
  ```

  (body on stdin). **Never file another product's work here**, nor PressPlay's anywhere
  else: each product's queue builds that product.

  **File at High or below.** Urgent is Dane's own lane: the queue sorts
  priority-then-age, so an Urgent flag is a human override, and that only
  works if agents never set it. `task --priority urgent` refuses unless
  `--operator-asked` is also passed, which is your written claim that he asked.

## Workflow

1. **Interview until confident.** Ask Dane focused questions — a few at a
   time, plain language — until you understand the goal well enough to write
   tasks a fresh agent could build with no further context. Cover: what "done"
   looks like, which screens/files are in scope, what is explicitly NOT in
   scope, how a human would verify it. Keep asking until you could hand it to
   someone who has never seen the idea.

2. **Split into small, independent tasks.** Each task must be:
   - **One PR's worth of work** — if it needs more than a few files or touches
     unrelated systems, split it.
   - **Independent** — buildable without waiting on another task, so parallel
     work does not collide. If two tasks must touch the same file, merge them
     or state the ordering explicitly in both descriptions.
   - **Reviewable by a human in a couple of minutes.**

3. **Write each task.** `status: Queued`, **no assignee** (assignment is how
   the loops hand a ticket to Dane), and a description in exactly this shape.

   **The description is the LEFT column, and it is where the detail goes.**
   The right-hand comment column is narrow; it carries only the operator card.

   **Never use a `> ` blockquote anywhere in a ClickUp body.** ClickUp deletes
   those lines silently, from descriptions and comments alike, and the write
   still returns a clean 200. Use a fenced block. The script refuses them.

   ````
   ## Goal
   One or two sentences: what this task does about it.

   ## Scope
   - Bullet list of what this task changes.

   ## Non-goals
   - What this task must NOT touch (prevents scope creep in the build loop).

   ## Affected files / artifacts
   - Source files likely involved — real paths, checked, not guessed.

   ## Acceptance criteria
   - [ ] Concrete, checkable outcomes. The build loop is done when all are met.
   - [ ] Spirality's standing rules where they apply: nothing project-specific
         hard-coded (ids, names, paths and phrases come from the project
         config); StarCaster's modules move with their tests, never rewritten;
         every ClickUp write is read back; a failed step says so.

   ## How to test
   - Steps **Dane** can follow. Every step is one of exactly two things:
       1. **a link he can click**, or
       2. **an exact command to copy and paste**, with the output it should
          print written next to it.
     "Open the page in a browser" is not a step.

   ## Risk
   low | medium | high — and one line on the blast radius.
   ````

   **The task NAME says in plain words what breaks and who feels it**, or what
   Dane will be able to do once it ships. He scans a list; the clever
   diagnostic sentence goes in the description. Good: *"Dane cannot sign in
   yet: add sign-in and per-user data protection"*. Not: *"Auth: wire Supabase
   session middleware"*.

   Tag each task with the epic name so the queue stays legible.

   To rewrite an existing task's description:
   `npm run clickup -- describe --task <id> --body-file -` (it REPLACES the
   whole left column and reads the result back).

4. **Report back.** List the tasks you filed (name + risk + one-line goal) and
   the total. Then say what the build loop is actually doing — **never tell
   Dane to start one without checking**. PressPlay's lanes run on the
   Mini (`com.pressplay.loop-build` and the rest:
   `scripts/install_loop_runner.sh --status`), so never tell him to start a
   build or review loop by hand while they are loaded, because claiming a
   ticket is check-then-act.

## Never say something is waiting on Dane without checking

```bash
npm run clickup -- waiting                    # what actually needs him
npm run clickup -- waiting --task <id>        # one ticket: status, assignee, last word, verdict
```

Read-only, exit **0** nothing of his / **3** something IS his / **1** could not
tell. A ticket he has already answered must never be handed back to him twice.

## The operator card — the only thing that goes in the right column

Anything a loop puts in front of Dane goes through **one** command, which
posts the card and moves the status together:

```bash
npm run clickup -- ask --task <id> --status "Needs your input" --body-file -
```

```
@@ASKED
his own words that caused this ticket, verbatim — never invented
@@WHEN
2026-10-11 9:40am, in the planning session   (optional)
@@CONTEXT
The problem and the fix in plain English. 50-100 words, enforced.
@@NEEDED
The specific ask. "Nothing right now" is a good answer, but write it down.
Your move: Reply — a short reason   (Merge / Close / Reply; required, last line)
@@EVIDENCE
Only when the ask costs money or cannot be undone: the command, its ACTUAL
output in a ``` fence, and one line "@@MEASURED 8:04pm" (Mountain time).
```

`@@NEEDED` renders under a red banner, **NEEDED FROM DANE:**, last on the card.

## Evidence, or it is a question

A **defect ticket must cite its mechanism**: the file and function (or line)
of the code it claims is wrong, quoted — not the log line that prompted the
suspicion. If you cannot cite it, you have a suspicion, not a defect: file it
as a QUESTION (a ticket that asks, in its name) and let the builder's first
step be reading the code. A threshold or trade-off names its measurement, or
says plainly "not measured".

## Guardrails

- **Prefer low-risk tasks first** when ordering a new queue, so the loop earns
  trust before touching anything that holds data or keys.
- **Flag anything that can't be a clean small PR.** Propose how to slice it.
- Never file a task whose acceptance criteria you couldn't verify yourself.
- **Read your own "How to test" back as Dane.** A step he cannot act on
  without asking a follow-up question is not a test step.
- **A pipeline ticket needs a COST, not a gap.** File a ticket about the loop
  machinery itself only when a failure actually cost something observable.
  Otherwise it is one plain line in your report, not a ticket.

## First-time setup

(ClickUp products only; the tracker carries the statuses itself, eight of
them, `Requested` first: a request Dane filed from the tracker page that
nobody has specced yet. ClickUp lists never carry `Requested`.) If a
ClickUp "Loop Queue" list does not carry the seven statuses yet,
point Dane at `docs/CLICKUP_SETUP.md` — ClickUp's API cannot edit a list's
status set, so that is a click-by-click step in the ClickUp web app. The loops
key off these exact names, matched case-insensitively:
`Rework, Queued, Building, In review, Needs your input, Ready to launch, Live`.
`Live` must be a **closed**-type status.
