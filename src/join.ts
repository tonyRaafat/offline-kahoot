// Pure socket-boundary helpers for the player-join flow.
//
// The raw `join` payload arrives over the wire untyped, so all shape
// validation, PIN matching and name normalization happens here — side-effect
// free and unit-testable — while src/socket.ts keeps only orchestration.

/** Same real question as the socket wire format; see join on src/socket.ts. */
export interface JoinPayload {
  pin: string;
  name: string;
  /** Set only when the client resumes a session; dropped otherwise. */
  playerId?: string;
}

export type JoinErrorReason =
  | 'bad-payload' // not a join object at all
  | 'bad-pin' // wrong or malformed PIN
  | 'bad-name'; // missing/empty/too long nickname

export const NAME_MAX_LEN = 20;
const PIN_DIGITS = /^\d{6}$/;

/**
 * Validates a raw join payload against the live session PIN.
 * A malformed playerId is dropped (fresh join) rather than rejected: a
 * corrupted or foreign localStorage entry must never block a join.
 */
export function parseJoinPayload(
  raw: unknown,
  sessionPin: string,
): { ok: true; payload: JoinPayload } | { ok: false; reason: JoinErrorReason } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'bad-payload' };
  }
  const bag = raw as Record<string, unknown>;
  if (typeof bag.pin !== 'string' || !PIN_DIGITS.test(bag.pin) || bag.pin !== sessionPin) {
    return { ok: false, reason: 'bad-pin' };
  }
  if (typeof bag.name !== 'string') return { ok: false, reason: 'bad-name' };
  const name = bag.name.trim();
  if (name.length === 0 || name.length > NAME_MAX_LEN) {
    return { ok: false, reason: 'bad-name' };
  }
  const payload: JoinPayload = { pin: bag.pin, name };
  if (typeof bag.playerId === 'string' && bag.playerId.length > 0) {
    payload.playerId = bag.playerId;
  }
  return { ok: true, payload };
}

/** Maps a validated payload plus the server-minted id onto the engine event. */
export function toPlayerJoinEvent(
  payload: JoinPayload,
  playerId: string,
  atMs: number,
): {
  type: 'playerJoin';
  playerId: string;
  name: string;
  atMs: number;
} {
  return { type: 'playerJoin', playerId, name: payload.name, atMs };
}
