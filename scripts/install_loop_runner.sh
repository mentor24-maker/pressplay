#!/bin/bash
#
# Install (or remove) the Spirality loop jobs on THIS machine: loop-build,
# loop-review and loop-intake (each a launchd agent that keeps the committed
# runner alive, with its own lock and log),
# the relay (a launchd agent that runs one pass every ten minutes) and, when
# the project config names a trackerPort, the tracker (a kept-alive web
# server, docs/TRACKER_MVP.md) with its nightly database backup.
#
#   ./scripts/install_loop_runner.sh              # install them all here
#   ./scripts/install_loop_runner.sh --status     # installed? running? locks? last pass?
#   ./scripts/install_loop_runner.sh --uninstall  # remove them all from here
#
# Copied from StarCaster's installer. launchd starts a job at load, restarts a
# kept-alive one if it dies, and survives a reboot; a screen session does none
# of that. Labels are <launchdPrefix>.<job>, read from the project config, so
# a product's jobs sit beside another product's on the same machine without
# touching them.
#
# Every path is derived from where this script lives or read from the project
# config, never typed in.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The lanes that run a Claude skill in a kept-alive loop, and the relay,
# which is a plain node pass on a timer. Different plist shapes, one installer.
SKILLS=(loop-build loop-review loop-intake)
RELAY=relay
TRACKER=tracker
BACKUP=tracker-backup
# When the nightly backup runs, in the machine's own time zone.
BACKUP_HOUR=3
BACKUP_MINUTE=15

# The PATH launchd gives the jobs. The installer checks the tools against
# THIS, not its own shell's PATH, because launchd is what will run them.
LAUNCHD_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin"

# The product's values: the label prefix, the log folder and the short name
# every log and lock file starts with (CLAUDE.md engineering rule 2).
config_value() { PATH="$LAUNCHD_PATH" node "$REPO/scripts/project_config.mjs" "$1"; }
PREFIX="$(config_value launchdPrefix)"
LOG_DIR="$(config_value logDir)"
SLUG="$(config_value productSlug)"
# The tracker's settings. An empty port means this product runs no tracker
# service here, and every tracker step below is skipped.
TRACKER_PORT="$(config_value trackerPort)"
TRACKER_HOST="$(config_value trackerHost)"
TRACKER_DATA_DIR="$(config_value trackerDataDir)"
TRACKER_DB="$TRACKER_DATA_DIR/tracker.db"
TRACKER_BACKUP_DIR="$TRACKER_DATA_DIR/backups"
tracker_configured() { [ -n "$TRACKER_PORT" ]; }

interval_of() {
  case "$1" in
    loop-build)  echo 1800 ;;
    loop-review) echo 1800 ;;
    loop-intake) echo 1800 ;;
    relay)       echo 600 ;;
    *)           echo 3600 ;;
  esac
}
# loaded_line and reload_job: read launchd's list safely, and replace a job
# only once the old one is really gone.
# shellcheck source=lib/launchd_reload.sh
source "$REPO/scripts/lib/launchd_reload.sh"

label_of() { echo "$PREFIX.$1"; }
plist_of() { echo "$HOME/Library/LaunchAgents/$(label_of "$1").plist"; }
log_of() { echo "$LOG_DIR/$SLUG-$1.log"; }
lock_of() { echo "$LOG_DIR/$SLUG-$1.lock"; }

status_one() {
  local job="$1" label plist lock log line
  label="$(label_of "$job")"; plist="$(plist_of "$job")"
  lock="$(lock_of "$job")"; log="$(log_of "$job")"
  echo "── $job"
  if [ -f "$plist" ]; then echo "schedule: INSTALLED at $plist"; else echo "schedule: not installed on this machine"; fi
  line="$(loaded_line "$label")"
  if [ -n "$line" ]; then
    echo "loaded:   yes — $line"
    if [ "$job" = "$RELAY" ]; then
      echo "          (columns: PID, last exit code, label. '-' for PID means not running right now, which is normal between passes; it wakes every $(( $(interval_of "$job") / 60 )) minutes.)"
    else
      echo "          (columns: PID, last exit code, label. A PID here means the runner is alive right now.)"
    fi
  else
    echo "loaded:   no"
  fi
  if [ -d "$lock" ]; then
    local pid; pid="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "lock:     held by live pid $pid — a pass is working"
    else echo "lock:     STALE (pid ${pid:-unrecorded} is gone) — the next start clears it"; fi
  else
    echo "lock:     none"
  fi
  if [ -f "$log" ]; then
    echo "log:      $log (last modified $(date -r "$log" '+%Y-%m-%d %H:%M'))"
    if [ "$job" = "$RELAY" ]; then
      echo "last pass: $(grep -E "START relay" "$log" | tail -1 | sed 's/=//g' | xargs || echo '(none yet)')"
      echo "last end:  $(grep -E "END relay" "$log" | tail -1 | sed 's/=//g' | xargs || echo '(none yet)')"
    else
      echo "last pass: $(grep -E "START /$job" "$log" | tail -1 | sed 's/=//g' | xargs || echo '(none yet)')"
    fi
  else
    echo "log:      $log (nothing written yet)"
  fi
}

