Status: ready-for-agent

# Spec: Offline Kahoot Clone (MVP)

## Problem Statement

The user wants to run a lightweight, real-time, Kahoot-style quiz game in places with no internet connection — a classroom, a family game night, a community event — where one laptop projects questions onto a screen and contestants answer from their phones over a local Wi-Fi hotspot. Existing tools require an internet connection, a Docker install, or a heavyweight setup. The user can install Node.js or Python easily, but installing Docker is a hassle, and the game must run fully offline after a couple of launch commands on any Windows, macOS, or Linux machine.

## Solution

A single Node.js process serves three surfaces over the local network: a host screen (projector), player pages (phones), and a quiz editor. The host creates a Wi-Fi hotspot on their laptop; the app auto-detects the LAN IP, displays a join URL plus a 6-digit PIN and QR code, and self-tests reachability. Players join by nickname, answer multiple-choice and true/false questions in real time over WebSockets, and see a live leaderboard. Points are awarded speed-based (0–1000 scaled by remaining time). Quizzes are authored in a built-in editor and stored as JSON files; results are saved to file after each game. The app works offline after a one-time `npm install`, and can also be bundled into a single executable.

## User Stories

1. As a host, I want to launch the game with a couple of terminal commands, so that I can start a game quickly without configuration.
2. As a host, I want the app to run fully offline after installation, so that the game needs no internet at runtime.
3. As an operator, I want to install and run via `git clone` + `npm install` + `npm start`, so that setup is familiar and standard.
4. As an operator, I want a single-file executable option, so that I can run the game on a machine without installing Node/npm.
5. As an operator, I want the app to work on Windows, macOS, and Linux, so that I can host from whatever machine is available.
6. As a host, I want the app to detect my machine's LAN IP automatically, so that I don't have to find and type it manually.
7. As a host, I want the app to display the join URL and a 6-digit PIN on the host screen, so that players can connect without me reading an IP aloud.
8. As a host, I want the app to show a QR code, so that players can join by scanning instead of typing.
9. As a host, I want the app to self-test that its port is reachable, so that I find out immediately if a firewall or the hotspot blocks connections.
10. As a host, I want to create a new quiz in a built-in editor, so that I don't need external tools or hand-editing files.
11. As a host, I want to edit and delete my quizzes, so that I can keep the quiz list current.
12. As a host, I want to add multiple-choice questions with 2–4 options and one correct answer, so that I can build standard quiz rounds.
13. As a host, I want to add true/false questions, so that I can mix in quick binary questions.
14. As a host, I want to set a per-question countdown (default 20 seconds), so that each question gets an appropriate time limit.
15. As a host, I want my quizzes saved automatically to a JSON file, so that they persist between sessions.
16. As a host, I want to import and export a quiz as a JSON file, so that I can move quizzes between machines.
17. As a host, I want to pick which quiz to play from a list, so that I can run different games.
18. As a host, I want a lobby screen showing the PIN, QR code, join URL, and a live list of joined players, so that I know when everyone is ready.
19. As a host, I want to start the game only when I choose, so that players can join at their own pace before the first question.
20. As a host, I want to advance questions and reveal answers with click-only buttons, so that I can run the game with just a mouse.
21. As a host, I want the countdown to run automatically per question, so that the room stays paced without me timing it manually.
22. As a host, I want to see who answered correctly after revealing, so that I can react to the room.
23. As a host, I want a live leaderboard after each question and a final podium, so that the room sees standings.
24. As a host, I want the results of each game saved to a file automatically, so that I can review scores later.
25. As a host, I want to end the game and return to the lobby, so that I can run another game without restarting the app.
26. As a contestant, I want to join by entering a nickname and the PIN, so that I can get into the game from my phone.
27. As a contestant, I want to be warned if my nickname is taken and receive an auto-suffixed name, so that I can join without confusion.
28. As a contestant, I want to see the question and answer choices on my phone, so that I can answer without looking at the projector.
29. As a contestant, I want to submit exactly one answer per question, so that my selection is recorded before the timer ends.
30. As a contestant, I want feedback on whether my answer was submitted and whether it was correct, so that I know my status.
31. As a contestant, I want to see my score update between questions, so that I know how I'm doing.
32. As a contestant, I want to see the live leaderboard, so that I can track my rank.
33. As a contestant, I want to survive brief Wi-Fi drops without losing my place, so that a flaky connection doesn't kick me out (auto-reconnect).

