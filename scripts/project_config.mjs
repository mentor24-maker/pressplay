#!/usr/bin/env node
/**
 * project_config.mjs — one project-config value, for shell scripts.
 *
 *   node scripts/project_config.mjs launchdPrefix     → com.spirality
 *   node scripts/project_config.mjs logDir            → /Users/me/loop-logs
 *   node scripts/project_config.mjs mergePhrases      → one phrase per line
 *
 * The installer and the relay runner are bash, and CLAUDE.md engineering
 * rule 2 says nothing project-specific is hard-coded in substrate code — so
 * they ask this script instead of carrying `com.spirality` and `~/loop-logs`
 * of their own. The reader is lib/projectConfig.mjs, the same one every
 * module uses; a broken config fails here, loudly, before a plist is written.
 *
 * A leading `~/` in a path-like value is expanded to the home folder, because
 * launchd gives a plist no shell to expand it with.
 */

import { homedir } from 'node:os';
import { loadProjectConfig, ProjectConfigError, SCHEMA } from '../loop/lib/projectConfig.mjs';

const key = process.argv[2];
if (!key || key === '--help' || !Object.hasOwn(SCHEMA, key)) {
  console.error(`usage: node scripts/project_config.mjs <key>\n  keys: ${Object.keys(SCHEMA).join(', ')}`);
  process.exit(2);
}

let config;
try {
  config = loadProjectConfig();
} catch (err) {
  if (!(err instanceof ProjectConfigError)) throw err;
  console.error(`project_config: the project config is not usable — ${err.message}`);
  process.exit(1);
}

const expandHome = (v) => (typeof v === 'string' && /^~(\/|$)/.test(v) ? v.replace(/^~/, homedir()) : v);
const value = config[key];
if (value == null) {
  // An optional key left out, with no default: an empty line, so a shell
  // script can test for it with [ -n "$x" ].
  process.stdout.write('\n');
} else if (Array.isArray(value)) {
  for (const v of value) process.stdout.write(`${expandHome(v)}\n`);
} else if (value && typeof value === 'object') {
  process.stdout.write(`${JSON.stringify(value)}\n`);
} else {
  process.stdout.write(`${expandHome(value)}\n`);
}
