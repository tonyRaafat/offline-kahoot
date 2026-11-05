import { describe, expect, it } from 'vitest';
import { NAME_MAX_LEN, parseJoinPayload, toPlayerJoinEvent } from './join.js';
import { AVATAR_COLORS } from './avatar-colors.js';

const SERVER_PIN = '000042'; // a valid zero-padded 6-digit PIN

describe('parseJoinPayload', () => {
  it('accepts a well-formed payload with the matching PIN', () => {
    const result = parseJoinPayload({ pin: SERVER_PIN, name: ' Tony ', color: 'red' }, SERVER_PIN);
    expect(result).toEqual({
      ok: true,
      payload: { pin: SERVER_PIN, name: 'Tony', color: 'red' },
    });
  });

  it('accepts every one of the 10 palette keys', () => {
    for (const color of AVATAR_COLORS) {
      const result = parseJoinPayload({ pin: SERVER_PIN, name: 'Tony', color }, SERVER_PIN);
      expect(result).toEqual({
        ok: true,
        payload: { pin: SERVER_PIN, name: 'Tony', color },
      });
    }
  });

  it('keeps a non-empty playerId as-is', () => {
    const result = parseJoinPayload(
      { pin: SERVER_PIN, name: 'Tony', color: 'blue', playerId: 'abc-123' },
      SERVER_PIN,
    );
    expect(result).toEqual({
      ok: true,
      payload: { pin: SERVER_PIN, name: 'Tony', color: 'blue', playerId: 'abc-123' },
    });
  });

  it('drops a malformed playerId so the join is treated as fresh', () => {
    for (const playerId of ['', 42, null, { hijack: true }]) {
      const result = parseJoinPayload({ pin: SERVER_PIN, name: 'Tony', color: 'grey', playerId }, SERVER_PIN);
      expect(result).toEqual({
        ok: true,
        payload: { pin: SERVER_PIN, name: 'Tony', color: 'grey' },
      });
    }
  });

  it('tolerates a missing/unknown color when a well-formed playerId is present (resume candidate)', () => {
    for (const color of [undefined, '', 'magenta', 42, null]) {
      const result = parseJoinPayload(
        { pin: SERVER_PIN, name: 'Tony', color, playerId: 'resume-1' },
        SERVER_PIN,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.playerId).toBe('resume-1');
        expect(result.payload.color).toBeUndefined();
      }
    }
  });

  it('rejects a wrong PIN (right shape)', () => {
    const result = parseJoinPayload({ pin: '000043', name: 'Tony', color: 'red' }, SERVER_PIN);
    expect(result).toEqual({ ok: false, reason: 'bad-pin' });
  });

  it('rejects a PIN with the wrong shape ("0101" is not a session PIN)', () => {
    const result = parseJoinPayload({ pin: '0101', name: 'Tony', color: 'red' }, SERVER_PIN);
    expect(result).toEqual({ ok: false, reason: 'bad-pin' });
  });

  it('rejects a non-object payload (null, number, string, array)', () => {
    for (const raw of [null, 42, 'join', [], true]) {
      expect(parseJoinPayload(raw, SERVER_PIN)).toEqual({ ok: false, reason: 'bad-payload' });
    }
  });

  it('rejects a missing or whitespace-only name', () => {
    for (const name of [undefined, '', '   ', 42]) {
      expect(parseJoinPayload({ pin: SERVER_PIN, name, color: 'red' }, SERVER_PIN)).toEqual({
        ok: false,
        reason: 'bad-name',
      });
    }
  });

  it('rejects a missing, non-string, or unknown avatar color with colorRejected', () => {
    for (const color of [undefined, '', 'RED', 'magenta', 42, null]) {
      expect(parseJoinPayload({ pin: SERVER_PIN, name: 'Tony', color }, SERVER_PIN)).toEqual({
        ok: false,
        reason: 'colorRejected',
      });
    }
  });

  it('rejects a name over the length limit', () => {
    const tooLong = 'x'.repeat(NAME_MAX_LEN + 1);
    expect(parseJoinPayload({ pin: SERVER_PIN, name: tooLong }, SERVER_PIN)).toEqual({
      ok: false,
      reason: 'bad-name',
    });
  });

  it('accepts a name exactly at the length limit', () => {
    const atLimit = 'x'.repeat(NAME_MAX_LEN);
    const result = parseJoinPayload({ pin: SERVER_PIN, name: atLimit, color: 'black' }, SERVER_PIN);
    expect(result).toEqual({ ok: true, payload: { pin: SERVER_PIN, name: atLimit, color: 'black' } });
  });
});

describe('toPlayerJoinEvent', () => {
  it('maps a validated payload onto the engine playerJoin event shape', () => {
    const event = toPlayerJoinEvent(
      { pin: SERVER_PIN, name: 'Tony', color: 'yellow', playerId: 'ignored-here' },
      'server-minted-id',
      1234,
    );
    expect(event).toEqual({
      type: 'playerJoin',
      playerId: 'server-minted-id',
      name: 'Tony',
      color: 'yellow',
      atMs: 1234,
    });
  });

  it('passes the validated (trimmed) name and color through unchanged', () => {
    const event = toPlayerJoinEvent({ pin: SERVER_PIN, name: 'Tony', color: 'brown' }, 'p1', 0);
    expect(event).toMatchObject({ name: 'Tony', color: 'brown' });
  });
});
