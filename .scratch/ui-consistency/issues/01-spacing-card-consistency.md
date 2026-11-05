# Status: ready-for-agent

# 01 Spacing + card consistency across all screens

Part of `.scratch/ui-consistency/spec.md`. Read it first.

## Deliverables

1. **`public/tokens.css`** — add semantic spacing aliases over the existing `--sp-1..8`
   scale (e.g. `--space-control`, `--space-card`, `--space-section`). Fix
   `line-height: var(--sp-5)` coupling (use a real line-height token). Standardize one
   radius treatment for cards vs. controls.
2. **`public/host.css`** — collapse drifting control heights (`2.25rem` / `2.75rem` /
   `3rem` / `3.25rem` / `3.5rem`) into one consistent height scale. Standardize button gap
   rhythm (no 0.5rem stacked buttons). Consistent `:focus-visible` and disabled states.
   Give host/player phase screens real vertical rhythm between lists and buttons (no reliance
   on `<p>` UA margins). Remove dead CSS (`.quiz-actions`, `.share-detail`).
3. **`public/dashboard.css`** — quiz cards fully uniform: equal-width columns incl. last
   partial row, equal-height cards via grid rows, title clamped to 2 lines (full title via
   `title` attr in `dashboard.js`). Align card radius/padding with `.card`. Fix the
   `minmax(17rem)` magic width. Standardize card button heights; increase stacked
   Start/Edit gap.
4. **`public/editor.css`** — apply `.questions-list` grid (add the class in `editor.js` or
   use the existing CSS), remove margin-based card spacing + dead CSS, fix title-row button
   cluster gap (`gap:var(--sp-2)` too tight), align `.ed-input` with shared inputs.
5. **`public/login.html` + `public/login.css`** — make login load `host.css`, delete
   duplicated component styles (`.card`, `.label`, `.player-input`, `.player-button`,
   `.errors`, `.lang-toggle`), keep only login-specific layout. Login button becomes the
   standard rounded button.

## Constraints

- Vanilla HTML/CSS/JS. No framework, no build step. SEA compatibility must hold.
- Preserve i18n hooks (`data-i18n`), avatar rendering, leaderboard animation classes.
- No palette/typography change. Keep `prefers-reduced-motion` respected.

## Verify

- `npm run typecheck` and `npm test` green.
- `npm start` boots; all five surfaces render at ~360px and ≥1440px without horizontal
  overflow.

## Comments

- Implemented by worker (spacing-worker): tokens semantic aliases + control-height scale, shared button/focus/disabled unification, dashboard uniform quiz-card grid + 2-line title clamp, editor questions-list grid, login fully unified into host.css (server.ts asset split updated + auth test).
- Independent review (scout) found `.card-head`→`.card::before` bug (fixed) and no identity drift.
- Browser-DOM verification (headless Chromium, CDP): dashboard cards 0px width/height spread (desktop 301.2px × 312.4px, phone 263px × 300.3px); stacked control gaps all ≥12px (no 8px/0px); login password→submit gap 16–18px; player color-picker→Join gap 16px; host header visible; no horizontal overflow at 360px/1440px.
- `npm run typecheck` pass, `npm test` 169/169 pass.
