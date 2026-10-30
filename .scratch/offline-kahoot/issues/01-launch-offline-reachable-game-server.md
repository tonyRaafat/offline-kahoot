# 01: Launch an offline-reachable game server

**What to build:** `npm start` boots a server that auto-detects the machine's LAN IP address, generates a session PIN, renders a host page showing the join URL, PIN, and QR code, and self-tests that the port is reachable from the local network.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `npm install && npm start` boots the server with no manual configuration
- [ ] The server detects the machine's LAN IP on Windows, macOS, and Linux
- [ ] A host page renders showing the join URL, a 6-digit PIN, and a QR code
- [ ] The server self-tests port reachability and reports success or failure
- [ ] A phone on the same Wi-Fi can load the host page
- [ ] If the default port is busy, the server falls back to the next free port and reflects it in the join URL
