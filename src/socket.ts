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
//     `endGame` (no payload)     host only: any live phase -> lobby (players kept,
//                                scores cleared); results of the live game are saved
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
import type { Effect, Reveal } from './engine.js';
import type { GameSession } from './game-session.js';
import { parseJoinPayload, toPlayerJoinEvent } from './join.js';
import { stateView } from './state-view.js';
import { type GameResultsRecorder } from './results.js';

const LOG_PREFIX = '[offline-kahoot]';

export interface SocketWiring {
  gameSession: GameSession;
  sessionPin: string;
  /** Results accumulator for finished games; omitted only in minimal test boots. */
  results?: GameResultsRecorder;
}

export function wireSockets(io: Server, wiring: SocketWiring): void {
  let lastReveal: Reveal | null = null;
  const onReveal = (reveal: Reveal) => {
    lastReveal = reveal;
  };

  io.on('connection', (socket) => {
    const transport = socket.conn.transport.name;
    console.log(
      `${LOG_PREFIX} socket connected: id=${socket.id} ` +
        `addr=${socket.handshake.address} transport=${transport}`,
    );
    socket.on('disconnect', (reason) => {
      console.log(`${LOG_PREFIX} socket disconnected: id=${socket.id} reason=${reason}`);
    });
    socket.on('join', (raw: unknown) => handleJoin(io, wiring, socket, raw, lastReveal, onReveal));
    socket.on('host', () => {
      socket.data.isHost = true;
      if (wiring.gameSession.current.phase !== 'lobby') {
        socket.emit('state', stateView(wiring.gameSession.current));
        if (wiring.gameSession.current.phase === 'reveal' && lastReveal) {
          socket.emit('reveal', lastReveal);
        }
      }
    });
    socket.on('hostStart', () => handleHostStart(io, wiring, socket, onReveal));
    socket.on('answer', (raw: unknown) => handleAnswer(io, wiring, socket, raw, onReveal));
    socket.on('reveal', () => handleHostEvent(io, wiring, socket, 'reveal', onReveal));
    socket.on('next', () => handleHostEvent(io, wiring, socket, 'next', onReveal));
    socket.on('endGame', () => handleEndGame(io, wiring, socket, onReveal));
  });
}

/**
 * Broadcast path for engine Effects: broadcastState is projected through
 * stateView() and pushed to every socket, broadcastReveal goes to every socket
 * as-is, and answerRejected goes back to the socket of the submitting player.
 */
function broadcastEffects(
  io: Server,
  source: Socket,
  wiring: SocketWiring,
  effects: Effect[],
  onReveal?: (reveal: Reveal) => void,
): void {
  for (const effect of effects) {
    switch (effect.type) {
      case 'broadcastState':
        io.emit('state', stateView(effect.state));
        wiring.results?.onState(effect.state);
        break;
      case 'broadcastReveal':
        onReveal?.(effect.reveal);
        io.emit('reveal', effect.reveal);
        wiring.results?.addReveal(effect.reveal);
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

function handleHostStart(
  io: Server,
  wiring: SocketWiring,
  socket: Socket,
  onReveal?: (reveal: Reveal) => void,
): void {
  if (!isHost(socket)) return;
  broadcastEffects(
    io,
    socket,
    wiring,
    wiring.gameSession.dispatch({ type: 'startQuiz', atMs: Date.now() }),
    onReveal,
  );
}

function handleEndGame(
  io: Server,
  wiring: SocketWiring,
  socket: Socket,
  onReveal?: (reveal: Reveal) => void,
): void {
  if (!isHost(socket)) return;
  // The engine's post-end state has scores cleared, so capture the pre-end
  // state for the results record before dispatching.
  const before = wiring.gameSession.current;
  const effects = wiring.gameSession.dispatch({ type: 'end' });
  if (effects.length === 0) return; // engine ignored `end` (already in lobby)
  wiring.results?.endGame(before);
  broadcastEffects(io, socket, wiring, effects, onReveal);
}

function handleHostEvent(
  io: Server,
  wiring: SocketWiring,
  socket: Socket,
  event: 'reveal' | 'next',
  onReveal?: (reveal: Reveal) => void,
): void {
  if (!isHost(socket)) return;
  const wireEvent =
    event === 'reveal'
      ? ({ type: 'reveal' } as const)
      : ({ type: 'next', atMs: Date.now() } as const);
  broadcastEffects(io, socket, wiring, wiring.gameSession.dispatch(wireEvent), onReveal);
}

function handleAnswer(
  io: Server,
  wiring: SocketWiring,
  socket: Socket,
  raw: unknown,
  onReveal?: (reveal: Reveal) => void,
): void {
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
    wiring,
    wiring.gameSession.dispatch({
      type: 'playerAnswer',
      playerId,
      answerIndex,
      atMs: Date.now(),
    }),
    onReveal,
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

function handleJoin(
  io: Server,
  wiring: SocketWiring,
  socket: Socket,
  raw: unknown,
  lastReveal?: Reveal | null,
  onReveal?: (reveal: Reveal) => void,
): void {
  const parsed = parseJoinPayload(raw, wiring.sessionPin);
  console.log(`${LOG_PREFIX} join attempt: id=${socket.id} result=${parsed.ok ? 'ok' : parsed.reason}`);
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
    if (wiring.gameSession.current.phase === 'reveal' && lastReveal) {
      socket.emit('reveal', lastReveal);
    }
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
  broadcastEffects(io, socket, wiring, effects, onReveal);
}
