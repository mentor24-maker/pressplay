/**
 * projectConfig.mjs — the one place a product's ids, names, paths and phrases
 * come from. Every substrate module reads this object instead of a literal,
 * so the same code serves StarCaster, WaveCenter and Spirality itself
 * (CLAUDE.md, engineering rule 2: a literal list id in a module is a bug).
 *
 * The values live in `spirality.project.json` at the consuming repository's
 * root. `loadProjectConfig()` finds it by walking up from the current folder,
 * applies the environment overrides StarCaster already uses, and checks every
 * key. A missing key, an id that is not a number, or a key nobody knows about
 * stops the caller with a message that names the key and the file — a typo
 * never silently becomes "use some other product's queue".
 *
 * The keys (description, then an example value):
 *
 *   workspaceId      the ClickUp workspace ("team") every request runs in.
 *                    "90141423066"
 *   spaceId          the ClickUp space that holds this product's lists.
 *                    "90146476540"
 *   loopQueueListId  the Loop Queue list the build and review loops drain.
 *                    "901418065068"
 *   operatorUserId   Dane's ClickUp seat: every handoff to him assigns this id.
 *                    "48012725"
 *   machineUserId    the workspace's service account; never assigned a ticket.
 *                    "54254347"
 *   githubRepo       the GitHub repository pull requests go to, owner/name.
 *                    "mentor24-maker/spirality"
 *   dopplerProject   the Doppler project that holds this product's keys.
 *                    "spirality"
 *   dopplerConfig    the Doppler config inside that project the loops use.
 *                    "dev"
 *   launchdPrefix    the start of every launchd label the runner installs.
 *                    "com.spirality"
 *   logDir           the folder the loop runners write their logs and locks to.
 *                    "~/loop-logs"
 *   mergePhrases     what the operator writes on a ticket to mean "merge
 *                    this". Matched as a whole comment, with both sides
 *                    normalized, so casing and punctuation here are free.
 *                    ["merge", "merge it", "ship it", "approve"]
 *   governancePaths  files and folders a loop may not change unattended.
 *                    ["CLAUDE.md", ".github/workflows/"]
 *   autoMergeLanes   lanes allowed to merge without Dane; empty means none.
 *                    []
 *   operatorName     what the loops call the operator in anything he reads.
 *                    "Dane"
 *   productSlug      this product's short name, used to build the machine
 *                    sender tags a loop signs its posts with ("[CC-<slug>]").
 *                    "spirality"
 *   legacyMachinePrefixes
 *                    comment prefixes this product's loops used BEFORE the
 *                    "[machine]" stamp existed, still sitting in its ClickUp
 *                    history. Per-product history, never a substrate literal.
 *                    []
 *   productScripts   the product's own scripts that substrate wiring tests
 *                    read, as paths relative to the config file's own folder
 *                    (the repo root). Keys: "door", "busRelayInstaller",
 *                    "buildSkill", "reviewSkill", "loopDoc",
 *                    "automergeReachCheck", "preflightRunner",
 *                    "repairRunner", "busRelayRunner", "reconcileScript",
 *                    and "gates" (a folder). See lib/productScripts.js.
 *                    {}
 *   tracker          OPTIONAL. Which tracker the door talks to: "clickup"
 *                    (also what an absent key means) or "api", the tracker's
 *                    own web API (docs/TRACKER_MVP.md, "How the loops switch
 *                    over"). With "api", operatorUserId and machineUserId are
 *                    the tracker's actor ids, productSlug is its project slug,
 *                    and the loop's token comes from the environment, never
 *                    from this file: the TRACKER_TOKEN_... secret its runner
 *                    names in TRACKER_TOKEN_NAME, or TRACKER_TOKEN_HAND_RUN.
 *                    "clickup"
 *   trackerPrefix    OPTIONAL. The start of every ticket id in the tracker's
 *                    store (`<prefix>-1`): capital letters and digits,
 *                    beginning with a letter. Only the importer
 *                    (tracker/import.mjs) needs it; absent means null.
 *                    "SP"
 *   trackerPort      OPTIONAL. The port the tracker service listens on, on the
 *                    machine that runs it (docs/TRACKER_MVP.md, "Running it").
 *                    Absent means this product runs no tracker service, and
 *                    the installer installs none.
 *                    4180
 *   trackerHost      OPTIONAL. The address the tracker service listens on:
 *                    "127.0.0.1" (that machine only, the default) or
 *                    "0.0.0.0" (every machine on the home network).
 *                    "0.0.0.0"
 *   trackerDataDir   OPTIONAL, but required with trackerPort. The folder that
 *                    holds the tracker's database and its nightly backups.
 *                    A leading "~/" is the home folder.
 *                    "~/spirality-tracker"
 *   trackerUrl       OPTIONAL, REQUIRED when tracker is "api". The tracker's
 *                    address, http or https, with no path after the host:
 *                    the one Dane's browser and the hand-over email use.
 *                    "http://mini.local:7420"
 *   trackerApiUrl    OPTIONAL, defaults to trackerUrl. The address the loops
 *                    themselves call (the door, so the runners and the
 *                    relay). On the machine the tracker runs on, its own
 *                    ".local" name may not resolve for Node (only ping and
 *                    curl find it), so this is that machine's own address.
 *                    "http://127.0.0.1:7420"
 *
 * Ids may be written as numbers or as strings of digits; they come back as
 * strings, so `Number(config.operatorUserId)` is the caller's choice.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const CONFIG_FILE = 'spirality.project.json';

/** Every key, its kind, and the environment variable that overrides it (if any). */
export const SCHEMA = Object.freeze({
  workspaceId:     { kind: 'id', env: 'CLICKUP_WORKSPACE_ID' },
  spaceId:         { kind: 'id', env: 'CLICKUP_SPACE_ID' },
  loopQueueListId: { kind: 'id', env: 'CLICKUP_LOOP_QUEUE_LIST' },
  operatorUserId:  { kind: 'id', env: 'CLICKUP_OPERATOR_ID' },
  machineUserId:   { kind: 'id', env: 'CLICKUP_MACHINE_ID' },
  githubRepo:      { kind: 'repo' },
  dopplerProject:  { kind: 'string' },
  dopplerConfig:   { kind: 'string' },
  launchdPrefix:   { kind: 'string' },
  logDir:          { kind: 'string' },
  mergePhrases:    { kind: 'phrases', nonEmpty: true },
  governancePaths: { kind: 'strings' },
  autoMergeLanes:  { kind: 'strings' },
  operatorName:    { kind: 'string' },
  productSlug:     { kind: 'slug' },
  legacyMachinePrefixes: { kind: 'strings' },
  productScripts:  { kind: 'pathMap' },
  tracker:         { kind: 'oneOf', values: ['clickup', 'api'], optional: true, default: 'clickup' },
  trackerPrefix:   { kind: 'prefix', optional: true, default: null },
  trackerPort:     { kind: 'port', optional: true, default: null },
  trackerHost:     { kind: 'string', optional: true, default: '127.0.0.1' },
  trackerDataDir:  { kind: 'string', optional: true, default: null },
  trackerUrl:      { kind: 'url', env: 'TRACKER_URL', optional: true, default: null },
  trackerApiUrl:   { kind: 'url', env: 'TRACKER_API_URL', optional: true, default: null },
});

