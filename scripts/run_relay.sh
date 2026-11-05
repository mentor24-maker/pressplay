#!/bin/bash
#
# What the relay schedule (every 10 minutes) actually runs: bring the main
# checkout up to date, then one `relay` pass of the ClickUp door.
#
#   ./scripts/run_relay.sh            # one pass, output to stdout
#   ./scripts/run_relay.sh --dry-run  # one pass that prints and writes nothing
#
# Same shape as StarCaster's scripts/run_bus_relay.sh with the StarCaster-only
# watchdogs left out. The pull is deliberately timid — only main, only a clean
# tree, only fast-forward — and never blocks the pass: a refusal is logged and
# the relay runs on the code that is here. It takes the same sync lock the loop
# runners take around their own pull, so two lanes never pull into one
# checkout at once.
#
# Every product-specific value (the log folder, the product's short name)
# comes from the project config through scripts/project_config.mjs; nothing
# here names a product.

set -u

# launchd hands the job almost no environment. Set the PATH once, here.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

# The repo is WHERE THIS SCRIPT LIVES, and it must be the MAIN checkout: a
# worktree is deleted when its work ships, and a schedule pointing at one
# works perfectly until the day it silently does not.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$REPO/.git" ] && grep -q '^gitdir:.*worktrees' "$REPO/.git" 2>/dev/null; then
  echo "[relay] Refusing to run from a worktree ($REPO) — worktrees are deleted when their work ships." >&2
  exit 1
fi
cd "$REPO" || exit 1

SLUG="$(node "$REPO/scripts/project_config.mjs" productSlug)" || { echo "[relay] could not read productSlug from the project config" >&2; exit 1; }
LOG_DIR="$(node "$REPO/scripts/project_config.mjs" logDir)" || { echo "[relay] could not read logDir from the project config" >&2; exit 1; }
mkdir -p "$LOG_DIR"
LOCK="$LOG_DIR/$SLUG-relay.lock"
SYNC_LOCK="$LOG_DIR/$SLUG-sync.lock"
# A pass must finish inside the schedule's own interval (600s), with room to
# spare, or two passes could overlap and both decide the same ticket.
PASS_LIMIT="${RELAY_PASS_LIMIT_SECONDS:-480}"

echo ""
echo "===== $(date '+%Y-%m-%d %H:%M:%S') START relay — $REPO ====="

# One relay at a time. launchd never overlaps the same job, but a pass run by
# hand during a scheduled one would; a stale lock (its pid gone) is announced
# and taken over so a crash never leaves the relay dead behind it.
if ! mkdir "$LOCK" 2>/dev/null; then
  OLD_PID="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[relay] a relay pass is already running (pid $OLD_PID, lock: $LOCK). Not starting a second."
    exit 0
  fi
  echo "[relay] found a STALE lock (pid ${OLD_PID:-unrecorded}, no such process) — clearing it and taking over."
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || { echo "[relay] the lock could not be retaken. Stopping." >&2; exit 1; }
fi
echo "$$" > "$LOCK/pid"
trap 'rm -rf "$LOCK" 2>/dev/null; [ "$(cat "$SYNC_LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$SYNC_LOCK"' EXIT

# The timid pull, under the loops' sync lock. Wait up to two minutes for the
# other lane; a lock whose pid is gone is cleared.
take_sync_lock() {
  local waited=0 holder
  until mkdir "$SYNC_LOCK" 2>/dev/null; do
    holder="$(cat "$SYNC_LOCK/pid" 2>/dev/null || true)"
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$SYNC_LOCK"; continue; fi
    [ "$waited" -ge 120 ] && return 1
    sleep 5; waited=$((waited + 5))
  done
  echo "$$" > "$SYNC_LOCK/pid"
}
# A checkout left on a branch that has merged and gone from origin (a new
# product's lanes run from its setup branch until it merges) goes back to main
# first, under the same lock, so the pull below can run.
# shellcheck source=lib/back_to_main.sh
source "$REPO/scripts/lib/back_to_main.sh"
if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" != "main" ] && [ -z "$(git status --porcelain)" ]; then
  if take_sync_lock; then
    MOVED="$(back_to_main_if_merged)"
    [ -n "$MOVED" ] && echo "[relay] $MOVED"
    rm -rf "$SYNC_LOCK"
  fi
fi
if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ] && [ -z "$(git status --porcelain)" ]; then
  if take_sync_lock; then
    git pull -q --ff-only origin main 2>&1 || echo "[relay] pull of main refused (see above) — running on the checkout as it is"
    rm -rf "$SYNC_LOCK"
  else
    echo "[relay] another lane held the sync lock for two minutes — not pulling this pass"
  fi
else
  echo "[relay] main checkout is not on a clean main — not pulling. Every pass runs stale code until it is put back on main."
fi

# The pass itself. Through npm, so Doppler supplies the ClickUp token the same
# way every other write to ClickUp gets it. A dry run is passed straight through.
# On the tracker, the relay signs in as itself: TRACKER_TOKEN_NAME names its
# own Doppler secret (never the value), which the door reads.
export TRACKER_TOKEN_NAME=TRACKER_TOKEN_RELAY
"$REPO/scripts/run_with_time_limit.sh" "$PASS_LIMIT" -- \
  npm run --silent clickup -- relay "$@"
status=$?

# The exit code is the pass's own verdict, and it says so in words:
#   0   the pass finished and every write read back
#   1   at least one step failed and said which (read the UNCHECKED lines above)
#   124 the pass hit its time limit and was stopped
case "$status" in
  0)   echo "===== $(date '+%Y-%m-%d %H:%M:%S') END relay — pass complete (exit 0) =====" ;;
  1)   echo "===== $(date '+%Y-%m-%d %H:%M:%S') END relay — A STEP FAILED AND SAID SO ABOVE (exit 1) =====" ;;
  124) echo "===== $(date '+%Y-%m-%d %H:%M:%S') END relay — hit the ${PASS_LIMIT}s time limit and was stopped (exit 124); its tickets are untouched or marked, never half-moved silently =====" ;;
  *)   echo "===== $(date '+%Y-%m-%d %H:%M:%S') END relay — the pass could not run (exit $status) =====" ;;
esac
exit "$status"
