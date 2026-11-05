// Node Single-Executable-Application (SEA) seam. When the server runs from the
// standalone bundle that scripts/build.mjs produces, public pages and the seed
// quiz are embedded assets whose keys are agreed with the build script, and
// runtime-writable data (imported quizzes, results) lives on disk NEXT TO the
// executable — never inside the bundle. Helpers here are pure so the mapping
// and paths can be unit-tested without an actual SEA build.

import path from 'node:path';
import { isSea } from 'node:sea';

/**
 * Every embedded asset key — the build contract with scripts/build.mjs, which
 * reads and bakes exactly these files (exported verbatim after compiling this
 * module). Server code serves no other asset key, so bundled files cannot
 * escape public/ or data/.
 */
export const SEA_ASSET_KEYS = [
  'public/dashboard.html',
  'public/dashboard.js',
  'public/dashboard.css',
  'public/host.html',
  'public/host.js',
  'public/tokens.css',
  'public/host.css',
  'public/player.html',
  'public/player.js',
  'public/avatar.js',
  'public/i18n.js',
  'public/login.html',
  'public/login.js',
  'public/login.css',
  'public/editor.html',
  'public/editor.js',
  'public/editor.css',
  'public/question-defaults.js',
  'public/question-defaults.d.ts',
  // Self-hosted display font (admin-dashboard issue 05): Montserrat woff2
  // subsets, unicode-range latin + latin-ext, weights 400/700/800. Served to
  // the pages like tokens.css — fonts are PUBLIC assets (issue 03's asset
  // split; login page loads them before any session exists).
  'public/fonts/montserrat-latin-400-normal.woff2',
  'public/fonts/montserrat-latin-700-normal.woff2',
  'public/fonts/montserrat-latin-800-normal.woff2',
  'public/fonts/montserrat-latin-ext-400-normal.woff2',
  'public/fonts/montserrat-latin-ext-700-normal.woff2',
  'public/fonts/montserrat-latin-ext-800-normal.woff2',
  'data/quizzes/seed.json',
] as const;

export type SeaAssetKey = (typeof SEA_ASSET_KEYS)[number];

/** Key of the embedded seed quiz, materialized beside the exe on first run. */
export const SEA_SEED_ASSET_KEY: SeaAssetKey = 'data/quizzes/seed.json';

const SEA_KEY_SET: ReadonlySet<string> = new Set(SEA_ASSET_KEYS);
const SEA_PUBLIC_PREFIX = 'public/';

/** URL routes for the app pages and the public file behind each. */
const SEA_PAGE_ROUTES: Readonly<Record<string, SeaAssetKey>> = {
  '/': 'public/dashboard.html',
  '/login': 'public/login.html',
  '/play': 'public/player.html',
  '/editor': 'public/editor.html',
  '/host': 'public/host.html',
};

/**
 * Maps a decoded URL path to an embedded asset key. Only the page routes and
 * requests for the exact files listed in SEA_ASSET_KEYS are accepted;
 * everything else (API routes, traversal like /../, unknown names) returns
 * null so the caller can 404 or fall through.
 */
export function publicPathToAssetKey(urlPath: string): SeaAssetKey | null {
  const pageRoute = SEA_PAGE_ROUTES[urlPath];
  if (pageRoute) return pageRoute;
  if (!urlPath.startsWith('/')) return null;
  const key = `${SEA_PUBLIC_PREFIX}${urlPath.slice(1)}`;
  return SEA_KEY_SET.has(key) ? (key as SeaAssetKey) : null;
}

/** Runtime data root next to the executable: <exe dir>/data. */
export function dataRootBesideExecutable(execPath: string): string {
  return path.join(path.dirname(execPath), 'data');
}

/**
 * Authoritative SEA detection via node:sea. The try/catch only guards hosts
 * where the node:sea builtin is unavailable; outside a bundle this reports
 * false and the server falls back to filesystem resolution.
 */
export function isRunningAsSea(): boolean {
  try {
    return isSea();
  } catch {
    return false;
  }
}