## Implementation Decisions

- **Runtime and process model**: a single Node.js process serves everything; Express for static files and HTTP, Socket.io for real-time sync. No native dependencies, so the project stays bundleable into a single executable via pkg/esbuild alongside the standard `npm start` workflow.
- **Modules**: a pure game engine (state machine + scoring), a thin socket/HTTP shell that translates network events into engine events and broadcasts engine effects, quiz storage (JSON file I/O), and three UIs (host, player, editor).
- **Single test seam**: the game engine is pure and dependency-free; the reducer maps `(gameState, event) -> { state, effects }`. All gameplay rules live here; the shell performs no logic.
- **Game phases**: `lobby` → `question` → `reveal` → `leaderboard` → (repeat) → `podium`.
- **Scoring**: speed-based 0–1000 for a correct answer; 0 for a wrong answer; no penalties. Formula: `round(1000 × remainingMs / totalMs)`.
- **Timer**: per-question countdown, default 20 seconds, editable per question in the editor.
- **Question types**: multiple choice (2–4 options) and true/false. True/false is modeled internally as a 2-option multiple-choice question.
- **Join flow**: a random 6-digit PIN per session, a QR code, and a duplicate-nickname guard that auto-suffixes (`Tony`, `Tony-2`).
- **Access control**: trust + PIN only; no accounts, auth, or kicking (see Out of Scope).
- **Quiz persistence**: one JSON file per quiz, plus import/export. The quiz shape (agreed decision shape) is:
  ```json
  {
    "title": "Quiz title",
    "questions": [
      {
        "prompt": "Question text",
        "type": "multiple-choice",
        "timeSeconds": 20,
        "options": ["A", "B", "C", "D"],
        "correctIndex": 1
      }
    ]
  }
  ```
- **Results persistence**: each game's results are appended to a timestamped file in a local `data/` folder.
- **Networking**: assume the hotspot is already up; auto-detect the LAN IP per OS, print the join URL + PIN, and self-test port reachability. Default port 3000, auto-incrementing if busy.
- **Data location**: quizzes and results live in a `data/` folder next to the app, portable across the npm and bundle run modes.

## Testing Decisions

- **What makes a good test**: only external behavior (game rules) is tested — feed events into the engine and assert the resulting state and emitted effects. No coupling to HTTP, sockets, the filesystem, or the UI.
- **Modules tested**: the game engine only (the single seam).
- **Prior art**: none — this is a greenfield project, so these tests establish the pattern.
- **Cases to cover**: phase transitions; correct vs. wrong scoring; scoring boundary values (full time → 1000, near-zero remaining → low); late answers after the timer expires; duplicate-nickname suffixing; leaderboard ordering and tie-breaking; per-question timer expiry; quiz completion transitioning to the podium.

## Out of Scope

- Host-approved lobby, kicking players, and mid-game lobby locking (trust + PIN only for MVP).
- Accounts, authentication, and persistent player identity.
- Streaks, power-ups, double-points, and other full-Kahoot gamification.
- Open-ended/text answers and image/media questions.
- Host remote control from a second device (click-only host for MVP).
- Auto-configuring or enabling the hotspot (assume Wi-Fi is already up; only detect and self-test).
- In-app browsable history/replay UI (results are saved to file but not browsable in-app).
- Scaling beyond ~30 concurrent players.
- Importing quizzes from Kahoot or Excel.

## Further Notes

- "Offline" means no internet at runtime; a one-time internet connection is acceptable to install dependencies or download the bundle.
- The npm workflow and the single-file bundle must stay in sync: the architecture forbids native npm dependencies to keep bundling simple.
- The feature slug for tracking is `offline-kahoot`; issues and the map live under `.scratch/offline-kahoot/`.