# The runners only pull when the checkout is a clean main. On anything else
# every pass runs stale code and says so in one quiet log line, so say it
# loudly here instead.
checkout_state() {
  local branch dirty
  branch="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  dirty="$(git -C "$REPO" status --porcelain 2>/dev/null)"
  if [ "$branch" = "main" ] && [ -z "$dirty" ]; then
    echo "checkout: $REPO on a clean main — each pass pulls the latest merged work"
  else
    echo "checkout: $REPO on branch '$branch'$([ -n "$dirty" ] && echo ', with uncommitted changes')"
    echo "WARNING:  the runners only pull a clean main, so every pass runs THIS code and never"
    echo "          picks up merged work. Put it back: git -C $REPO checkout main && git -C $REPO pull"
  fi
}

# The address to knock on: the configured host, or this machine itself when
# the server listens on every address.
tracker_url() {
  local host="$TRACKER_HOST"
  if [ "$host" = "0.0.0.0" ]; then host=127.0.0.1; fi
  echo "http://$host:$TRACKER_PORT"
}

status_job_header() {
  local job="$1" label plist line
  label="$(label_of "$job")"; plist="$(plist_of "$job")"
  echo "── $job"
  if [ -f "$plist" ]; then echo "schedule: INSTALLED at $plist"; else echo "schedule: not installed on this machine"; fi
  line="$(loaded_line "$label")"
  if [ -n "$line" ]; then echo "loaded:   yes — $line"; else echo "loaded:   no"; fi
}

status_tracker() {
  local log code newest
  if ! tracker_configured; then
    echo "── $TRACKER"
    echo "tracker:  not run by this product (no trackerPort in the project config)"
    return
  fi
  status_job_header "$TRACKER"
  echo "          (columns: PID, last exit code, label. A PID here means the server is up right now.)"
  # /me without a token answers 401: the tracker's own answer to a knock with
  # no key. Silence, or any other answer, means it is not the tracker there.
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$(tracker_url)/me" 2>/dev/null || true)"
  if [ "$code" = "401" ]; then
    echo "answers:  yes — $(tracker_url) (listening on $TRACKER_HOST:$TRACKER_PORT)"
  else
    echo "answers:  NO — nothing answered at $(tracker_url)${code:+ (got HTTP $code)}"
  fi
  if [ -f "$TRACKER_DB" ]; then echo "database: $TRACKER_DB ($(du -h "$TRACKER_DB" | cut -f1 | xargs))"
  else echo "database: $TRACKER_DB (not created yet; the server makes it on first start)"; fi
  log="$(log_of "$TRACKER")"
  if [ -f "$log" ]; then echo "log:      $log (last modified $(date -r "$log" '+%Y-%m-%d %H:%M'))"
  else echo "log:      $log (nothing written yet)"; fi

  status_job_header "$BACKUP"
  echo "          (runs nightly at $(printf '%02d:%02d' "$BACKUP_HOUR" "$BACKUP_MINUTE"); '-' for PID is normal between runs.)"
  newest="$(ls -1 "$TRACKER_BACKUP_DIR"/tracker-*.db 2>/dev/null | tail -1 || true)"
  if [ -n "$newest" ]; then
    echo "backups:  $(ls -1 "$TRACKER_BACKUP_DIR"/tracker-*.db | wc -l | xargs) in $TRACKER_BACKUP_DIR, newest $(basename "$newest")"
  else
    echo "backups:  none yet in $TRACKER_BACKUP_DIR"
  fi
  log="$(log_of "$BACKUP")"
  if [ -f "$log" ]; then echo "last run: $(grep -E 'backup (OK|FAILED)' "$log" | tail -1 || echo '(none yet)')"
  else echo "last run: (none yet)"; fi
}

