// src/auth.ts — signed-session cookie primitives (node:crypto only, no new
// npm deps; see issue 01 of the admin-dashboard spec).
//
// Session tokens are stateless and self-validating:
//   token = `<expiry-ms>.<base64url(HMAC-SHA256(key=ADMIN_PASSWORD, "kahoot-admin:" + expiry)>`
// The signing key is derived from the ADMIN_PASSWORD itself, so changing the
// password invalidates every outstanding session and no secret file needs to
// persist (spec non-goal). Expiry is checked before the MAC so expired
// tokens always fail fast, and the compare is constant-time
// (timingSafeEqual); malformed/garbage input is simply invalid.
//
// Accepted risk (recorded on issue 02): the cookie carries no server-side
// session state, so a stolen cookie stays valid until expiry — for a single
// shared admin password on a trusted LAN device that trade-off was chosen
// over adding server-side session storage.
//
// Cookie helpers are minimal: parse the `Cookie` header, and build the
// Set-Cookie value (clear + one-month) with HttpOnly; SameSite=Lax; Path=/.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE_NAME = 'ka_session';
/** ~30 days, the confirmed session lifetime. */
export const SESSION_TTL_MS: number = 30 * 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = 'kahoot-admin:';

/** The admin password boot validated (never persisted anywhere else). */
export function adminPassword(): string {
  const password = process.env.ADMIN_PASSWORD;
  return typeof password === 'string' ? password.trim() : '';
}

function sign(expiryMs: number, password: string): string {
  return createHmac('sha256', password).update(TOKEN_PREFIX + expiryMs).digest('base64url');
}

/** Builds a signed session token valid for `ttlMs` (default ~30 days). */
export function createSessionToken(password: string, ttlMs: number = SESSION_TTL_MS): string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('createSessionToken requires a non-empty admin password');
  }
  const expiry = Date.now() + ttlMs;
  return `${expiry}.${sign(expiry, password)}`;
}

/**
 * Verifies a session token: false for missing/empty password, malformed
 * tokens, wrong keys, tampered MACs, and expired tokens (expiry is checked
 * first). The MAC comparison is constant-length guarded + timingSafeEqual.
 */
export function verifySessionToken(
  token: string | undefined | null,
  password: string = adminPassword(),
): boolean {
  if (!token || !password) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false; // no expiry part
  const expiry = Number(token.slice(0, dot));
  if (!Number.isSafeInteger(expiry) || expiry <= Date.now()) return false;
  const expected = Buffer.from(sign(expiry, password));
  const given = Buffer.from(token.slice(dot + 1));
  if (given.length !== expected.length) return false;
  return timingSafeEqual(expected, given);
}

/* ---- tiny cookie helpers (no cookie-parser dependency) ---- */

/** `Cookie: a=1; b=2` -> { a: '1', b: '2' }. Later duplicates win. */
export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    cookies[name] = part.slice(eq + 1).trim();
  }
  return cookies;
}

/** Set-Cookie value that grants the session (HttpOnly, Lax, /, ~30 days).
 *  `Secure` is intentionally omitted: this is an offline LAN tool over plain
 *  HTTP, and a Secure cookie would be dropped by every browser that joins. */
export function sessionCookie(token: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/** Set-Cookie value that deletes the session cookie (Max-Age=0). */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * Reads the session cookie value out of a header bag (`req.headers` in
 * express, `socket.handshake.headers` in socket.io). Tolerates the rare
 * string[] form and returns undefined for blank values.
 */
export function sessionCookieFrom(headers: { cookie?: unknown }): string | undefined {
  const raw = headers.cookie;
  const header = typeof raw === 'string' ? raw : Array.isArray(raw) ? String(raw[0]) : undefined;
  const value = parseCookieHeader(header)[SESSION_COOKIE_NAME];
  return value === '' ? undefined : value;
}
