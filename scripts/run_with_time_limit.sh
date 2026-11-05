#!/bin/bash
# Run a command with a hard time limit. Exit 124 if it was stopped.
#
#   run_with_time_limit.sh <seconds> -- <command...>
#
# A pass that freezes would otherwise hold its lane forever (StarCaster,
# 2026-09-12: one sat idle for eleven hours and nothing was built overnight).
# macOS ships no `timeout`, so this is the portable version.
#
# WHAT IT WAS DOING: before stopping anything it writes the process tree under
# the command to stdout — and, when RUN_WITH_TIME_LIMIT_SNAPSHOT names a file,
# to that file too, one line per process: depth<TAB>pid<TAB>running-for<TAB>
# command. A pass prints its report only at the end, so a stuck gate used to
# look exactly like a dead machine (StarCaster, 2026-10-04: five passes in a
# row stopped while re-running one 8-minute check). loop_runner.sh hands the
# file to `clickup pass-timeout`, which lib/passTimeout.js turns into words.
set -u
LIMIT=${1:?usage: run_with_time_limit.sh <seconds> -- <command...>}
shift
[ "$1" = "--" ] && shift
[ $# -gt 0 ] || { echo "run_with_time_limit: no command given" >&2; exit 2; }
if ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || [ "$LIMIT" -lt 1 ]; then
  echo "run_with_time_limit: limit must be a whole number of seconds, got '$LIMIT'" >&2; exit 2
fi
POLL=${RUN_WITH_TIME_LIMIT_POLL:-15}
GRACE=${RUN_WITH_TIME_LIMIT_GRACE:-30}
"$@" &
PID=$!
START=$(date +%s)
# Stop the WHOLE tree, not just direct children: a hung `next build` started
# through Claude's Bash tool is a grandchild or deeper. The tree is listed
# before anything is killed, because a killed parent's children are re-parented
# and could no longer be found by walking down from it.
tree() { local p; for p in $(pgrep -P "$1" 2>/dev/null); do tree "$p"; done; echo "$1"; }
# The same tree with depth, age and command, shallowest first, for the report
# and the snapshot file. Walked from the ps table in one pass rather than by
# repeated pgrep calls, because it runs while the tree is still alive.
snapshot() {
  ps -A -o pid=,ppid=,etime=,command= 2>/dev/null | awk -v root="$PID" '
    { pid = $1; ppid = $2; et = $3; $1 = ""; $2 = ""; $3 = ""; sub(/^ +/, "")
      n++; order[n] = pid; parent[pid] = ppid; elapsed[pid] = et; cmd[pid] = $0 }
    END {
      depth[root] = 0; queue[1] = root; head = 1; tail = 1
      while (head <= tail) {
        p = queue[head++]
        for (i = 1; i <= n; i++) {
          c = order[i]
          if (parent[c] == p && !(c in depth)) {
            depth[c] = depth[p] + 1; queue[++tail] = c
            printf "%d\t%s\t%s\t%s\n", depth[c], c, elapsed[c], substr(cmd[c], 1, 400)
          }
        }
      }
    }'
}
stop() { local pids; pids="$(tree "$PID")"; kill "-$1" $pids 2>/dev/null; }
while kill -0 "$PID" 2>/dev/null; do
  if [ $(( $(date +%s) - START )) -ge "$LIMIT" ]; then
    echo "[run_with_time_limit] $(date "+%Y-%m-%d %H:%M:%S") stopped after ${LIMIT}s — still running at the limit, which a working pass never reaches: $*"
    TREE="$(snapshot)"
    if [ -n "$TREE" ]; then
      echo "[run_with_time_limit] what was running under it (depth, pid, running for, command):"
      printf '%s\n' "$TREE" | sed 's/^/    /'
    else
      echo "[run_with_time_limit] nothing was running under it — the command itself had gone quiet."
    fi
    if [ -n "${RUN_WITH_TIME_LIMIT_SNAPSHOT:-}" ]; then
      printf '%s\n' "$TREE" > "$RUN_WITH_TIME_LIMIT_SNAPSHOT" 2>/dev/null \
        || echo "[run_with_time_limit] could not write the snapshot to $RUN_WITH_TIME_LIMIT_SNAPSHOT"
    fi
    stop TERM
    WAITED=0
    while kill -0 "$PID" 2>/dev/null && [ "$WAITED" -lt "$GRACE" ]; do sleep 1; WAITED=$((WAITED + 1)); done
    if kill -0 "$PID" 2>/dev/null; then echo "[run_with_time_limit] it ignored the stop request for ${GRACE}s — forcing it."; stop KILL; fi
    wait "$PID" 2>/dev/null
    exit 124
  fi
  sleep "$POLL"
done
wait "$PID"
