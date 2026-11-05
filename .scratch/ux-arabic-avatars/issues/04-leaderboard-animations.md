# Status: ready-for-agent

# 04 — Animated leaderboard between questions + podium

Part of `.scratch/ux-arabic-avatars/spec.md`. Depends on issues 01–03 (avatars on rows,
i18n hooks, tokens/CSS with motion tokens and reduced-motion support). Read them first.

## Behavior

Fires during the `leaderboard` phase after every question, and during the transition into
`podium` (top-3 highlight).

**Host screen:**
- Full leaderboard list; when a new `state` arrives with a different order, rows MOVE to
  their new positions (FLIP: measure old rect → reorder → measure new rect → invert → play,
  or simpler: animate `transform: translateY` between slot positions and keep rows
  absolutely-positioned in slots — pick ONE approach and keep it clean).
- Score count-up animation (from previous value to new value, eased — requestAnimationFrame,
  using motion tokens; respect `prefers-reduced-motion` → jump straight to final value).
- Rank-change indicators: `▲`/`▼` (RTL-flipped direction) with the number of places gained /
  lost, colored by gained/lost, visible briefly then fade.
- Because the client currently rebuilds lists but only receives `leaderboard: playerId[]`
  + `scores` (no rank deltas), compute rank changes client-side by remembering the previous
  render. No server change REQUIRED; if a server-side tweak is genuinely needed, keep it
  additive to StateView and note it in the report.

**Player screen:**
- Personal rank card first: shows the player's own row emphasized with each rank change
  animated ("moved up ↑ … #4 → #2", using `t()` keys from issue 02 for the copy).
- Same animated board below the personal card, exactly like the host treatment.
- Emphasize the player's own row within the board too (subtle accent, not another full card).

**Podium:**
- Top-3 gets a celebratory treatment (order/count-up carry over; modest confetti-style or
  scale/delay entrance — reuse tokens, keep restrained; the project is a party game so
  tasteful playfulness is on brand).

## Constraints

- Retrieval-free: animations must not break the client's ability to answer the NEXT question
  (phase transitions come via `state` events; cancel any in-flight animation on a new state
  — don't queue). If the next question starts quickly, the leaderboard still needs to be
  legible — consider a short min-display/hold via the host's natural pacing, NOT a
  client-side artificial delay that blocks the host's Next button.
- Rows must have stable DOM identity keyed by `playerId` (from issue 03's markup contract).
- Reduced motion: all animations degrade to instant (or simple fades).

## Validation

- `npx vitest run`.
- Manual with 4–6 joined players across different orders: reorder is smooth, count-ups
  land on exact final values, rank arrows correct in both EN and AR (direction flips),
  no interference with answering the next question.
