import { createServer } from 'node:http';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import { GameSession } from './game-session.js';
import { wireSockets } from './socket.js';
import { generatePin } from './pin.js';
import { detectLanIp, formatJoinUrl, isPortReachable, listenOnFreePort } from './network.js';

const DEFAULT_PORT = 3000;
const PORT_MAX_RETRIES = 9; // 3000..3009 per "default port 3000, auto-increment if busy"
const LOG_PREFIX = '[offline-kahoot]';

const app = express();
// One http server hosts both the HTTP routes and socket.io, so players join
// over the same host/port the QR code points at.
const httpServer = createServer(app);
const here = path.dirname(fileURLToPath(import.meta.url));

app.use(express.static(path.join(here, '..', 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(here, '..', 'public', 'host.html'));
});

app.get('/play', (_req, res) => {
  res.sendFile(path.join(here, '..', 'public', 'player.html'));
});

app.get('/api/session', async (_req, res) => {
  res.json(session());
});

function session(): { pin: string; joinUrl: string; qrDataUrl: string } | null {
  return (app.locals.session as { pin: string; joinUrl: string; qrDataUrl: string } | null) ?? null;
}

// The one live session for this server process. The placeholder quiz is
// swapped in by the editor/loading ticket; lobby joins work with it as-is.
const gameSession = new GameSession({ title: '', questions: [] });

const pin = generatePin();
wireSockets(new Server(httpServer), { gameSession, sessionPin: pin });
const lanIp = await detectLanIp(process.platform);
if (!lanIp) {
  console.warn(`${LOG_PREFIX} could not detect a LAN IP; players may need the host's address manually`);
}
const hostIp = lanIp ?? '127.0.0.1';

listenOnFreePort(
  httpServer,
  DEFAULT_PORT,
  PORT_MAX_RETRIES,
  async (port) => {
    const joinUrl = formatJoinUrl(hostIp, port);
    app.locals.session = {
      pin,
      joinUrl,
      qrDataUrl: await QRCode.toDataURL(joinUrl),
    };

    const reachable = await isPortReachable(hostIp, port);
    console.log(`${LOG_PREFIX} host page: ${joinUrl}`);
    console.log(`${LOG_PREFIX} session PIN: ${pin}`);
    console.log(
      reachable
        ? `${LOG_PREFIX} port self-test PASS: ${hostIp}:${port} is reachable`
        : `${LOG_PREFIX} port self-test FAIL: ${hostIp}:${port} is NOT reachable — check firewall/host isolation`,
    );
  },
  (err, port) => {
    console.error(
      err.code === 'EADDRINUSE'
        ? `${LOG_PREFIX} no free port found between ${DEFAULT_PORT} and ${port}`
        : `${LOG_PREFIX} failed to listen on port ${port}: ${err.message}`,
    );
    process.exit(1);
  },
);

// Unhandled promise rejections would mask the boot logs above; surface them loudly.
process.on('unhandledRejection', (reason) => {
  console.error(`${LOG_PREFIX} unhandled rejection:`, reason);
  process.exit(1);
});

