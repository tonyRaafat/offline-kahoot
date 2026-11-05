# Spec: Spacing + card consistency pass (all screens)

Status: agreed (user-confirmed decisions below)

## Goal

Fix spacing inconsistencies across the whole app and make quiz cards fully uniform in
width and height. Preserve the existing dark-purple/neon identity (from `ux-arabic-avatars`
03) and do light visual polish only — no palette/typography change, no layout-direction
change.

## Decisions (confirmed with user)

- **Scope**: all screens — dashboard (`/`), host, player, editor, AND login. Login's
  duplicated component styles get fully unified into the shared `host.css`.
- **Quiz cards**: fully uniform grid — same width (incl. last partial row) AND same height.
  Title clamped to 2 lines with full title as a tooltip.
- **Identity**: preserve current identity (Montserrat, `#2b1e50`/`#3d2b70`, neon
  `#1affb0`/`#ffd23f`); light polish of radii/shadows/focus states.
- **Buttons**: one consistent control-height scale; no 0.5rem stacked buttons; consistent
  gap rhythm between controls.
- **Verification**: run app + browser screenshots (desktop + phone) across all surfaces;
  `npm test` + `npm run typecheck` green.

## Approach

Treat `tokens.css` → `host.css` → per-page sheets (`dashboard.css`, `editor.css`) as one
system. Add semantic spacing aliases over the existing `--sp-1..8` scale, standardize one
radius/height/focus treatment, kill reliance on browser `<p>` margins, remove dead CSS.

## Constraints

- Vanilla HTML/CSS/JS only. No framework, no build step. Keep SEA single-executable working
  (static assets stay as-is, referenced by path).
- Preserve i18n hooks (data-i18n attributes), avatar rendering, and leaderboard animations.

## Implementation order

1. `issues/01-spacing-card-consistency.md` — tokens + shared components + per-page fixes
   (this is the single implementation ticket; details live there).