status() {
  echo "product:  $SLUG (labels $PREFIX.*, logs in $LOG_DIR)"
  checkout_state
  PATH="$LAUNCHD_PATH" node "$REPO/scripts/lib/claudeTrust.mjs" check "$REPO" || true
  for s in "${SKILLS[@]}"; do status_one "$s"; done
  status_one "$RELAY"
  status_tracker
}

# The tracker server (kept alive, like the lanes) and its nightly backup (on
# a calendar, like nothing else here). Appends to not_loaded on failure.
install_tracker() {
  local node label plist log
  node="$(PATH="$LAUNCHD_PATH" command -v node)"
  mkdir -p "$TRACKER_DATA_DIR" "$TRACKER_BACKUP_DIR"

  label="$(label_of "$TRACKER")"; plist="$(plist_of "$TRACKER")"; log="$(log_of "$TRACKER")"
  cat > "$plist" <<PLIST_BODY
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$node</string>
        <string>--disable-warning=ExperimentalWarning</string>
        <string>$REPO/tracker/server.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO</string>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
$(plist_env TRACKER_DB "$TRACKER_DB" TRACKER_PORT "$TRACKER_PORT" TRACKER_HOST "$TRACKER_HOST")
    <key>StandardOutPath</key>
    <string>$log</string>
    <key>StandardErrorPath</key>
    <string>$log</string>
</dict>
</plist>
PLIST_BODY
  if reload_job "$label" "$plist"; then
    echo "Installed $label — kept alive, listening on $TRACKER_HOST:$TRACKER_PORT, database $TRACKER_DB, log $log."
  else
    not_loaded+=("$label")
  fi

  label="$(label_of "$BACKUP")"; plist="$(plist_of "$BACKUP")"; log="$(log_of "$BACKUP")"
  cat > "$plist" <<PLIST_BODY
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$node</string>
        <string>--disable-warning=ExperimentalWarning</string>
        <string>$REPO/tracker/backup.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>$BACKUP_HOUR</integer>
        <key>Minute</key>
        <integer>$BACKUP_MINUTE</integer>
    </dict>
$(plist_env TRACKER_DB "$TRACKER_DB" TRACKER_BACKUP_DIR "$TRACKER_BACKUP_DIR")
    <key>StandardOutPath</key>
    <string>$log</string>
    <key>StandardErrorPath</key>
    <string>$log</string>
</dict>
</plist>
PLIST_BODY
  if reload_job "$label" "$plist"; then
    echo "Installed $label — nightly at $(printf '%02d:%02d' "$BACKUP_HOUR" "$BACKUP_MINUTE") into $TRACKER_BACKUP_DIR (newest 14 kept), log $log."
  else
    not_loaded+=("$label")
  fi
}

uninstall() {
  # The tracker jobs are removed whether or not the config still names them;
  # their database and backups are left where they are.
  for s in "${SKILLS[@]}" "$RELAY" "$TRACKER" "$BACKUP"; do
    launchctl bootout "gui/$(id -u)/$(label_of "$s")" 2>/dev/null || true
    rm -f "$(plist_of "$s")"
    echo "Removed $(label_of "$s") from this machine."
  done
  echo "Locks are left for the runners' own stale-lock handling. Confirm with: $0 --status"
  if [ -n "$TRACKER_DATA_DIR" ]; then echo "The tracker's database and backups are left in $TRACKER_DATA_DIR."; fi
}

# plist_env [NAME VALUE]...: the environment block, PATH and HOME plus any
# extra pairs given.
plist_env() {
  echo "    <key>EnvironmentVariables</key>"
  echo "    <dict>"
  printf '        <key>%s</key>\n        <string>%s</string>\n' PATH "$LAUNCHD_PATH" HOME "$HOME" "$@"
  echo "    </dict>"
}

