// Socket.io wiring for the player-join flow AND the question cycle — the I/O
// half of the engine seam.
//
// Pure validation lives in src/join.ts; this module only routes wire events.
// Every state change funnels through GameSession.dispatch(), and every engine
// Effect is consumed here: broadcastState is projected through stateView()
// before hitting the wire, broadcastReveal is emitted as-is, and
// answerRejected is routed back to the socket of the rejected player.
//
// Wire contract:
//   client -> server:
//     `join` { pin: string, name: string, playerId?: string }
//     `host` (no payload)        marks this socket as THE host (once per page)
//     `hostStart` (no payload)   host only: lobby -> question 1
//     `answer` { answerIndex }   the joined player's answer for the live question
//     `reveal` (no payload)      host only: question -> reveal
//     `next` (no payload)        host only: reveal -> leaderboard -> next question / podium
//   server -> socket:
//     `joined` { playerId, name }   name = FINAL name after duplicate
//                                    auto-suffixing, followed by `state`
//     `joinError` { reason }        on bad payload/PIN/name
//     `answerRejected` { reason }   routed to the submitting player only
//   server -> all:
//     `state` StateView on every broadcastState Effect
//     `reveal` Reveal on every broadcastReveal Effect (safe as-is; it carries
//              correctIndex because the answer is already public there)
import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import type { Effect } from './engine.js';
import type { GameSession } from './game-session.js';
import { parseJoinPayload, toPlayerJoinEvent } from './join.js';
import { stateView } from './state-view.js';

export interface SocketWiring {
  gameSession: GameSession;
  sessionPin: string;
}

export function wireSockets(io: Server, wiring: SocketWiring): void {
  io.on('connection', (socket) => {
    socket.on('join', (raw: unknown) => handleJoin(io, wiring, socket, raw));
    socket.on('host', () => {
      socket.data.isHost = true;
    });
    socket.on('hostStart', () => handleHostStart(io, wiring, socket));
    socket.on('answer', (raw: unknown) => handleAnswer(io, wiring, socket, raw));
    socket.on('reveal', () => handleHostEvent(io, wiring, socket, 'reveal'));
    socket.on('next', () => handleHostEvent(io, wiring, socket, 'next'));
  });
}

/**
 * Broadcast path for engine Effects: broadcastState is projected through
 * stateView() and pushed to every socket, broadcastReveal goes to every socket
 * as-is, and answerRejected goes back to the socket of the submitting player.
 */
function broadcastEffects(io: Server, source: Socket, effects: Effect[]): void {
  for (const effect of effects) {
    switch (effect.type) {
      case 'broadcastState':
        io.emit('state', stateView(effect.state));
        break;
      case 'broadcastReveal':
        io.emit('reveal', effect.reveal);
        break;
      case 'answerRejected':
        source.emit('answerRejected', { reason: effect.reason });
        break;
    }
  }
}

/** Host-only events are silently ignored from non-host sockets. */
function isHost(socket: Socket): boolean {
  return socket.data.isHost === true;
}

function handleHostStart(io: Server, wiring: SocketWiring, socket: Socket): void {
  if (!isHost(socket)) return;
  broadcastEffects(io, socket, wiring.gameSession.dispatch({ type: 'startQuiz', atMs: Date.now() }));
}

function handleHostEvent(io: Server, wiring: SocketWiring, socket: Socket, event: 'reveal' | 'next'): void {
  if (!isHost(socket)) return;
  const wireEvent =
    event === 'reveal'
      ? ({ type: 'reveal' } as const)
      : ({ type: 'next', atMs: Date.now() } as const);
  broadcastEffects(io, socket, wiring.gameSession.dispatch(wireEvent));
}

function handleAnswer(io: Server, wiring: SocketWiring, socket: Socket, raw: unknown): void {
  const playerId = socket.data.playerId;
  if (typeof playerId !== 'string') {
    // The socket never joined (or resumed) a player, so the engine would see
    // an unknown id at best; answer directly without touching the session.
    socket.emit('answerRejected', { reason: 'unknown-player' });
    return;
  }
  const answerIndex = readAnswerIndex(raw);
  broadcastEffects(
    io,
    socket,
    wiring.gameSession.dispatch({
      type: 'playerAnswer',
      playerId,
      answerIndex,
      atMs: Date.now(),
    }),
  );
}

/**
 * Malformed payloads degrade to NaN so the engine alone decides the outcome
 * (invalid-answer during the question phase; no effect elsewhere).
 */
function readAnswerIndex(raw: unknown): number {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return Number.NaN;
  const bag = raw as { answerIndex?: unknown };
  return typeof bag.answerIndex === 'number' ? bag.answerIndex : Number.NaN;
}

function handleJoin(io: Server, wiring: SocketWiring, socket: Socket, raw: unknown): void {
  const parsed = parseJoinPayload(raw, wiring.sessionPin);
  if (!parsed.ok) {
    socket.emit('joinError', { reason: parsed.reason });
    return;
  }
  const payload = parsed.payload;
  const playerId = payload.playerId ?? randomUUID();

  const existing = wiring.gameSession.current.players.find((p) => p.id === playerId);
  if (existing) {
    // Reconnect: reduce() no-ops for an already-joined playerId, so resume the
    // session without dispatching a new join and hand back the final name.
    socket.data.playerId = playerId;
    socket.emit('joined', { playerId, name: existing.name });
    socket.emit('state', stateView(wiring.gameSession.current));
    return;
  }

  const effects = wiring.gameSession.dispatch(toPlayerJoinEvent(payload, playerId, Date.now()));
  const finalName = wiring.gameSession.current.players.find((p) => p.id === playerId)?.name;
  if (finalName === undefined) {
    // The engine ignored the join (it only accepts players while in the lobby
    // phase): the quiz is already running, so the lobby join cannot proceed.
    socket.emit('joinError', { reason: 'game-started' });
    return;
  }
  socket.data.playerId = playerId;
  socket.emit('joined', { playerId, name: finalName });
  broadcastEffects(io, socket, effects);
}
