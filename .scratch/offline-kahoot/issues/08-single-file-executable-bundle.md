# 08: Single-file executable bundle

**What to build:** a build that produces self-contained, offline-runnable executables for each operating system.

**Blocked by:** 07 (finish a game: podium, saved results, back to lobby)

**Status:** ready-for-agent

- [ ] A build script produces executables for Windows, macOS, and Linux
- [ ] The bundle runs the full app offline with no Node/npm installed
- [ ] Data (quizzes, results) is written to a folder next to the executable
- [ ] A smoke test exercises launch → join → answer → podium on the bundle
