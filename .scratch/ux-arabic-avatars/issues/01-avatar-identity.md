# Status: ready-for-human
# (implemented — see Comments)

# 01 — Avatar identity + unique-name enforcement

Part of `.scratch/ux-arabic-avatars/spec.md`. Read it first.

## Server

In `src/join.ts`, `src/engine.ts`, `src/state-view.ts`, `src/game-session.ts`:

1. `join` payload gains `color` — validated as one of exactly these keys:
   `red, orange, blue, green, pink, white, yellow, brown, black, grey`.
   Invalid/missing color → reject join with a reason (localized client-side later; key it,
   e.g. `colorRejected`).
2. Store `color` on the `Player` record in state so the engine reducer keeps it through
   dispatches and it survives reconnect/resume (existing `playerId` flow keeps name+color).
3. Name uniqueness: reject a duplicate name at join with reason key `nameTaken` INSTEAD of
   auto-suffixing (`Tony` → `Tony-2` goes away). Emit through the existing answer-reject-like
   error path (`joinError` already exists — reuse it).
4. `StateView.players` entries gain `color` (still no `correctIndex` leakage — keep the
   projection pure).

## Client (player.html / player.js)

5. Join form gains the 10-color picker: a single row/grid of color swatches, persisted to
   localStorage (new key, e.g. `offline-kahoot:avatarColor`) alongside the existing playerId
   key. Default a sensible color (e.g. first one) rather than none when unset.
6. Render the avatar everywhere a player appears on BOTH screens: lobby list, leaderboard
   rows, podium — a circle in the chosen color with the first letter of the name, letter
   auto white or dark (pick via simple perceived-luminance threshold so e.g. white/yellow
   avatars get dark letters and brown/grey get white letters).
7. Host screen (host.html/host.js) shows avatars in its player lists too (same component
   logic — factor a tiny shared helper if practical; there is no bundler, so either a small
   shared `public/avatar.js` script tag or a well-known duplicated function is fine).

## Constraints

- Keep the documented socket wire contract in `src/socket.ts` updated with the new fields.
- No CSS reskin in this ticket (comes in issue 03) — just wire the structure in cleanly with
  minimal, temporary styles.
- Update co-located Vitest suites (`join.test.ts`, `engine.test.ts`, `state-view.test.ts`,
  etc.) for: duplicate-name rejection, color validation, color persistence in state,
  `color` in StateView.

## Validation

- `npx vitest run`
- Manual: join two players with the same name → second rejected; same color → allowed.

## Comments

2025 — Orchestrator: Implemented by worker-01-avatars (aborted near completion, changes were nearly finished); gaps fixed by worker-01-fix. Reviewer verified server behavior live (dup name → nameTaken, dup color allowed, resume restores stored color+name, bad color → colorRejected on fresh joins). player.js crash fixed; smoke-avatar.tmp.mjs deleted. Status: DONE — vitest 130/130, tsc clean.
