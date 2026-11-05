// Unit tests for the node:crypto signed-session primitives and the tiny
// cookie helpers in src/auth.ts. The signing key is derived from the password
// passed to createSessionToken; process.env.ADMIN_PASSWORD is only touched to
// prove the default-password fallback (save/restore around it).

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearedSessionCookie,
  createSessionToken,
  parseCookieHeader,
  SESSION_COOKIE_NAME,
  sessionCookie,
  sessionCookieFrom,
  verifySessionToken,
} from './auth.js';

const PASSWORD = 'unit-test-admin-password';

const savedEnv: Array<[string, string | undefined]> = [];

function setProcessEnv(key: string, value: string | undefined): void {
  savedEnv.push([key, process.env[key]]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of savedEnv.splice(0).reverse()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('session tokens', () => {
  it('round-trips: a created token verifies against the same password', () => {
    const token = createSessionToken(PASSWORD);
    expect(token).toMatch(/^\d+\.[A-Za-z0-9_-]+$/);
    expect(verifySessionToken(token, PASSWORD)).toBe(true);
  });

  it('rejects an expired token (expiry checked first)', () => {
    const expired = createSessionToken(PASSWORD, -Math.floor(Math.random() * 10_000) - 1);
    expect(expiryOf(expired)).toBeLessThanOrEqual(Date.now());
    expect(verifySessionToken(expired, PASSWORD)).toBe(false);
  });

  it('rejects a tampered token (MAC no longer matches)', () => {
    const token = createSessionToken(PASSWORD);
    const dot = token.indexOf('.');
    const validMac = token.slice(dot + 1);
    const tamperedFlipMac = flipFirstChar(validMac);
    expect(tamperedFlipMac).not.toBe(validMac);
    expect(verifySessionToken(token, PASSWORD)).toBe(true);
    expect(verifySessionToken(`${token.slice(0, dot)}.${tamperedFlipMac}`, PASSWORD)).toBe(false);
    expect(verifySessionToken(`${token.slice(0, dot)}1.${validMac}`, PASSWORD)).toBe(false);
  });

  it('rejects a token signed with a different password (old sessions die with the password)', () => {
    const token = createSessionToken(PASSWORD);
    expect(verifySessionToken(token, 'a-different-password')).toBe(false);
  });

  it('rejects malformed and empty input', () => {
    const token = createSessionToken(PASSWORD);
    const validMac = token.slice(token.indexOf('.') + 1);
    expect(() => createSessionToken('')).toThrow(/non-empty/);
    for (const bad of [undefined, null, '', 'garbage', 'x.y', `.${validMac}`, '123.', '12.34.56']) {
      expect(verifySessionToken(bad as string, PASSWORD)).toBe(false);
    }
  });

  it('an empty admin password can never authenticate anything', () => {
    setProcessEnv('ADMIN_PASSWORD', undefined);
    const token = createSessionToken('other');
    expect(verifySessionToken(token)).toBe(false); // default password missing
    setProcessEnv('ADMIN_PASSWORD', '   ');
    expect(verifySessionToken(token)).toBe(false);
    setProcessEnv('ADMIN_PASSWORD', 'other');
    expect(verifySessionToken(token)).toBe(true); // default reads process.env
  });
});

/** Parses the expiry (first dot segment) as a number. */
function expiryOf(token: string): number {
  return Number(token.slice(0, token.indexOf('.')));
}

/** Returns the same string with only its first character replaced. */
function flipFirstChar(value: string): string {
  if (value.length === 0) return 'x'; // degenerate MACs cannot exist (fix signature length)
  const first = value.charAt(0) === 'A' ? 'B' : 'A';
  return first + value.slice(1);
}

describe('cookie helpers', () => {
  it('parses Cookie headers with spaces, multiple cookies and no previous header', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
    expect(parseCookieHeader('ka_session=tok0; other=v 2')).toEqual({
      ka_session: 'tok0',
      other: 'v 2',
    });
  });

  it('builds the granting Set-Cookie value with the documented attributes', () => {
    const token = createSessionToken(PASSWORD);
    const setCookie = sessionCookie(token);
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=${token}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toMatch(/Max-Age=2\d{6}/); // >= 2,000,000s -> ~23+ days
  });

  it('builds the clearing Set-Cookie value (Max-Age=0)', () => {
    const setCookie = clearedSessionCookie();
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('HttpOnly');
  });

  it('sessionCookieFrom reads the session cookie from a header bag', () => {
    expect(sessionCookieFrom({})).toBeUndefined();
    expect(sessionCookieFrom({ cookie: 'other=x' })).toBeUndefined();
    expect(sessionCookieFrom({ cookie: `${SESSION_COOKIE_NAME}=abc; alt=y` })).toBe('abc');
    // socket.io may surface headers as string[]
    expect(sessionCookieFrom({ cookie: [`${SESSION_COOKIE_NAME}=arr`] })).toBe('arr');
    expect(sessionCookieFrom({ cookie: `${SESSION_COOKIE_NAME}=` })).toBeUndefined();
  });
});
