# 02: Game engine core (state machine + scoring)

**What to build:** a pure, dependency-free game engine that reduces `(gameState, event)` into `(state, effects)`, covering every phase and rule of the game.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Engine transitions through lobby → question → reveal → leaderboard → podium
- [ ] Events supported: start quiz, player join, player answer, reveal, next, end
- [ ] Correct answers score `round(1000 × remainingMs / totalMs)`; wrong answers score 0; no penalties
- [ ] Answers submitted after the per-question timer expires are rejected
- [ ] Duplicate nicknames get an auto-suffix (e.g. Tony → Tony-2)
- [ ] Leaderboard orders players by score with deterministic tie-breaking
- [ ] Quiz completion transitions to a podium
- [ ] The engine is pure (no I/O) and covered by unit tests at this seam
