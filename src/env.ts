// src/env.ts — a tiny, hand-rolled .env reader (NO `dotenv` dependency: the
// offline + single-executable constraint rules out adding runtime npm deps).
//
// Behavior, kept simple and documented here:
//   * `parseEnvSource()` reads `KEY=VALUE` lines, `#` comment lines, blank
//     lines, and optional single/double quotes around a value. Values are
//     trimmed; keys must look like env-var identifiers.
//   * `loadEnvFiles()` applies parsed files to process.env, and a file value
//     is NEVER used when the variable is already set in process.env — real
//     environment variables win (so tests/CI can inject ADMIN_PASSWORD
//     without editing any file).
//   * `requireAdminPassword()` is the boot entry point: it loads the files
//     and returns the validated ADMIN_PASSWORD, throwing a clear error that
//     names both the variable (`ADMIN_PASSWORD`) and the file (`.env`) when
//     it is missing, empty, or whitespace-only. Surrounding whitespace of the
//     value is trimmed; the trimmed value is written back into process.env so
//     every reader (verifySessionToken, /api/login) sees the same string.
//
// Lookup order (defaultEnvFiles()): in the standalone SEA executable the
// file is looked up at the CWD first, then in the directory beside the
// executable; filesystem mode (npm start) looks at the CWD, which is the
// project dir for the documented workflows.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isRunningAsSea } from './sea-assets.js';

/** Parses `KEY=VALUE` lines per the documented mini-format. Pure function. */
export function parseEnvSource(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue; // needs `KEY=`; junk lines are ignored
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value.charAt(0);
    if (
      (quote === '"' || quote === "'") &&
      value.length >= 2 &&
      value.charAt(value.length - 1) === quote
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * .env lookup paths: SEA mode checks the CWD first (where the user's working
 * data dir is), then next to the executable; filesystem mode keeps the
 * single project-dir location (the CWD of `npm start`).
 */
export function defaultEnvFiles(): string[] {
  const cwdFile = path.join(process.cwd(), '.env');
  if (!isRunningAsSea()) return [cwdFile];
  const besideExe = path.join(path.dirname(process.execPath), '.env');
  return besideExe === cwdFile ? [cwdFile] : [cwdFile, besideExe];
}

/**
 * Loads each file that exists (first file wins per variable, because later
 * files never override an already-set variable). Mutates process.env in
 * place — a file value only lands when the variable is NOT already set.
 */
export function loadEnvFiles(files: string[]): void {
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnvSource(readFileSync(file, 'utf8')))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

/**
 * Boot gate for the single shared admin password. Loads the .env lookup
 * paths, then fails fast (throws — the boot caller must exit non-zero and
 * print the message) when ADMIN_PASSWORD is missing, empty, or
 * whitespace-only. Returns the trimmed password.
 */
export function requireAdminPassword(envFiles: string[] = defaultEnvFiles()): string {
  loadEnvFiles(envFiles);
  const raw = process.env.ADMIN_PASSWORD;
  const password = typeof raw === 'string' ? raw.trim() : '';
  if (!password) {
    throw new Error(
      `${process.env.ADMIN_PASSWORD !== undefined ? 'ADMIN_PASSWORD is empty' : 'ADMIN_PASSWORD is not set'} — ` +
        `the server refuses to run unauthenticated. Add a line 'ADMIN_PASSWORD=<password>' to a .env file ` +
        `or set the ADMIN_PASSWORD environment variable (looked for .env at: ${envFiles.join(', ')})`,
    );
  }
  process.env.ADMIN_PASSWORD = password; // keep the trimmed value authoritative
  return password;
}
