# 08: Single-file executable bundle

**What to build:** a build that produces self-contained, offline-runnable executables for each operating system.

**Blocked by:** 07 (finish a game: podium, saved results, back to lobby)

**Status:** ready-for-agent

- [ ] A build script produces executables for Windows, macOS, and Linux
- [ ] The bundle runs the full app offline with no Node/npm installed
- [ ] Data (quizzes, results) is written to a folder next to the executable
- [ ] A smoke test exercises launch → join → answer → podium on the bundle

## Comments

### Implemented (ticket 08, worker)

- `scripts/build.mjs` (`npm run build:exe`): esbuild bundles `src/server.ts` → `dist/server.cjs` (CommonJS — SEA requires a CJS main, which is why the boot moved into `main()` with no top-level await); generates `dist/sea-config.json` embedding the ten `public/` client files plus `data/quizzes/seed.json` as SEA assets (key contract exported by `src/sea-assets.ts`, read at build time so build and runtime share one source of truth); runs `node --experimental-sea-config` → `dist/sea-prep.blob`; copies the platform node binary to `dist/offline-kahoot(.exe)`; injects the blob with postject + NODE_SEA sentinel fuse (macOS also codesign strip/re-sign).
- `src/sea-assets.ts` + tests: pure seam — asset-key list, request-path → embedded-key mapping (rejects traversal / API paths / unknown files), data-root-beside-exec path, `isRunningAsSea()` via `node:sea` `isSea()` with try/catch fallback.
- `src/server.ts` SEA-aware, npm-start fallback unchanged: serves pages and static files from embedded assets when running as SEA; runtime-writable data (quizzes, results) on disk BESIDE the executable; embedded seed quiz materialized to `data/quizzes/seed.json` on first run (existing copy never overwritten). Frozen files (engine/storage/results/socket/join/state-view) untouched.
- Cross-compile caveat (honest): Node SEA cannot cross-compile — the script produces the binary for the platform it runs on. Verified on LINUX here; Windows/macOS binaries are produced by running the SAME `node scripts/build.mjs` on those OSes. Documented in `docs/single-executable.md`.
- Smoke: `scripts/smoke-exe.mjs` (`npm run test:exe`; NOT part of `npm test`) copies the exe to `dist/smoke-tmp`, spawns it DIRECTLY, checks embedded serving of /, /play, /editor, static files, traversal rejection, seed materialization beside exe + /api/quizzes listing, then over the wire drives launch → join (host + 2 players) → 4× answer/reveal/next → podium, asserting scores, leaderboard, one results file under `data/results` beside the exe, and nothing runtime-written into the project tree. PASS on 3 consecutive runs.
- Validation: `node node_modules/typescript/bin/tsc --noEmit` OK; `node node_modules/vitest/vitest.mjs run` → 119 passing (111 prior + 8 new). New dev deps: esbuild, postject. No git commit (parent commits).
