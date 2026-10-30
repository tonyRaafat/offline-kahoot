// Socket.io wiring for the player-join flow — the I/O half of the engine seam.
//
// Pure validation lives in src/join.ts; this module only routes wire events.
// Every state change funnels through GameSession.dispatch(), and every
// broadcastState Effect is projected through stateView() before hitting the
// wire, so clients never see raw GameState internals.
//
// Wire contract (player-join slice):
//   client -> server:  `join` { pin: string, name: string, playerId?: string }
//   server -> socket:  `joined` { playerId, name }   name = FINAL name after
//                       duplicate auto-suffixing, followed by `state`
//                      `joinError` { reason } on bad payload/PIN/name
//   server -> all:     `state` StateView on every broadcastState Effect
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
  });
}

/**
 * Broadcast path for engine Effects: broadcastState is projected through
 * stateView() and pushed to every socket. broadcastReveal (reveal screens)
 * and answerRejected (per-player answer feedback) are consumed by later
 * tickets and dropped here.
 */
function broadcastEffects(io: Server, effects: Effect[]): void {
  for (const effect of effects) {
    if (effect.type === 'broadcastState') {
      io.emit('state', stateView(effect.state));
    }
  }
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
  socket.emit('joined', { playerId, name: finalName });
  broadcastEffects(io, effects);
}
