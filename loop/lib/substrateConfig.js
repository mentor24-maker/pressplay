'use strict';

/**
 * The project config, for the CommonJS substrate modules.
 *
 * WHY THIS EXISTS (2026-10-12, task 86bcgmnpy). CLAUDE.md engineering rule 2:
 * nothing project-specific is hard-coded in substrate code — every id, name,
 * path and phrase that differs between products comes from the project config,
 * and "a literal list id in a module is a bug". The modules moved from
 * StarCaster carry a handful of such literals in the strings they build: the
 * operator's name, and the `[CC-<product>]` tag a loop signs a bus post with.
 *
 * `projectConfig.mjs` is the one reader, and it is ESM. These modules are
 * CommonJS, as they are in StarCaster (rule 3: move, don't rewrite). Node
 * 22.12 and newer let CommonJS `require()` an ESM module that has no top-level
 * await, which `projectConfig.mjs` does not — so the two live together with no
 * second copy of the reader and no rewrite of 13 modules.
 *
 * AN ABSENT CONFIG FALLS BACK; A BROKEN ONE DOES NOT. These are pure decision
 * modules: they are imported to format a sentence or classify a comment, often
 * in a test or a consumer that has no config file yet, so NO config file at all
 * degrades to wording that names no product — "the operator", and a tag of
 * `[CC-loop]`. A product that wants its own name says so in its config.
 *
 * But a file that EXISTS and does not pass its checks is a different thing, and
 * it used to read the same as an absent one (review of 86bcgmnpy, round 2). A
 * single typo'd key — `operatorNmae` — took the whole config down to `null`:
 * the stamp quietly went back to "under the operator's token", the tag to
 * `[CC-loop]`, the product's legacy prefixes were dropped and `productScripts`
 * became `{}`, which silently re-skipped the very wiring tests that exist to
 * catch an inert fix. Nothing failed, and this PR makes four keys required, so
 * that is exactly what the first product to upgrade would have hit. CLAUDE.md
 * engineering rule 6: a step that fails says so. A config that is present and
 * invalid now THROWS, the same way a Node too old to read it does.
 */

/** Loaded once per working directory; `null` records that there is no file. */
let cached;
let cachedFor;
/** The same, for `filedTrackerUrl`. */
let filedCache;
let filedCacheFor;

/**
 * The validated project config, or `null` when there is no config file to read.
 * THROWS `ProjectConfigError` when a file is there and does not pass its checks.
 *
 * THE CONFIG IS THE CONSUMER'S, FOUND FROM THE WORKING DIRECTORY — never from
 * this file's own folder. `projectConfig.mjs` walks up from `cwd` by design,
 * and that is the behaviour wanted: once StarCaster depends on this package,
 * `lib/` sits in ITS `node_modules` (a symlink, for a local checkout), so
 * walking up from `__dirname` would find SPIRALITY's config and hand StarCaster
 * a `productSlug` of "spirality". Caught by installing the package into a
 * throwaway consumer and reading the tag back, 2026-10-12.
 */
function projectConfig() {
  const cwd = process.cwd();
  if (cached !== undefined && cachedFor === cwd) return cached;
  // A Node too old to require() an ESM file is NOT a missing config: falling
  // back here would sign every post `[CC-loop]` with no error at all. So the
  // reader is loaded outside the fallback, and that failure is loud.
  // `package.json` says node >=22.12 for this reason (review of 86bcgmnpy).
  // eslint-disable-next-line global-require
  const { loadProjectConfig, findConfigFile } = require('./projectConfig.mjs');
  // ASK WHETHER THERE IS A FILE FIRST, so "none" and "broken" stay different
  // answers. `loadProjectConfig` reports both as one ProjectConfigError, and
  // catching that is what hid a typo'd key behind the no-product wording.
  const file = findConfigFile(cwd);
  if (!file) {
    cachedFor = cwd;
    cached = null;
    return cached;
  }
  // No caching around this call: a broken config throws on EVERY read, not
  // once. A cached failure would be a loud first line followed by quiet ones.
  const config = loadProjectConfig({ file, cwd });
  cachedFor = cwd;
  cached = config;
  return cached;
}

/** Forget the cached config. For tests that write a config and re-read it. */
function resetProjectConfig() { cached = undefined; cachedFor = undefined; filedCache = undefined; filedCacheFor = undefined; }

/**
 * The tracker address WRITTEN IN THE CONFIG FILE, ignoring Doppler's
 * TRACKER_URL. The loops reach the tracker by the override (`127.0.0.1` on
 * the Mini); a link a person clicks, from another machine or from GitHub,
 * needs the network name the file holds (review of SP-32, round 1). `null`
 * with no config file or no trackerUrl in it.
 */
function filedTrackerUrl() {
  const cwd = process.cwd();
  if (filedCache !== undefined && filedCacheFor === cwd) return filedCache;
  // eslint-disable-next-line global-require
  const { loadProjectConfig, findConfigFile } = require('./projectConfig.mjs');
  const file = findConfigFile(cwd);
  // An empty value is "no override" to the reader, so every other override still applies.
  const config = file ? loadProjectConfig({ file, cwd, env: { ...process.env, TRACKER_URL: '' } }) : null;
  filedCacheFor = cwd;
  filedCache = (config && config.trackerUrl) || null;
  return filedCache;
}

/** What the loops call the operator in anything he reads. */
function operatorName() {
  const config = projectConfig();
  return (config && config.operatorName) || 'the operator';
}

/**
 * The tag a loop signs a post with: `[CC-spirality bus-relay]`, or
 * `[CC-spirality]` with no role. `CC` is the agent that runs the loop.
 */
function machineSenderTag(role, { agent = 'CC' } = {}) {
  const config = projectConfig();
  const slug = (config && config.productSlug) || 'loop';
  return role ? `[${agent}-${slug} ${role}]` : `[${agent}-${slug}]`;
}

/**
 * The exact comment phrases that mean "merge it" for this product. CLAUDE.md
 * engineering rule 2 names merge phrases as config: a product that adds a
 * phrase must be able to merge with it, and a product that drops one must not.
 * The fallback is StarCaster's four, which is what all three configs list
 * today, so no product's behaviour changes with this read (review of
 * 86bcgmnpy, round 2).
 */
function mergePhrases() {
  const config = projectConfig();
  return (config && config.mergePhrases) || ['merge', 'merge it', 'ship it', 'approve'];
}

/**
 * Comment prefixes this product's loops used before the `[machine]` stamp
 * existed. Per-product history; empty where a product has none.
 */
function legacyMachinePrefixes() {
  const config = projectConfig();
  return (config && config.legacyMachinePrefixes) || [];
}

/**
 * The folder the loop runners write their logs to, as the operator would type
 * it (`~/loop-logs`), for a sentence that tells him where to look. The config
 * key is `logDir`; the fallback is what every product uses today.
 */
function logDir() {
  const config = projectConfig();
  return (config && config.logDir) || '~/loop-logs';
}

/**
 * The environment variable a product's scheduled jobs set to say "this is a
 * background job" (`STARCASTER_CALLER=scheduled` in StarCaster). Named for
 * the product, so it is built from `productSlug`: `SPIRALITY_CALLER`, or
 * `LOOP_CALLER` with no config. Only sentences read it here — the door that
 * honours it is the product's own.
 */
function callerEnvVar() {
  const config = projectConfig();
  const slug = (config && config.productSlug) || 'loop';
  return `${slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_CALLER`;
}

module.exports = {
  projectConfig, resetProjectConfig, filedTrackerUrl, operatorName, machineSenderTag, legacyMachinePrefixes,
  mergePhrases, logDir, callerEnvVar,
};
