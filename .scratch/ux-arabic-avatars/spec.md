# Spec: Elevated UX — redesign, animated leaderboard, avatar identity, EN/AR localization

Status: agreed (user-confirmed decisions below)

## Goal

Elevate the Offline Kahoot experience on all three pages (`/` host, `/play` player, `/editor`)
with a cohesive modern redesign that is fully responsive (players on phones, host on laptop),
add an animated leaderboard between questions, give players a unique name + color avatar,
and support Arabic and English per device.

## Decisions (confirmed with user)

- **Scope**: full redesign including `/editor`. Keep vanilla HTML/CSS/JS, no framework, no
  build step (SEA single-executable must keep working — `public/` is embedded).
- **Device priority**: players almost always join from a phone with the PIN; the host screen
  is usually a laptop/projector. Design accordingly, but all pages stay usable on both.
- **Language**: each user picks their own EN/AR independently; auto-detected from the browser
  on first visit; choice persisted per device (localStorage). Host language does NOT affect
  players. Full RTL mirroring in Arabic. Quiz content (user-authored) is NOT translated —
  only UI chrome, labels, buttons, and error/reject messages.
- **Identity**: player = unique name + avatar color. Duplicate names are REJECTED with a
  localized "name is taken" error (replacing today's auto-suffix `Tony-2`). Rejoins by an
  existing `playerId` (localStorage) keep their name. Avatar = colored circle with the
  player's first letter (white or dark auto-contrast letter). Duplicated colors are fine.
  Avatar shown in lobby lists, leaderboards, podium on both screens.
- **Color choices**: exactly these 10 — red, orange, blue, green, pink, white, yellow,
  brown, black, grey. Color is persisted server-side per player and client-side in
  localStorage; reconnect restores it.
- **Leaderboard**: already exists logically (phase fires between every question; podium at
  the end). Add animations: host gets the full animated list — rows smoothly reordering as
  ranks change (FLIP-style moves of existing DOM nodes, not full rebuilds), score count-ups,
  rank-change indicators; player gets a personal animated rank card ("moved up ↑ #4 → #2")
  plus the same animated board below. Same treatment on the podium transition.

## Non-goals

- No accounts, no login, no avatar image/emoji upload (color only).
- No quiz-content translation.
- No new server framework; keep the engine reducer, socket wire-contract shape, and
  Express routes as-is except for the additions listed in the tickets.

## Implementation order & issues

1. `issues/01-avatar-identity.md` — avatars + unique-name rejection (server + client)
2. `issues/02-arabic-english-localization.md` — i18n catalog, per-device toggle, RTL
3. `issues/03-ui-redesign.md` — design tokens + responsive redesign of all three pages
   (must preserve i18n hooks and behavior from 01/02)
4. `issues/04-leaderboard-animations.md` — FLIP animations, count-ups, personal rank card
   (on the final markup/CSS from 03)

## Verification

- `npx vitest run` green after each issue.
- Manual smoke: boot server, host a game from laptop-width viewport, join from a
  phone-width (≤ 420 CSS px) viewport, answer, reveal, leaderboard, podium, end game.
- Arabic toggle on both screens renders RTL without layout breakage.
