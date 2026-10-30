#!/usr/bin/env node
// Builds a single self-contained offline executable (Node "Single Executable
// Application", SEA). The output runs the whole app with NO Node/npm installed
// on the target machine.
//
// Steps (see docs/single-executable.md for the runnable contract):
//   1. esbuild bundles src/server.ts -> dist/server.cjs
//      (CommonJS — Node SEA requires a CJS main; src/server.ts has no
//      top-level await, so this bundles cleanly).
//   2. Generate dist/sea-config.json embedding the server bundle plus the
//      public/ client assets and data/quizzes/seed.json as SEA assets.
//      Asset keys are the contract exported by src/sea-assets.ts.
//   3. node --experimental-sea-config dist/sea-config.json -> dist/sea-prep.blob
//   4. Copy THIS platform's node binary to dist/offline-kahoot (or
//      dist/offline-kahoot.exe on Windows) and chmod it executable.
//   5. postject injects the blob with the NODE_SEA sentinel fuse.
//
// Cross-platform caveat (documented, honest): Node SEA cannot cross-compile.
// Running this script on the current machine produces the executable for the
// CURRENT platform only. Windows/macOS binaries are produced by running the
// SAME script on those platforms (it uses only cross-platform Node APIs);
// the macOS path additionally re-signs with codesign.
//
// Sandbox note: run with `node scripts/build.mjs` (npm run is blocked there).

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { inject } from 'postject';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const exeName = process.platform === 'win32' ? 'offline-kahoot.exe' : 'offline-kahoot';
const exePath = path.join(dist, exeName);
const serverCjs = path.join(dist, 'server.cjs');
const seaConfigPath = path.join(dist, 'sea-config.json');
const seaBlobPath = path.join(dist, 'sea-prep.blob');

mkdirSync(dist, { recursive: true });

// 1. Read the asset-key contract from src/sea-assets.ts so build and runtime
//    share ONE source of truth (compiled to a throwaway ESM file and imported).
const contractFile = path.join(dist, 'sea-assets.gen.mjs');
rmSync(contractFile, { force: true });
await esbuild({
  entryPoints: [path.join(root, 'src', 'sea-assets.ts')],
  outfile: contractFile,
  format: 'esm',
  bundle: true,
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
});
const { SEA_ASSET_KEYS } = await import(`file://${contractFile}`);
rmSync(contractFile, { force: true });
if (!Array.isArray(SEA_ASSET_KEYS) || SEA_ASSET_KEYS.length === 0) {
  throw new Error('SEA asset-key contract could not be read from src/sea-assets.ts');
}

// 2. Bundle the server. CommonJS is mandatory for SEA; bufferutil /
//    utf-8-validate are optional native deps of socket.io — external so bundling
//    never depends on native toolchains (websocket falls back to plain ws).
await esbuild({
  entryPoints: [path.join(root, 'src', 'server.ts')],
  outfile: serverCjs,
  format: 'cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  external: ['bufferutil', 'utf-8-validate'],
  sourcemap: false,
  logLevel: 'info',
});

// 3. SEA config + blob. Paths are relative to the CWD we run the configurator
//    in (the repo root); assets are baked inside the blob, so the exe needs no
//    files on disk.
const seaConfig = {
  main: path.posix.join('dist', path.basename(serverCjs)),
  output: 'dist/sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: Object.fromEntries(SEA_ASSET_KEYS.map((key) => [key, key])),
};
writeFileSync(seaConfigPath, `${JSON.stringify(seaConfig, null, 2)}\n`);

const missingAssets = SEA_ASSET_KEYS.filter((key) => !existsSync(path.join(root, key)));
if (missingAssets.length > 0) {
  throw new Error(`SEA assets missing on disk: ${missingAssets.join(', ')}`);
}
execFileSync(process.execPath, ['--experimental-sea-config', path.relative(root, seaConfigPath)], {
  cwd: root,
  stdio: 'inherit',
});
if (!existsSync(seaBlobPath)) {
  throw new Error('SEA blob was not produced — see the configurator output above');
}

// 4. Copy this platform's node binary; SEA runs the blob from a copy of node.
rmSync(exePath, { force: true });
copyFileSync(process.execPath, exePath);
if (process.platform !== 'win32') {
  // copyFileSync clones content only — restore the executable bit.
  chmodSync(exePath, 0o755);
}

// 5. postject injection with the NODE_SEA sentinel fuse (see Node SEA docs).
if (process.platform === 'darwin') {
  // macOS: strip the existing signature before injection, re-sign after.
  execFileSync('codesign', ['--remove-signature', exePath], { stdio: 'inherit' });
}
await inject(exePath, 'NODE_SEA_BLOB', readFileSync(seaBlobPath), {
  overwrite: true,
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? { machoSegmentName: 'sea' } : {}),
});
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--sign', '-', exePath], { stdio: 'inherit' });
}

console.log(
  `[build] done: ${exePath}\n` +
    `[build] NOTE: this binary is for the build machine's platform (` +
    `${process.platform}); run scripts/build.mjs on each target OS — Node SEA ` +
    `cannot cross-compile.` +
    `${process.platform === 'win32' ? '\n[build] Windows: if injection fails because the exe is busy, close all running copies.' : ''}`,
);
