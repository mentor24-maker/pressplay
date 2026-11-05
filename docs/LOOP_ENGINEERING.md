# Loop Engineering on PressPlay

How PressPlay is built: a **spec → build → review** loop, the one
[Spirality](https://github.com/mentor24-maker/spirality) defines and runs for
every product, pointed at PressPlay's own queue on the tracker. Dane specs work
in plain language; agent sessions build it into pull requests and
independently review them; Dane merges. Nothing reaches `main` without a
passing CI check and his word.

This file was written for PressPlay by Spirality's setup wizard at
Spirality commit `521bb9a`, from the product guide PressPlay's setup
produced. The rules are Spirality's; where one was learned the hard way,
Spirality's copy and its contract,
[`docs/LOOP_CONTRACT.md`](https://github.com/mentor24-maker/spirality/blob/main/docs/LOOP_CONTRACT.md),
have the history. A change to how the loop works is made in Spirality first.

## The three steps

| Step | Skill | Who runs it | What it does |
|---|---|---|---|
| 1 | `loop-spec` | a session, with Dane | interviews him, files small tasks with acceptance criteria and test steps |
| 1 | `loop-intake` | a loop | takes the oldest request he filed from the tracker page (`Requested`), writes it up in `loop-spec`'s shape with his words kept verbatim, slices it if it is more than one PR, and hands each ticket to him (`Needs your input`); his "go" queues it |
| 2 | `loop-build` | a loop | claims the next task, builds it in its own worktree, passes `npm run build`, opens a PR, hands it to review |
| 3 | `loop-review` | a loop | independently re-verifies the PR, then hands it to Dane (`Ready to launch`) or back to build (`Rework`) |

The skills live in `.claude/skills/`; Claude Code discovers them nowhere else.

## Where PressPlay's tickets are

PressPlay's tickets are the **PressPlay** project on **the tracker**, the ticket
system that runs on the Mac Mini (http://mac-mini.local:4180, ids like
`PP-12`). Every ticket touch goes through **`npm run clickup -- <command>`**
(the name stayed from ClickUp days; it talks to whichever tracker
`spirality.project.json` names). The command is Spirality's ticket door,
copied into `loop/` and wrapped in Doppler (project `pressplay`), so the token is
supplied without any agent or human handling it. `loop/` is never edited
here: a change is made in Spirality and copied in (`loop/README.md`).

On the Mini the door reaches the tracker at `127.0.0.1`. Anywhere else, put
`TRACKER_API_URL=http://mac-mini.local:4180` in front of each command.

The everyday commands (`npm run clickup` bare prints the full list):

```bash
npm run clickup -- whoami                                       # proves the token works; says who it acts as
npm run clickup -- queue --claimable                            # first line = the task loop-build should claim
npm run clickup -- queue --status "In review"                   # first line = the task loop-review should take
npm run clickup -- get --task <id>                              # header + body, recorded PR, send-back count
npm run clickup -- comments --task <id>                         # the comments, oldest first, Mountain time
npm run clickup -- waiting [--task <id>]                        # is this ACTUALLY waiting on Dane? exit 0 no / 3 yes
npm run clickup -- task --name "..." --status Queued --priority high --tags epic --body-file -   # file a ticket
npm run clickup -- claim --task <id>                            # loop-build's atomic claim
npm run clickup -- status --task <id> --status "In review"      # a machine-status move; assignees auto-cleared
npm run clickup -- ask --task <id> --status "Needs your input" --body-file -   # hand it to Dane: card + status + assignment
npm run clickup -- pr-opened --task <id> --pr <pr-url>          # record the PR (required; verifies both directions)
npm run clickup -- verdict --task <id> --pass|--fail --if-status "In review" --body-file -   # the review verdict
npm run clickup -- describe --task <id> --body-file -           # REPLACE the description (left column)
npm run clickup -- comment --task <id> --body-file -            # a plain note
npm run clickup -- tag --task <id> --add wont-do                # kill or park (see below)
npm run clickup -- relay [--dry-run]                            # act on Dane's merge phrase and his answers
npm run doctor                                                  # every expected key in Doppler; tracker and repo agree
```

Every write reads itself back, and a step that fails says so. The script
refuses a `> ` blockquote before sending.

**Who it signs in as.** Each loop lane has its own sign-in (`loop-build`,
`loop-review`, `loop-intake`, `relay`, each a `TRACKER_TOKEN_*` key in
Doppler). A session started by hand signs in as `hand-run`, never as Dane.

## The eight statuses — and the two that are yours

| Status | What it means | Whose move |
|---|---|---|
| `Requested` | you asked for it from the tracker page; nobody has specced it yet | machine (spec pass) |
| `Rework` | review sent it back — a branch and a PR already exist | machine |
| `Queued` | waiting for a build loop to pick it up | machine |
| `Building` | a loop is writing the code | machine |
| `In review` | a loop is checking that code against the task | machine |
| **`Needs your input`** | stuck — a question or decision only you can settle | **yours** |
| **`Ready to launch`** | built and independently verified, waiting for your go | **yours** |
| `Live` | merged and shipped — closed, out of your open view | — |

The two human statuses ask different things. `Needs your input` wants an
**answer**: a loop stopped and wrote you a plain-language question. `Ready to
launch` wants a **yes**: nothing is wrong, it is finished and waiting on the
merge only you authorize. On a normal day you can ignore the other six.

**`Requested` exists** so you can file work from the tracker page
("New request" in its header, or http://mac-mini.local:4180/new) without
opening Claude Code, and so the build loop never builds from your unspecced
words: no loop claims a `Requested` ticket, and a spec pass turns it into
`Queued` tickets for you to approve.

**`Rework` exists** so a half-built ticket is never mistaken for one nobody
has started. loop-build drains every `Rework` ticket before any `Queued` one,
oldest first, priority ignored: priority says what to *start*; rework is not
started, it is finished.

Two rules keep it honest:

- **No loop ever puts a ticket into `Live`.** Only a merge does, and only you
  authorize a merge.
- **No loop ever takes a ticket out of `Needs your input` or `Ready to
  launch`.** Once handed to you it stays yours until you act. Your merge
  phrase on a `Ready to launch` ticket is you acting: the relay reads it,
  re-checks every gate, merges and moves the ticket. Your reply to the
  question card on a `Needs your input` ticket is you acting too: the same
  relay moves the ticket to `Queued`, `Rework` or `Live` by the contract's
  table, and notes on your reply that it did.

### Assignment is the handoff

Your "what needs me" is the tracker's **Waiting on you** page. Loops assign
you when a ticket enters one of your two statuses and clear assignees when it
returns to a machine status; the `status` command enforces both and verifies
they stuck. A ticket in a machine status with you still assigned is a bug.

### The operator card

Anything a loop puts in front of you arrives as one comment in a fixed shape,
posted by `ask` together with the status move so the two can never come apart:
your own words that caused the ticket (in a fence, verbatim), what's going on
in 50-100 plain words, and the ask under a red **NEEDED FROM DANE:** banner,
last on the card. An ask that spends money or cannot be undone must carry the
command that proves it, its real output, and when it was run.

Detail goes in the **description** (left, wide); the card is the only thing in
the **comments** (right, narrow).

### Killing and parking a ticket

There is no `Won't do` status. A ticket you decide against closes as `Live`
plus the **`wont-do`** tag and a comment saying nothing shipped. A ticket that
is real but not worth a queue slot right now closes as `Live` plus the
**`deferred`** tag, keeping its description and comments; reviving it is
setting the status back to `Queued`.

### Titles

A ticket's name says in plain words **what breaks and who feels it**, or what
you will be able to do once it ships. The diagnostic sentence goes in the
description.

## The two traces a ticket must carry

- **`PR opened: <url>`** — written by `pr-opened`, which first checks that the
  PR body links back to the ticket, then reads its own comment back with the
  same parser the review step uses.
- **`REVIEW: PASSED — …`** or **`REVIEW: sent back to Rework — …`** — written
  by `verdict`. `Ready to launch` is refused unless the newest verdict is a
  PASS, from both doors (`ask` and `status --no-card`).

A send-back counts its round. **The fourth is refused**: three send-backs
mean the spec was wrong, not the build, and the ticket goes to you with the
three reasons listed and named options (respec / split / drop).

## How to run it

**On the Mini, on a timer.** Four launchd jobs, named from `launchdPrefix` in
`spirality.project.json`, run from the main checkout at `/Users/daneofearth/WebApps/pressplay`:

| Job | What it runs | How often |
|---|---|---|
| `com.pressplay.loop-build` | a Claude pass of `loop-build` | every 30 minutes |
| `com.pressplay.loop-review` | a Claude pass of `loop-review` | every 30 minutes |
| `com.pressplay.loop-intake` | a Claude pass of `loop-intake` | every 30 minutes |
| `com.pressplay.relay` | `npm run clickup -- relay`, no Claude | every 10 minutes |

Each lane pulls a clean `main` before every pass and signs in to the tracker
as itself (`loop-build`, `loop-review`, `loop-intake`, `relay`). The scripts
are in `scripts/` (`install_loop_runner.sh`, `loop_runner.sh`, `run_relay.sh`
and their helpers), copied from Spirality (`loop/README.md`).

```bash
/Users/daneofearth/WebApps/pressplay/scripts/install_loop_runner.sh --status     # loaded? running? last pass?
/Users/daneofearth/WebApps/pressplay/scripts/install_loop_runner.sh              # install, or reinstall after a change
/Users/daneofearth/WebApps/pressplay/scripts/install_loop_runner.sh --uninstall  # remove all four
```

The question is never "shall I start one", it is "what is it doing": each
lane writes its log to `~/loop-logs/pressplay-<lane>.log` on the Mini, and
nobody starts a loop by hand while they are loaded. Install from an agent
session, never from inside one of the lanes: the installer reloads the job it
would be running in.

Your day:

1. **Morning:** run `loop-spec` in a session, answer its questions, approve
   the task list.
2. **During the day:** the loops build and review. Each `Ready to launch`
   ticket lands in *Waiting on you* with a link or a command and test steps.
3. **When you're ready:** comment **`merge`** (or `merge it`, `ship it`, `approve`) on the ticket, the whole comment and nothing else. The relay
   merges it, only with the `verify` check green, then sets the ticket
   `Live`. "merge PR #N" is not a phrase and does nothing.
4. **When a ticket asks you a question** (`Needs your input`): answer as a
   comment on the ticket; the relay moves it on.

### What the `verify` gate is

`npm run build` is the definition of done. CI's `verify` check runs it on
every pull request, then the copied loop tests (`npm run test:loop`), and
`main` cannot merge without it green. The build loop runs it before opening
a PR; the review loop runs it again.

A new kind of check is added to `npm run build`, and every lane inherits
it at once.

### Safety — why this is wired the way it is

- `main` is what ships. A hook refuses edits on `main`
  (`scripts/hooks/block_edits_on_main.cjs`, wired in `.claude/settings.json`);
  every change is a branch, a PR and a green check, and GitHub's branch
  protection refuses anything else.
- No loop merges on its own judgement. Ever. `Ready to launch` is a request,
  not an action; only your exact merge phrase releases it, and the relay that
  carries it out is your hands, not a decision-maker.
- Every write to the tracker is verified by reading it back.
- Urgent priority is yours alone; the script refuses to set it without a
  written claim that you asked.
- This repository is public. The review loop greps every diff for anything
  that looks like a key.

## The work log

`docs/work-log/` is a plain-English record, one file per merged PR, named
`<YYYY-MM-DD>-<branch>.md` and written inside the PR it describes. One file
per entry means two PRs built at the same time never conflict on the log.
`ls -r docs/work-log` lists it newest first. The log is for you, not for the
machine.

## Cost

A loop is an agent running continuously, so it spends tokens whether the
output is good or not. Start with one build loop on small, self-checking
work, confirm the value, then widen.
