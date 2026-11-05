/**
 * The ONE list of secret names a product expects in Doppler. A ticket that
 * adds a key adds a line here, so `npm run doctor` starts reporting it the
 * moment the code depends on it. Names only: no value ever appears in this
 * repository (it is public). Which Doppler project and config to look in is
 * the project config's `dopplerProject` and `dopplerConfig` (doctorTarget).
 *
 * The substrate holds no database and no deploy. The ClickUp token is a
 * reference to StarCaster's (one token to rotate for every project). The
 * tracker tokens are one sign-in per actor (docs/TRACKER_MVP.md, "Running
 * it"), made by `tracker/admin.mjs create-actor` and piped straight into
 * Doppler. The tracker's hand-over email needs the Resend key and the
 * address it goes to (tracker/notify.mjs).
 *
 * A key marked `trackerHome` is needed only by the product that runs the
 * tracker service (its config sets `trackerPort`): the operator's own
 * sign-in and the hand-over email. Any other product never needs them.
 *
 * A key marked `clickup` is needed only by a product that still talks to
 * ClickUp (usesClickUp): its `tracker` is `"clickup"`, or its
 * `loopQueueListId` names a real ClickUp list (not `"0"`), as Spirality's
 * does, kept as the record to compare the tracker against. A product never
 * on ClickUp (`tracker` `"api"`, ClickUp ids `"0"`) is never asked for it.
 */

/**
 * Who signs in to the tracker, and the Doppler secret holding each one's
 * token. A loop's actor is named after its skill (the relay after itself);
 * the operator's actor takes the project config's `operatorName`. The
 * `handRun` seat is the one a session started by hand signs in as, when no
 * runner names a seat (scripts/tracker/apiTracker.mjs, trackerTokenEnv).
 * `tracker/signins.mjs create` makes exactly these for the product that
 * runs the tracker. Any other product signs in with the machine seats only,
 * under the same secret names in its own Doppler project, its actors named
 * for it (`normie loop-build`): seatsForConfig in tracker/signins.mjs.
 */
export const TRACKER_SEATS = [
  { secret: 'TRACKER_TOKEN_OPERATOR', kind: 'human', name: null, what: "the operator's own tracker sign-in, for the page" },
  { secret: 'TRACKER_TOKEN_LOOP_BUILD', kind: 'machine', name: 'loop-build', what: "the build loop's tracker sign-in" },
  { secret: 'TRACKER_TOKEN_LOOP_REVIEW', kind: 'machine', name: 'loop-review', what: "the review loop's tracker sign-in" },
  { secret: 'TRACKER_TOKEN_LOOP_INTAKE', kind: 'machine', name: 'loop-intake', what: "the intake loop's tracker sign-in" },
  { secret: 'TRACKER_TOKEN_RELAY', kind: 'machine', name: 'relay', what: "the relay's tracker sign-in" },
  { secret: 'TRACKER_TOKEN_HAND_RUN', kind: 'machine', name: 'hand-run', handRun: true, what: "a hand-run session's tracker sign-in" },
];

export const EXPECTED_SECRETS = [
  { name: 'CLICKUP_API_TOKEN', clickup: true, what: 'the ClickUp token, for scripts only' },
  ...TRACKER_SEATS.map(({ secret, kind, what }) => ({ name: secret, what, ...(kind === 'human' ? { trackerHome: true } : {}) })),
  { name: 'RESEND_API_KEY', trackerHome: true, what: 'the Resend key the tracker sends the hand-over email with' },
  { name: 'TRACKER_NOTIFY_TO', trackerHome: true, what: "the operator's address for the hand-over email" },
];

/**
 * Whether a product still talks to ClickUp, from its project config alone:
 * its tracker is ClickUp (`tracker` left out means `"clickup"`), or its
 * `loopQueueListId` is a real list rather than the `"0"` of a product that
 * was never there.
 */
export function usesClickUp(config) {
  return (config.tracker ?? 'clickup') === 'clickup' || !/^0+$/.test(String(config.loopQueueListId));
}

/**
 * What doctor checks for one product, from its project config: the Doppler
 * project and config to look in, and the keys that product needs there
 * (the `trackerHome` ones only when it runs the tracker, `trackerPort` set;
 * the `clickup` ones only when usesClickUp).
 * Returns `{ project, configs, expected }` for doctorReport and formatReport.
 */
export function doctorTarget(config, secrets = EXPECTED_SECRETS) {
  const home = config.trackerPort != null;
  const clickup = usesClickUp(config);
  const configs = [config.dopplerConfig];
  const expected = secrets
    .filter((s) => (home || !s.trackerHome) && (clickup || !s.clickup))
    .map(({ name, what }) => ({ name, what, configs }));
  return { project: config.dopplerProject, configs, expected };
}

/**
 * Compare what Doppler holds against the list. `present` maps a config name
 * to the set of names it holds, or to null when the config could not be read.
 * Returns one row per expected name and whether everything required is there.
 */
export function doctorReport(present, expected, configs) {
  const rows = expected.map(({ name, configs: needed }) => ({
    name,
    cells: Object.fromEntries(configs.map((config) => {
      const names = present[config];
      if (!needed.includes(config)) return [config, 'not needed'];
      if (!names) return [config, 'unreadable'];
      return [config, names.has(name) ? 'present' : 'MISSING'];
    })),
  }));
  const ok = rows.every((row) => Object.values(row.cells).every((c) => c === 'present' || c === 'not needed'));
  return { rows, ok };
}

/** The report as a plain-text table, one line per name. */
export function formatReport({ rows }, configs) {
  const width = Math.max(4, ...rows.map((r) => r.name.length));
  const col = 12;
  const lines = [['NAME'.padEnd(width), ...configs.map((c) => c.padEnd(col))].join('  ').trimEnd()];
  for (const row of rows) {
    lines.push([row.name.padEnd(width), ...configs.map((c) => row.cells[c].padEnd(col))].join('  ').trimEnd());
  }
  return lines.join('\n');
}
