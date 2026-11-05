# Status: ready-for-human
# (implemented — see Comments)

# 02 — Arabic/English localization with per-device toggle + RTL

Part of `.scratch/ux-arabic-avatars/spec.md`. Read it first and `issues/01-avatar-identity.md`
for context on new join-screen strings.

## Approach

No i18n framework, no build step. Small hand-rolled system:

1. `public/i18n.js` (plain script, loaded before page scripts): an `EN` and `AR` string map
   keyed by stable ids, e.g. `t('join.join')`. Include ALL user-facing strings from
   host.html, player.html, editor.html and the JS-generated strings in *.js
   (error/reject reason keys like `nameTaken`, `colorRejected`, timer labels, phase labels,
   podiium text, host controls, editor form labels, confirmations).
2. Static HTML: add `data-i18n` (text) and `aria-label`/`placeholder` attributes get
   `data-i18n-attr="placeholder:key"` style hooks; on load and on toggle, re-apply.
3. JS-generated content: always go through `t(key)`; when the language toggles, re-render
   the current screen (the pages already re-render on `state` pushes — add one explicit
   re-render on language change).
4. Language state:
   - First visit: detect from browser (`navigator.languages` — if any entry starts with
     `'ar'` → ar, else en).
   - Persist choice in localStorage (`offline-kahoot:lang`).
   - A visible EN/AR toggle on every page (host top bar, player join header, editor top bar),
     styled as a small segmented control.
   - `<html lang="...">` updated; when `ar` → `<html dir="rtl">`.

## Arabic quality bar

- Native-sounding Arabic for every string (not machine-literal). e.g. لقب/اسم اللاعب for
  nickname, عرض النتائج for results, استخدام this sort of phrasing. If unsure of a term, keep
  it simple and unambiguous.
- RTL mirror properly: flex/absolute layouts flip, arrows and directional animation
  indicators flip, text-align aligned naturally. Prefer CSS logical properties
  (`margin-inline-start`, `inset-inline-end`, `text-align: start`) so most things flip for
  free with `dir="rtl"` — leave a notes comment where a hard override was needed.
- Arabic digits: keep Western digits (scores, PIN, timer) for consistency — do NOT use
  Arabic-Indic numerals.

## Constraints

- Wire contract unchanged; `lang` is NOT sent to the server (per-device only).
- Editor translations too (labels, buttons, toasts).
- Quiz content JSON (question/option text the user typed) is out of scope — localize
  chrome only.

## Validation

- `npx vitest run` (server unaffected — mostly no-op here).
- Manual: toggle on each page; join screen, lobby, question, reveal, leaderboard, podium,
  and editor in Arabic render RTL and all readable; nothing is clipped or overridden.

## Comments

2026-11-01 — worker-02-i18n: Implemented. New `public/i18n.js` (plain script, loaded before page modules): EN+AR maps keyed by stable ids, `t(key, params)` with `{placeholder}` interpolation, `I18n.set/clear` for dynamic lines (auto re-translated on toggle), `data-i18n` / `data-i18n-attr` hooks for static HTML, EN/AR segmented toggle injected on all three pages, first-visit detection (`navigator.languages` any `ar*`), persistence at `offline-kahoot:lang` (never sent to server), `<html lang>` + `dir="rtl"` switching. All host/player/editor strings keyed incl. `nameTaken`/`colorRejected` from issue 01, join errors, answer rejects, timer/phase labels, editor labels/validation/confirmations; quiz content left untranslated; Western digits kept. All three pages re-render the current screen on toggle (`I18n.onChange`). RTL mirroring via logical properties in host.css/editor.css (`text-align: start`, `margin-inline-end`, `float: inline-end`, `padding-inline-start`, `inset-inline-end`), plus targeted `html[dir='rtl']` overrides relaxing letter-spacing (breaks Arabic joining). `public/i18n.js` added to the SEA bundle contract (`src/sea-assets.ts` + its test). Verified: vitest 130/130, tsc clean, live CDP run of a full game in EN and AR (lobby/question/reveal/leaderboard/podium + `/editor` in both languages) with screenshots — Arabic shaping/RTL clean, no clipping, toggle re-renders cleanly in both directions. Residual risks (see report): server-authored validation strings (e.g. storage.ts quiz-validation errors passed verbatim into the editor error list) remain English; statuses like server API error bodies interpolate English detail text.

## Comments

2025 — Orchestrator: Implemented by worker-02-i18n (session aborted once, resumed losslessly). public/i18n.js (~123 keys/lang) with t()/interpolation, data-i18n hooks, per-device detection + persistence (offline-kahoot:lang, never sent to server), lang/dir switching, auto-injected EN/AR segmented toggle on all three pages, RTL via logical properties. All user-facing strings keyed incl. join errors; missing reveal + host keys caught during live validation. Verified live in headless Chromium incl. full Arabic game flow. Known deferred: server-authored validation strings remain English (out of scope); simplified Arabic pluralization; toggle placement handed to issue 03. Vitest 130/130, tsc clean. Status: DONE.
