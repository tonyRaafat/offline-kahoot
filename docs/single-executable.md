# Single executable bundle (Node SEA)

Ticket 08. `scripts/build.mjs` builds a standalone executable that runs the
whole app (server, client pages, seed quiz) with NO Node/npm installed on the
target machine.

## How it works

1. **Bundle the server.** esbuild bundles `src/server.ts` → `dist/server.cjs`
   (`format: cjs`, `platform: node` — Node SEA requires a CommonJS main, which
   is why `src/server.ts` keeps its boot in `main()` and holds no top-level
   `await`). `bufferutil` / `utf-8-validate` are marked external (optional
   native deps of socket.io; socket.io falls back to plain `ws`).
2. **Embed assets.** `dist/sea-config.json` (generated) bakes exactly the keys
   exported by `src/sea-assets.ts` — the ten `public/` client files plus
   `data/quizzes/seed.json` — as SEA assets inside the blob. The key list is
   read from that module at build time, so build and runtime share one contract.
3. **Blob.** `node --experimental-sea-config dist/sea-config.json` →
   `dist/sea-prep.blob`.
4. **Executable.** The current platform's `node` binary is copied to
   `dist/offline-kahoot` (Windows: `dist/offline-kahoot.exe`) and the blob is
   injected with postject using the `NODE_SEA` sentinel fuse. On macOS the
   script strips and re-signs the binary with `codesign`.

## Runtime behavior inside the executable

- `src/server.ts` detects SEA (`node:sea` `isSea()`, see `src/sea-assets.ts`)
  and serves the three pages plus static files from the embedded assets via
  `getAsset()` — no filesystem reads for the bundle.
- Runtime-writable data (imported/edited quizzes, game results) is written to
  a `data/` folder NEXT TO the executable (`dirname(process.execPath)/data`),
  never into the bundle. On first run the embedded seed quiz is materialized
  to `data/quizzes/seed.json` beside the exe (an existing copy is never
  overwritten), so the editor lists/edits it like any other quiz.
- `npm start` (tsx) keeps working unchanged: when not in a bundle the server
  falls back to the regular filesystem layout (`public/`, project `data/`).

## Cross-compile caveat (important, honest)

Node SEA **cannot cross-compile**. A build produces the executable for the
platform it runs on. The build script itself is cross-platform (Windows, macOS,
Linux use the same code path; mac needs `codesign`), so produce and verify
each OS binary by running `node scripts/build.mjs` on that OS:

| Platform | Output                  | Produced/verified here |
| -------- | ----------------------- | ---------------------- |
| Linux    | `dist/offline-kahoot`   | yes (this machine)     |
| Windows  | `dist/offline-kahoot.exe` | rpm: same script on Windows |
| macOS    | `dist/offline-kahoot`   | same script on macOS   |

## Verify

```sh
npm run build:exe   # node scripts/build.mjs
node scripts/smoke-exe.mjs
```

The smoke script (also `npm run test:exe`; NOT part of `npm test`) copies the
exe to a fresh temp dir, spawns it directly, and drives a full game over the
wire — launch → join (2 players + host) → 4× answer/reveal/next → podium —
then asserts the results file and seed materialization landed in `data/`
beside the exe and not in the project tree.

Sandbox note: run the scripts with `node scripts/…mjs` (npm run is blocked
in the deployment sandbox).
