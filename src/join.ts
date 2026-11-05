// Pure socket-boundary helpers for the player-join flow.
//
// The raw `join` payload arrives over the wire untyped, so all shape
// validation, PIN matching and name normalization happens here — side-effect
// free and unit-testable — while src/socket.ts keeps only orchestration.

import type { AvatarColor } from './avatar-colors.js';
import { isAvatarColor } from './avatar-colors.js';

export interface JoinPayload {
  pin: string;
  name: string;
  /** One of the 10 avatar palette keys (see AVATAR_COLORS), or undefined when
   * a resume candidate (well-formed playerId) sent a missing/unknown color —
   * the socket layer then either restores the stored player color or rejects
   * with `colorRejected`; for fresh joins undefined never passes the parse. */
  color?: AvatarColor;
  /** Set only when the client resumes a session; dropped otherwise. */
  playerId?: string;
}

/** A payload that made it past color validation (fresh join, or resume whose
 * color was already validated in parseJoinPayload). */
export interface FreshJoinPayload extends JoinPayload {
  color: AvatarColor;
}

export type JoinErrorReason =
  | 'bad-payload' // not a join object at all
  | 'bad-pin' // wrong or malformed PIN
  | 'bad-name' // missing/empty/too long nickname
  | 'colorRejected' // missing or not one of the 10 palette keys
  | 'nameTaken'; // duplicate nickname (checked at the socket layer, before dispatch)

export const NAME_MAX_LEN = 20;
const PIN_DIGITS = /^\d{6}$/;

/**
 * Validates a raw join payload against the live session PIN.
 * A malformed playerId is dropped (fresh join) rather than rejected: a
 * corrupted or foreign localStorage entry must never block a join.
 *
 * Color handling is resume-aware: a missing/unknown color is still rejected
 * outright for a fresh join, but a payload carrying a well-formed playerId is
 * let through with `color: undefined` so the socket layer can decide — an
 * existing player restores its stored color (stale local color is irrelevant),
 * anything else is rejected as `colorRejected` there.
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
  const playerIdOk = typeof bag.playerId === 'string' && bag.playerId.length > 0;
  if (!isAvatarColor(bag.color) && !playerIdOk) {
    return { ok: false, reason: 'colorRejected' };
  }
  const payload: JoinPayload = {
    pin: bag.pin,
    name,
    color: isAvatarColor(bag.color) ? bag.color : undefined,
  };
  if (playerIdOk) {
    payload.playerId = bag.playerId as string;
  }
  return { ok: true, payload };
}

/** Maps a validated payload plus the server-minted id onto the engine event. */
export function toPlayerJoinEvent(
  payload: FreshJoinPayload,
  playerId: string,
  atMs: number,
): {
  type: 'playerJoin';
  playerId: string;
  name: string;
  color: AvatarColor;
  atMs: number;
} {
  return {
    type: 'playerJoin',
    playerId,
    name: payload.name,
    color: payload.color,
    atMs,
  };
}
