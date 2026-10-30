// Unit tests for the SEA (single-executable) seam helpers in src/sea-assets.ts.
// These helpers are the contract between scripts/build.mjs and the server's
// SEA runtime path; keeping the mapping pure means the contract is checked
// without building an actual executable.

import { describe, expect, it } from 'vitest';
import {
  dataRootBesideExecutable,
  isRunningAsSea,
  publicPathToAssetKey,
  SEA_ASSET_KEYS,
  SEA_SEED_ASSET_KEY,
} from './sea-assets.js';

const PUBLIC_FILES = [
  'host.html',
  'host.js',
  'host.css',
  'player.html',
  'player.js',
  'editor.html',
  'editor.js',
  'editor.css',
  'question-defaults.js',
  'question-defaults.d.ts',
];

describe('SEA asset keys', () => {
  it('is a known-good literal: embeds every public/ client file and the seed quiz', () => {
    expect(
      SEA_ASSET_KEYS
        .filter((k) => k.startsWith('public/'))
        .map((k) => k.slice('public/'.length)),
    ).toEqual(PUBLIC_FILES);
    expect(SEA_ASSET_KEYS.at(-1)).toBe(SEA_SEED_ASSET_KEY);
    expect(SEA_ASSET_KEYS.every((k) => !k.includes('..'))).toBe(true);
  });
});

describe('publicPathToAssetKey', () => {
  it('maps the three app page routes to their embedded public files', () => {
    // Worked example: the player route serves player.html, like express.static
    // resolves files, not the bare filepath.
    expect(publicPathToAssetKey('/')).toBe('public/host.html');
    expect(publicPathToAssetKey('/play')).toBe('public/player.html');
    expect(publicPathToAssetKey('/editor')).toBe('public/editor.html');
  });

  it('maps exact static asset requests to embedded keys', () => {
    expect(publicPathToAssetKey('/host.css')).toBe('public/host.css');
    expect(publicPathToAssetKey('/editor.js')).toBe('public/editor.js');
    expect(publicPathToAssetKey('/question-defaults.js')).toBe('public/question-defaults.js');
  });

  it('is read-only-bundle safe: rejects traversal, unknown, API and abuse paths', () => {
    expect(publicPathToAssetKey('/static/public/secret.json')).toBe(null);
    expect(publicPathToAssetKey('/node/path/../..')).toBe(null);
    expect(publicPathToAssetKey('/server.cjs')).toBe(null);
    expect(publicPathToAssetKey('/api/quizzes')).toBe(null);
    expect(publicPathToAssetKey('/not-a-file.html')).toBe(null);
    expect(publicPathToAssetKey('')).toBe(null);
    expect(publicPathToAssetKey('/host.js/')).toBe(null);
    expect(publicPathToAssetKey('/%2e%2e/host.html')).toBe(null);
  });
});

describe('dataRootBesideExecutable', () => {
  it('places runtime data in data/ next to the executable, not inside the bundle', () => {
    // Worked example: dirname(execPath) + 'data', so an exe moved to a USB
    // stick carries its writable data with it.
    expect(dataRootBesideExecutable('/opt/kahoot/offline-kahoot')).toBe('/opt/kahoot/data');
    expect(dataRootBesideExecutable('shipped/exe')).toBe('shipped/data');
  });

  it('separates runtime data from the project files in npm-start mode too', () => {
    expect(dataRootBesideExecutable('/repo/dist/offline-kahoot')).toBe('/repo/dist/data');
    expect(dataRootBesideExecutable('/repo/dist/offline-kahoot')).not.toBe('/repo/data');
  });
});

describe('isRunningAsSea', () => {
  it('never throws, even where node:sea is unavailable in plain node', () => {
    expect(typeof isRunningAsSea()).toBe('boolean');
  });

  it('is false in the vitest/npm-start process, which runs from TS not a bundle', () => {
    expect(isRunningAsSea()).toBe(false);
  });
});
