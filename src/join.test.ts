import { describe, expect, it } from 'vitest';
import { NAME_MAX_LEN, parseJoinPayload, toPlayerJoinEvent } from './join.js';

const SERVER_PIN = '000042'; // a valid zero-padded 6-digit PIN

describe('parseJoinPayload', () => {
  it('accepts a well-formed payload with the matching PIN', () => {
    const result = parseJoinPayload({ pin: SERVER_PIN, name: ' Tony ' }, SERVER_PIN);
    expect(result).toEqual({ ok: true, payload: { pin: SERVER_PIN, name: 'Tony' } });
  });

  it('keeps a non-empty playerId as-is', () => {
    const result = parseJoinPayload(
      { pin: SERVER_PIN, name: 'Tony', playerId: 'abc-123' },
      SERVER_PIN,
    );
    expect(result).toEqual({
      ok: true,
      payload: { pin: SERVER_PIN, name: 'Tony', playerId: 'abc-123' },
    });
  });

  it('drops a malformed playerId so the join is treated as fresh', () => {
    for (const playerId of ['', 42, null, { hijack: true }]) {
      const result = parseJoinPayload({ pin: SERVER_PIN, name: 'Tony', playerId }, SERVER_PIN);
      expect(result).toEqual({ ok: true, payload: { pin: SERVER_PIN, name: 'Tony' } });
    }
  });

  it('rejects a wrong PIN (right shape)', () => {
    const result = parseJoinPayload({ pin: '000043', name: 'Tony' }, SERVER_PIN);
    expect(result).toEqual({ ok: false, reason: 'bad-pin' });
  });

  it('rejects a PIN with the wrong shape ("0101" is not a session PIN)', () => {
    const result = parseJoinPayload({ pin: '0101', name: 'Tony' }, SERVER_PIN);
    expect(result).toEqual({ ok: false, reason: 'bad-pin' });
  });

  it('rejects a non-object payload (null, number, string, array)', () => {
    for (const raw of [null, 42, 'join', [], true]) {
      expect(parseJoinPayload(raw, SERVER_PIN)).toEqual({ ok: false, reason: 'bad-payload' });
    }
  });

  it('rejects a missing or whitespace-only name', () => {
    for (const name of [undefined, '', '   ', 42]) {
      expect(parseJoinPayload({ pin: SERVER_PIN, name }, SERVER_PIN)).toEqual({
        ok: false,
        reason: 'bad-name',
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
    const result = parseJoinPayload({ pin: SERVER_PIN, name: atLimit }, SERVER_PIN);
    expect(result).toEqual({ ok: true, payload: { pin: SERVER_PIN, name: atLimit } });
  });
});

describe('toPlayerJoinEvent', () => {
  it('maps a validated payload onto the engine playerJoin event shape', () => {
    const event = toPlayerJoinEvent(
      { pin: SERVER_PIN, name: 'Tony', playerId: 'ignored-here' },
      'server-minted-id',
      1234,
    );
    expect(event).toEqual({ type: 'playerJoin', playerId: 'server-minted-id', name: 'Tony', atMs: 1234 });
  });

  it('passes the validated (trimmed) name through unchanged', () => {
    const event = toPlayerJoinEvent({ pin: SERVER_PIN, name: 'Tony' }, 'p1', 0);
    expect((event as { name: string }).name).toBe('Tony');
  });
});