install() {
  if [ -f "$REPO/.git" ] && grep -q '^gitdir:.*worktrees' "$REPO/.git" 2>/dev/null; then
    echo "Refusing to install: $REPO is a worktree, and worktrees get deleted when their work ships. Run this from the main checkout." >&2
    exit 1
  fi
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$LOG_DIR"
  for bin in npm node doppler claude git gh; do
    if ! (PATH="$LAUNCHD_PATH" command -v "$bin" >/dev/null); then
      echo "Cannot find $bin on launchd's PATH ($LAUNCHD_PATH) — the jobs would install and then fail on every pass." >&2
      exit 1
    fi
  done
  if tracker_configured && [ -z "$TRACKER_DATA_DIR" ]; then
    echo "Refusing to install: the project config names trackerPort but no trackerDataDir, so the tracker has nowhere to keep its database." >&2
    exit 1
  fi
  if [ "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" != "main" ]; then
    echo "WARNING: $REPO is not on main. The jobs will install, but they never pull" >&2
    echo "         anything but a clean main, so they will run this branch's code until" >&2
    echo "         the checkout is put back on main." >&2
  fi
  chmod +x "$REPO/scripts/loop_runner.sh" "$REPO/scripts/run_with_time_limit.sh" "$REPO/scripts/run_relay.sh"

  # Jobs that could not be loaded. Every job is still tried; the list decides
  # the exit code at the end.
  not_loaded=()

  # Trust this checkout in Claude's own settings before any lane starts, or
  # every headless pass ignores the product's .claude/settings.json allow list
  # until somebody opens Claude here by hand (SP-116). A failure is said and
  # fails the run at the end, but the lanes still install: they run, only
  # without that list.
  trust_failed=""
  PATH="$LAUNCHD_PATH" node "$REPO/scripts/lib/claudeTrust.mjs" ensure "$REPO" || trust_failed=yes

  # The kept-alive lanes: the runner script loops forever, launchd restarts it.
  for s in "${SKILLS[@]}"; do
    local_label="$(label_of "$s")"; local_plist="$(plist_of "$s")"
    local_llog="$HOME/Library/Logs/$local_label.launchd.log"
    cat > "$local_plist" <<PLIST_BODY
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$local_label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$REPO/scripts/loop_runner.sh</string>
        <string>$s</string>
        <string>$(interval_of "$s")</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO</string>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>300</integer>
$(plist_env)
    <key>StandardOutPath</key>
    <string>$local_llog</string>
    <key>StandardErrorPath</key>
    <string>$local_llog</string>
</dict>
</plist>
PLIST_BODY
    if reload_job "$local_label" "$local_plist"; then
      echo "Installed $local_label — kept alive from $REPO (every $(interval_of "$s")s)."
    else
      not_loaded+=("$local_label")
    fi
  done

  # The relay: one pass per wake, on a timer. Its own output IS its log, so the
  # plist points stdout and stderr at the log the status reader looks for.
  local_label="$(label_of "$RELAY")"; local_plist="$(plist_of "$RELAY")"; local_rlog="$(log_of "$RELAY")"
  cat > "$local_plist" <<PLIST_BODY
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$local_label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$REPO/scripts/run_relay.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO</string>
    <key>StartInterval</key>
    <integer>$(interval_of "$RELAY")</integer>
    <key>RunAtLoad</key>
    <true/>
$(plist_env)
    <key>StandardOutPath</key>
    <string>$local_rlog</string>
    <key>StandardErrorPath</key>
    <string>$local_rlog</string>
</dict>
</plist>
PLIST_BODY
  if reload_job "$local_label" "$local_plist"; then
    echo "Installed $local_label — one pass every $(( $(interval_of "$RELAY") / 60 )) minutes from $REPO, log $local_rlog."
  else
    not_loaded+=("$local_label")
  fi

  if tracker_configured; then install_tracker; else echo "Skipped the tracker: this product's config names no trackerPort."; fi
  echo
  status

  # One job failing to load does not stop the others from being tried, but the
  # run as a whole fails and says which (CLAUDE.md engineering rule 6).
  if [ "${#not_loaded[@]}" -gt 0 ]; then
    echo >&2
    echo "FAILED: ${#not_loaded[@]} job(s) are NOT loaded on this machine: ${not_loaded[*]}" >&2
    echo "        Run this installer again; if it fails the same way, check $0 --status." >&2
    exit 1
  fi
  if [ -n "$trust_failed" ]; then
    echo >&2
    echo "FAILED: $REPO is not marked trusted in Claude's settings (the FAILED: trust line above says why)." >&2
    echo "        The lanes are installed and run, but ignore .claude/settings.json's allow list until it is." >&2
    exit 1
  fi
}

case "${1:-}" in
  --uninstall|--remove) uninstall ;;
  --status)             status ;;
  ""|--install)         install ;;
  *) echo "usage: $0 [--install | --uninstall | --status]" >&2; exit 2 ;;
esac
