# Offline Kahoot Clone

A lightweight, offline Kahoot-style quiz game (TypeScript + Node ≥ 20, ESM):
one laptop hosts; contestants answer on phones over a local Wi-Fi hotspot.
No internet or Docker required.

## Quick start

```sh
npm install
npm start           # tsx src/server.ts — print a QR code to join
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

Runtime files: one JSON per quiz in `data/quizzes/`, finished games in
`data/results/YYYY-MM-DD_HHmm.json`.

## Single executable (no Node/npm on the target machine)

`npm run build:exe` (or `node scripts/build.mjs`) produces a self-contained
executable in `dist/` via Node's official Single Executable Application (SEA)
support, with the client pages and the seed quiz embedded and runtime data
(quizzes, results) written to a `data/` folder next to the executable.
See `docs/single-executable.md` — including the caveat that Node SEA cannot
cross-compile: the same script must be run on each target OS.
`node scripts/smoke-exe.mjs` drives a full game against the built executable.
