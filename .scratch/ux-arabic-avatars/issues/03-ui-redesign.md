# Status: ready-for-agent

# 03 — Design tokens + full responsive UI redesign (host, player, editor)

Part of `.scratch/ux-arabic-avatars/spec.md`. Read it first and issues 01/02 (their
structure — avatars and i18n hooks — MUST survive this redesign).

Use the project's installed frontend skills for direction. There is already a dark
purple/neon identity (`#2b1e50`, `#3d2b70`, neon `#1affb0`, `#ffd23f`) — modernize it into a
cohesive system rather than starting from a totally different vibe, unless there's a strong
reason.

## Deliverables

1. **Design tokens** (`public/tokens.css`, loaded before other CSS): colors, spacing scale,
   radii, typography scale, elevation/shadows, z-index scale, motion durations/easings.
   Reference them everywhere via `var(--…)`; no more one-off magic values.
2. **Responsive-first host/player/editor layouts**:
   - All three pages work at 360 CSS px width AND typical desktop (≥1440). Host is usually
     displayed big/projected — keep it readable at distance; player is phone-first with
     large touch targets (≥44 px), thumb-reachable answer buttons.
   - Fluid type/space where it helps. No horizontal overflow at small sizes; testable.
3. **Component refresh** (all through tokenized CSS): buttons (primary/secondary/danger),
   inputs, answer cards (with the existing answer colors), timer, phase cards, table/list
   rows for lobbies/leaderboards/podium, QR block on host, editor form rows, toasts/errors,
   avatar rendering polish (from 01), EN/AR toggle polish (from 02), focus-visible rings,
   hover/active states, reduced-motion media query support (prerequisite for issue 04).
4. **Micro-details**: sensible empty states (e.g. no players in lobby, no quizzes in
   editor list), aria labels on interactive elements, visible focus, keyboard operability.

## Constraints

- Vanilla HTML/CSS/JS only — NO framework, no build step. Keep SEA compatibility (if you
  reference new static assets, check `sea-assets.ts`/server static handling and keep the
  file list in sync with how `public/` is embedded).
- DOM behavior: list rebuilds via `replaceChildren` may stay for now (issue 04 replaces the
  leaderboard rendering with FLIP animation later — structure markup so rows carry stable
  `playerId`-derived keys/ids to make that tractable).
- Do not change game logic, scoring, or wire contract in this ticket. Only presentation.

## Validation

- `npx vitest run` (should still pass untouched; add/update nothing server-side).
- Manual smoke at 360 px and 1440 px on all three pages, in both languages (avoids
  mistruncated Arabic), through a full game (join → 2 questions → podium → end game).
