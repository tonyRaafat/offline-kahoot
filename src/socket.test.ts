// Socket-level smoke test: boots a minimal http.Server + socket.io with the
// real wireSockets() wiring and drives the join contract end to end —
// joinError on a bad PIN, `joined`+`state` on a valid join, duplicate-name
// suffixing across the wire, and reconnect resuming the same player.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { GameSession } from './game-session.js';
import { wireSockets } from './socket.js';

const SESSION_PIN = '123456';
let httpServer: HttpServer | undefined;
let baseUrl = '';

const clients: ClientSocket[] = [];

beforeAll(async () => {
  const app = expressless();
  httpServer = createServer(app);
  wireSockets(new Server(httpServer), {
    gameSession: new GameSession({ title: 'Test quiz', questions: [] }),
    sessionPin: SESSION_PIN,
  });
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

// Minimal stand-in for the Express app: wireSockets only needs the http server.
function expressless() {
  return (_req: unknown, res: { end: (s: string) => void }) => res.end('ok');
}

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
});

/** Connects a fresh client socket and waits for the initial connection. */
function open(): ClientSocket {
  const client = connect(baseUrl, { transports: ['websocket'] });
  clients.push(client);
  return client;
}

/** Resolves with the next payload emitted for `event` on `client`. */
function nextEvent<T>(client: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => client.once(event, (payload: T) => resolve(payload)));
}

interface JoinedPayload {
  playerId: string;
  name: string;
}
interface StateViewPayload {
  phase: string;
  quizTitle: string;
  players: Array<{ id: string; name: string }>;
}
interface JoinErrorPayload {
  reason: string;
}

describe('player join socket contract', () => {
  it('rejects a wrong PIN with joinError bad-pin', async () => {
    const client = open();
    const error = nextEvent<JoinErrorPayload>(client, 'joinError');
    client.emit('join', { pin: '999999', name: 'Tony' });
    await expect(error).resolves.toEqual({ reason: 'bad-pin' });
  });

  it('rejects a bad nickname with joinError bad-name', async () => {
    const client = open();
    const error = nextEvent<JoinErrorPayload>(client, 'joinError');
    client.emit('join', { pin: SESSION_PIN, name: '' });
    await expect(error).resolves.toEqual({ reason: 'bad-name' });
  });

  it('accepts a valid join: joined with the id + final name, then broadcast state', async () => {
    const client = open();
    const joined = nextEvent<JoinedPayload>(client, 'joined');
    const state = nextEvent<StateViewPayload>(client, 'state');
    client.emit('join', { pin: SESSION_PIN, name: 'Tony' });

    const joinedPayload = await joined;
    expect(joinedPayload.name).toBe('Tony');
    expect(joinedPayload.playerId).toMatch(/[0-9a-f-]{36}/i);
    const statePayload = await state;
    expect(statePayload.phase).toBe('lobby');
    expect(statePayload.quizTitle).toBe('Test quiz');
    expect(statePayload.players).toEqual([
      { id: joinedPayload.playerId, name: 'Tony' },
    ]);
  });

  it('auto-suffixes duplicate nicknames on the wire (Tony -> Tony-2)', async () => {
    const first = open();
    const joinedFirst = nextEvent<JoinedPayload>(first, 'joined');
    first.emit('join', { pin: SESSION_PIN, name: 'Sofie' });
    await joinedFirst;

    const second = open();
    const joinedSecond = nextEvent<JoinedPayload>(second, 'joined');
    second.emit('join', { pin: SESSION_PIN, name: 'Sofie' });
    await expect(joinedSecond).resolves.toMatchObject({ name: 'Sofie-2' });
  });

  it('reconnect resumes the existing player instead of duplicating it', async () => {
    const first = open();
    const joined = nextEvent<JoinedPayload>(first, 'joined');
    first.emit('join', { pin: SESSION_PIN, name: 'Rejoiner' });
    const { playerId, name } = await joined;

    first.disconnect();

    const resumed = open();
    const rejoined = nextEvent<JoinedPayload>(resumed, 'joined');
    const state = nextEvent<StateViewPayload>(resumed, 'state');
    resumed.emit('join', { pin: SESSION_PIN, name: 'Rejoiner', playerId });

    await expect(rejoined).resolves.toEqual({ playerId, name });
    const statePayload = await state;
    const roster = statePayload.players.filter((p) => p.name.startsWith('Rejoiner'));
    expect(roster).toEqual([{ id: playerId, name }]);
  });
});
