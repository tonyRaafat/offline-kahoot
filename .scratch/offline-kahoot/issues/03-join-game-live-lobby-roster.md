# 03: Join a game and see a live lobby roster

**What to build:** the socket and HTTP wiring that lets players join a lobby from their phones and the host see them live.

**Blocked by:** 01 (launch an offline-reachable game server), 02 (game engine core)

**Status:** ready-for-agent

- [ ] A player opens the join page on their phone and enters a nickname + PIN
- [ ] A valid PIN joins the lobby; an invalid PIN is rejected with a clear message
- [ ] The host screen lists players live as they join
- [ ] Duplicate nicknames are auto-suffixed per the engine rules
- [ ] The player's phone confirms they are in the lobby
- [ ] Reconnecting a player resumes their existing session rather than duplicating it
