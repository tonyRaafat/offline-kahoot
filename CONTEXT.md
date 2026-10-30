# Offline Kahoot Clone — Context

## Product

A lightweight, offline, Kahoot-style quiz game. One laptop hosts and projects questions; contestants answer from their phones over a local Wi-Fi hotspot. No internet, no Docker. Runs with `npm install && npm start`, and can be bundled to a single executable.

## Stack (decided)

- TypeScript, strict mode
- Node.js ≥ 20, ESM (`"type": "module"`)
- Express (HTTP + static), Socket.io (realtime)
- Vitest (tests), tsx (dev runner), `tsc --noEmit` (typecheck)
- `qrcode` (pure-JS QR, server renders a data URL)
- Bundle (ticket 08): single executable per OS, no Node required — Node SEA or pkg; keep static assets inline-able

## Scripts (package.json)

- `npm start` → `tsx src/server.ts`
- `npm run dev` → `tsx watch src/server.ts`
- `npm test` → `vitest run`
- `npm run typecheck` → `tsc --noEmit`

## Directory layout

```
src/          server entry, engine, network, pin, storage, socket wiring
public/       static client pages: host, player, editor (HTML/CSS/JS)
data/         quizzes/*.json and results/*.json (results gitignored; seed quiz committed)
*.test.ts     co-located Vitest tests
```

## Domain vocabulary

- **Quiz** — `{ title, questions: Question[] }`
- **Question** — `{ prompt, type: 'multiple-choice' | 'true-false', timeSeconds, options: string[], correctIndex }` (true/false is a 2-option multiple-choice internally)
- **GameState** — `{ phase, quiz, players, scores, questionIndex, timerDeadline }`
- **phase** — `'lobby' | 'question' | 'reveal' | 'leaderboard' | 'podium'`
- **Event** — `startQuiz`, `playerJoin`, `playerAnswer`, `reveal`, `next`, `end`
- **Effect** — outbound signals (e.g. `broadcastState`, `broadcastReveal`) consumed by the socket layer
- **reduce** — `reduce(gameState, event) -> { state, effects }` (the single pure seam)

## The single test seam

The game engine (`src/engine.ts`) is pure and is the primary unit-test seam: `reduce(state, event) -> { state, effects }`. Tests assert external behavior (the resulting state and emitted effects), never internals. Expected values come from independent sources (known-good literals / worked examples), never recomputed the same way as the code.

## Scoring

- correct → `round(1000 × remainingMs / totalMs)`
- wrong → 0; no penalties
- answers submitted after the timer expires are rejected

## Conventions

- One quiz = one JSON file in `data/quizzes/`.
- Results saved per game to `data/results/YYYY-MM-DD_HHmm.json`.
- Default port 3000, auto-increment if busy.
- Session PIN: random 6 digits, regenerated per session.
- Duplicate nickname → auto-suffix (`Tony` → `Tony-2`).
- Tickets live in `.scratch/offline-kahoot/issues/`; implement them in numeric order.
