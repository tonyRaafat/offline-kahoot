# public/fonts — self-hosted display font (admin-dashboard issue 05)

Typeface: **Montserrat** (SIL Open Font License 1.1).

- Source font: https://github.com/JulietaUla/Montserrat — packaged woff2
  subsets taken from https://github.com/fontsource/font-files
  (`@fontsource/montserrat@5.3.0`), latin + latin-ext, weights 400 / 700 / 800.
- License: see `Montserrat-OFL.txt` (SIL OFL 1.1 — free to use, bundle, and
  redistribute; no external network requests are made at runtime, the files
  ship inside `public/` and the SEA executable).
- `montserrat-latin-{400,700,800}-normal.woff2` etc. are referenced with
  `unicode-range` from `public/tokens.css` (`@font-face` blocks).
- Arabic: Montserrat has no Arabic glyph set. Arabic strings fall through the
  `--font-display` / `--font-body` stacks to the system Arabic-capable fonts
  (per-glyph fallback — an explicit, recorded decision from issue 05; do NOT
  ship a broken Arabic rendering by removing the system fallbacks).
