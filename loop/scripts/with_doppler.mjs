#!/usr/bin/env node
/**
 * with_doppler.mjs — run a command under this product's Doppler project.
 *
 *   node scripts/with_doppler.mjs node scripts/clickup.mjs queue
 *     → doppler run --project <dopplerProject> --config <dopplerConfig>
 *         --no-check-version -- node scripts/clickup.mjs queue
 *
 * The npm scripts that need keys (`clickup`, `tracker:signins`, ...) go
 * through this, so the Doppler project and config come from the project
 * config, not from a literal in package.json (CLAUDE.md engineering rule 2):
 * a copy in another product reads that product's keys with no edit.
 *
 * stdin, stdout and stderr pass straight through (ticket commands read a
 * body from stdin), and the command's exit code is this script's, so a
 * caller still tells exit 3 from exit 1. A broken project config fails here,
 * loudly, before Doppler is asked for anything.
 *
 * The project config is the one found from the current folder up, unless
 * the wrapped command names another with `--config <path>` (or
 * `--config=<path>`), as `tracker:signins` does: then that settings file,
 * the same one the command reads, names the Doppler project, so a product's
 * sign-ins run from Spirality's checkout land in that product's Doppler.
 */

import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadProjectConfig, ProjectConfigError } from '../lib/projectConfig.mjs';

/** The settings file a wrapped command names with `--config`, or undefined. */
export function configFileArg(command) {
  for (let i = 0; i < command.length; i += 1) {
    if (command[i] === '--') return undefined;
    if (command[i] === '--config') return command[i + 1];
    if (command[i].startsWith('--config=')) return command[i].slice('--config='.length);
  }
  return undefined;
}

/** The doppler arguments that run `command` under `config`'s project. */
export function dopplerArgs(config, command) {
  return ['run', '--project', config.dopplerProject, '--config', config.dopplerConfig, '--no-check-version', '--', ...command];
}

async function main(command) {
  if (!command.length || command[0] === '--help') {
    console.error('usage: node scripts/with_doppler.mjs <command> [args...]');
    return 2;
  }
  let config;
  try {
    config = loadProjectConfig({ file: configFileArg(command) });
  } catch (err) {
    if (!(err instanceof ProjectConfigError)) throw err;
    console.error(`with_doppler: the project config is not usable — ${err.message}`);
    return 1;
  }
  const child = spawn('doppler', dopplerArgs(config, command), { stdio: 'inherit' });
  // A terminal's Ctrl-C reaches the whole process group; a signal sent to
  // this process alone (launchd, a time limit) is passed on to the child.
  for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  process.on('SIGINT', () => {});
  return await new Promise((resolve) => {
    child.on('error', (err) => {
      console.error(`with_doppler: could not run the doppler command (${err.code}); is the Doppler CLI installed?`);
      resolve(1);
    });
    // Stopped by a signal: the shell's convention, 128 + its number.
    child.on('exit', (code, signal) => resolve(code ?? 128 + (constants.signals[signal] ?? 0)));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