export class ProjectConfigError extends Error {
  constructor(message) { super(message); this.name = 'ProjectConfigError'; }
}

/** Walk up from `startDir` to the nearest folder holding spirality.project.json. */
export function findConfigFile(startDir = process.cwd()) {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function checkValue(key, value, spec, where) {
  const fail = (why) => { throw new ProjectConfigError(`${where}: "${key}" ${why}`); };
  switch (spec.kind) {
    case 'id':
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
      if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value;
      return fail(`must be a numeric ClickUp id (digits only), got ${JSON.stringify(value)}`);
    case 'port':
      if (typeof value === 'string' && /^[0-9]+$/.test(value)) value = Number(value);
      if (Number.isInteger(value) && value >= 1 && value <= 65535) return value;
      return fail(`must be a port number from 1 to 65535, got ${JSON.stringify(value)}`);
    case 'repo':
      if (typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value)) return value;
      return fail(`must be a GitHub repository written owner/name, got ${JSON.stringify(value)}`);
    case 'string':
      if (typeof value === 'string' && value.trim()) return value;
      return fail(`must be a non-empty string, got ${JSON.stringify(value)}`);
    case 'slug':
      if (typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value)) return value;
      return fail(`must be a short lower-case name (letters, digits and dashes), got ${JSON.stringify(value)}`);
    case 'pathMap':
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return fail(`must be an object of name -> path, got ${JSON.stringify(value)}`);
      }
      for (const [k, v] of Object.entries(value)) {
        if (typeof v !== 'string' || !v.trim()) {
          return fail(`entry "${k}" must be a non-empty path, got ${JSON.stringify(v)}`);
        }
      }
      return Object.freeze({ ...value });
    case 'prefix':
      if (typeof value === 'string' && /^[A-Z][A-Z0-9]*$/.test(value)) return value;
      return fail(`must be capital letters and digits, beginning with a letter, got ${JSON.stringify(value)}`);
    case 'url': {
      let u = null;
      try { u = typeof value === 'string' ? new URL(value) : null; } catch { u = null; }
      if (u && ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && /^\/?$/.test(u.pathname) && !u.search && !u.hash) {
        // The parsed origin, never the raw string: "http://host:7420/?" and
        // " http://host:7420 " parse clean but would be stored as written.
        return u.origin;
      }
      return fail(`must be an http or https address with no path, query or sign-in in it, got ${JSON.stringify(value)}`);
    }
    case 'oneOf':
      if (typeof value === 'string' && spec.values.includes(value)) return value;
      return fail(`must be one of ${spec.values.map((v) => JSON.stringify(v)).join(', ')}, got ${JSON.stringify(value)}`);
    case 'strings':
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim())) {
        return fail(`must be a list of non-empty strings, got ${JSON.stringify(value)}`);
      }
      if (spec.nonEmpty && value.length === 0) return fail('must list at least one entry');
      return Object.freeze([...value]);
    // A list of comment phrases, matched as a WHOLE comment after the comment
    // is normalized (mergeOnComment's `normalizeCommand`: lower-cased, spaces
    // collapsed, emphasis and trailing sentence punctuation dropped). The
    // matcher normalizes these entries too, so casing and punctuation here are
    // harmless. What is NOT harmless is a phrase with no letter or digit in it
    // at all: `"."` normalizes away to the empty string, which would equal
    // every empty comment and merge on silence. That one is refused, naming
    // the entry (review of 86bcgmnpy, round 3).
    case 'phrases': {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim())) {
        return fail(`must be a list of non-empty strings, got ${JSON.stringify(value)}`);
      }
      if (spec.nonEmpty && value.length === 0) return fail('must list at least one entry');
      const empty = value.find((v) => !/[a-z0-9]/i.test(v));
      if (empty !== undefined) {
        return fail(`entry ${JSON.stringify(empty)} has no letter or digit, so it can never be a phrase anyone types`);
      }
      return Object.freeze([...value]);
    }
    default:
      throw new Error(`projectConfig SCHEMA has an unknown kind for "${key}"`);
  }
}

