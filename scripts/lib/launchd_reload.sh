# Sourced, not run: the launchd helpers install_loop_runner.sh uses, kept in
# their own file so scripts/lib/launchdReload.test.mjs can drive them against a
# fake launchctl.
#
# `launchctl bootout` returns before launchd has finished removing the old job.
# A `bootstrap` straight after it collides with the job still on its way out
# ("Bootstrap failed: 5: Input/output error"), and on 10/14 that left a lane
# stopped on the Mac Mini. So reload_job waits for the old job to be gone,
# retries the bootstrap inside the same bounded wait, and reads the load back.

# How long one job may take to leave and come back before we give up on it.
LAUNCHD_WAIT_SECONDS="${LAUNCHD_WAIT_SECONDS:-30}"

loaded_line() {
  # Read launchctl's list into a variable first. Piping it straight into
  # `grep -q` under pipefail reported a live lane as "loaded: no": grep quits
  # at the first match, launchctl dies of SIGPIPE, and the pipeline "fails".
  local listing
  listing="$(launchctl list 2>/dev/null || true)"
  awk -v l="$1" '$3 == l' <<<"$listing"
}

# reload_job <label> <plist>: stop the old job if there is one, wait until
# launchd no longer lists it, load the plist, and check launchd lists it now.
# Returns 0 only when the job is loaded. Otherwise says on stderr which job is
# NOT loaded and why, and returns 1; it never exits, so the caller can still
# try the other jobs.
reload_job() {
  local label="$1" plist="$2" domain deadline err
  domain="gui/$(id -u)"
  deadline=$(( SECONDS + LAUNCHD_WAIT_SECONDS ))

  launchctl bootout "$domain/$label" 2>/dev/null || true
  while [ -n "$(loaded_line "$label")" ]; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "NOT LOADED: $label — the old job was still listed by launchd after ${LAUNCHD_WAIT_SECONDS}s, so the new one was not started." >&2
      return 1
    fi
    sleep 1
  done

  until err="$(launchctl bootstrap "$domain" "$plist" 2>&1)"; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "NOT LOADED: $label — launchctl bootstrap kept failing for ${LAUNCHD_WAIT_SECONDS}s. Last error: $err" >&2
      return 1
    fi
    sleep 1
  done

  if [ -z "$(loaded_line "$label")" ]; then
    echo "NOT LOADED: $label — launchctl bootstrap reported success, but launchctl list does not show the job." >&2
    return 1
  fi
}
