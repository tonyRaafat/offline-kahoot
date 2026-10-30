# Offline Kahoot Clone

A lightweight, offline, Kahoot-style quiz game. One laptop hosts and projects
questions onto a screen; contestants answer from their phones over a local
Wi-Fi hotspot. **No internet and no Docker required** — install once, then run
fully offline.

## Features

- **Host screen** (`/`) — shows the join URL, a 6-digit PIN, and a QR code; live player roster; question/reveal/leaderboard/podium views.
- **Player page** (`/play`) — join with a nickname + PIN, answer in real time, see correctness, points, and rank.
- **Quiz editor** (`/editor`) — create, edit, rename, and delete quizzes; multiple-choice and true/false questions; per-question timer (default 20s); import/export.
- **Kahoot-style scoring** — correct answers earn 0–1000 points scaled by how fast you answer.
- **Offline networking** — auto-detects the LAN IP, self-tests port reachability, and falls back to the next free port (3000–3009).
- **Resilient** — players auto-reconnect on brief Wi-Fi drops without losing their place.
- **Persistent** — quizzes live as one JSON file each; every game's results are saved to a timestamped file.
- **Single executable** — build a self-contained binary that runs with no Node/npm installed.

## Quick start

```sh
npm install
npm start
```

The server prints the host URL and session PIN and serves a QR code on the
host page. Point a browser on the same Wi-Fi at the printed URL (or scan the
QR) to join.

| Page | Purpose |
| --- | --- |
| `/` | Host / projector screen |
| `/play` | Contestants' phones |
| `/editor` | Quiz authoring |

### Run a game

1. Create a Wi-Fi hotspot on the host laptop (the app detects the network, it does not configure it).
2. `npm start`, then open `http://<host-ip>:3000` on the projector.
3. Players open the join URL on their phones, enter the PIN and a nickname.
4. Pick a quiz in the lobby, press **Start game**, and pace the room with **Reveal** / **Next**.

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Run the server (`tsx src/server.ts`) |
| `npm run dev` | Run with watch/reload (`tsx watch`) |
| `npm test` | Run the test suite (`vitest run`) |
| `npm run typecheck` | Type-check (`tsc --noEmit`) |
| `npm run build:exe` | Build a standalone executable (`scripts/build.mjs`) |
| `npm run test:exe` | Build the executable and smoke-test a full game against it |

## Data layout

```
data/
├── quizzes/        # one JSON file per quiz (seed.json ships with the repo)
└── results/        # one results file per game: YYYY-MM-DD_HHmm.json
```

Quizzes and results are runtime data and are git-ignored (except
`data/quizzes/seed.json`). A quiz is shaped like:

```json
{
  "title": "Trivia Night",
  "questions": [
    {
      "prompt": "Which is the largest planet?",
      "type": "multiple-choice",
      "timeSeconds": 20,
      "options": ["Mars", "Jupiter", "Earth", "Venus"],
      "correctIndex": 1
    }
  ]
}
```

`true-false` questions are stored as 2-option questions with `"type": "true-false"`.

## Project structure

```
src/
├── server.ts        # Express + Socket.io entry, routes, boot
├── engine.ts        # pure game engine: reduce(state, event) -> { state, effects }
├── socket.ts        # socket event wiring (join, host controls, answers)
├── storage.ts       # quiz persistence + validation
├── results.ts       # per-game results recording + persistence
├── network.ts       # LAN IP detection, port self-test, free-port fallback
├── state-view.ts    # public projection of game state (hides answers/correct index)
├── sea-assets.ts    # single-executable asset contract
└── *.test.ts        # co-located Vitest tests
public/              # host.html, player.html, editor.html + their JS/CSS
scripts/             # build.mjs (SEA bundle), smoke-exe.mjs
docs/                # single-executable.md
```

## Architecture

The game engine is a **pure, dependency-free reducer** — the single test seam:

```
reduce(gameState, event) -> { state, effects }
```

Every state change (join, answer, reveal, next, end) flows through it, and the
returned effects are broadcast over Socket.io. Scoring, timers, tie-breaking,
and phase transitions are all deterministic (time is passed in explicitly), so
the whole game is unit-testable without sockets or a browser. Everything else
is a thin shell that translates wire/HTTP/file events into engine events.

## Single executable

`npm run build:exe` produces a self-contained binary in `dist/` using Node's
official [Single Executable Application (SEA)](https://nodejs.org/api/single-executable-applications.html)
support — the server, client pages, and seed quiz are embedded, and runtime
data is written to a `data/` folder next to the executable.

> **Cross-compile caveat:** Node SEA cannot cross-compile. The build script is
> cross-platform but produces the binary for the OS it runs on; run it on each
> target OS to get that OS's executable. See `docs/single-executable.md`.

## Stack

TypeScript (strict) · Node ≥ 20 (ESM) · Express 5 · Socket.io 4 · Vitest ·
tsx · qrcode · esbuild (bundling only)

## Development

Work is tracked in `.scratch/offline-kahoot/` (spec + tickets). Tests follow
red→green TDD at the engine seam; run `npm test` and `npm run typecheck`
before committing.