/**
 * Check a parsed config object against SCHEMA and return a frozen copy with
 * environment overrides applied. `file` is only used to name the file in
 * error messages.
 */
export function validateProjectConfig(raw, { file = CONFIG_FILE, env = {} } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProjectConfigError(`${file}: must hold one JSON object of settings`);
  }
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(SCHEMA, key)) {
      throw new ProjectConfigError(`${file}: unknown key "${key}" (the known keys are: ${Object.keys(SCHEMA).join(', ')})`);
    }
  }
  const out = {};
  for (const [key, spec] of Object.entries(SCHEMA)) {
    const override = spec.env ? env[spec.env] : undefined;
    if (override !== undefined && override !== '') {
      out[key] = checkValue(key, override, spec, `${spec.env} (overriding ${file})`);
      continue;
    }
    if (!Object.hasOwn(raw, key) && spec.optional) { out[key] = spec.default; continue; }
    if (!Object.hasOwn(raw, key)) throw new ProjectConfigError(`${file}: missing required key "${key}"`);
    out[key] = checkValue(key, raw[key], spec, file);
  }
  if (out.tracker === 'api' && !out.trackerUrl) {
    throw new ProjectConfigError(`${file}: "trackerUrl" is required when "tracker" is "api" (the tracker's address, e.g. "http://mini.local:7420")`);
  }
  if (out.trackerApiUrl == null) out.trackerApiUrl = out.trackerUrl;
  return Object.freeze(out);
}

/**
 * Find, read and check the project config. Throws ProjectConfigError with a
 * message naming the file (and the key, when one is at fault).
 */
export function loadProjectConfig({ file, cwd = process.cwd(), env = process.env } = {}) {
  const path = file ? resolve(cwd, file) : findConfigFile(cwd);
  if (!path) throw new ProjectConfigError(`no ${CONFIG_FILE} found in ${resolve(cwd)} or any folder above it`);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ProjectConfigError(`${path}: could not be read (${err.code || err.message})`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ProjectConfigError(`${path}: is not valid JSON (${err.message})`);
  }
  return validateProjectConfig(raw, { file: path, env });
}
