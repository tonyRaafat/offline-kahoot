// Auth-gate boot smoke test for src/server.ts (admin-dashboard issues 01-03).
//
// Spawns the real server (tsx) as a child process twice:
//   1. WITHOUT ADMIN_PASSWORD anywhere (isolated cwd so a developer's local
//      .env cannot confuse it) -> asserts the fail-fast boot: non-zero exit
//      and a clear error naming ADMIN_PASSWORD.
//   2. WITH ADMIN_PASSWORD injected via the environment -> drives the full
//      auth surface over HTTP: page redirects, the public/protected asset
//      split, the gated /api reads+mutations, and login/logout cookies.
//
// The second boot starts against the normal project data dir but performs a
// login, gated reads and a full quiz create/delete cycle that it removes
// again (prefixed "smoke-auth-").

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from 'socket.io-client';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const QUIZZES_DIR = path.join(projectRoot, 'data', 'quizzes');
const SMOKE_PREFIX = 'smoke-auth-quiz';
const HOST_PAGE_LINE = /host page: \S*?:(\d+)/;
const ADMIN_PASSWORD = 'server-auth-test-admin-password';

describe('boot fail-fast without ADMIN_PASSWORD', () => {
  it('exits non-zero with an error naming ADMIN_PASSWORD and .env', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kahoot-noenv-'));
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ADMIN_PASSWORD;
    try {
      const child = spawn(
        process.execPath,
        [
          path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
          path.join(projectRoot, 'src', 'server.ts'),
        ],
        { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const stderr: string = await new Promise((resolve) => {
        let acc = '';
        child.stderr!.setEncoding('utf8');
        child.stderr!.on('data', (chunk) => (acc += chunk));
        child.on('exit', (code) => resolve(`exit=${code}\n${acc}`));
      });
      expect(stderr).toMatch(/exit=[1-9]/); // never boots to listen (no "host page:" line below)
      expect(stderr).toMatch(/ADMIN_PASSWORD/);
      expect(stderr).not.toMatch(/host page:/); // the server truly never listens
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('boots fine with ADMIN_PASSWORD only in the environment (no .env needed)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kahoot-envvar-'));
    const env: NodeJS.ProcessEnv = { ...process.env, ADMIN_PASSWORD };
    try {
      const child = spawn(
        process.execPath,
        [
          path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
          path.join(projectRoot, 'src', 'server.ts'),
        ],
        { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const line = await new Promise((resolve) => {
        child.stdout!.setEncoding('utf8');
        child.stdout!.on('data', (chunk) => {
          const port = String(chunk).match(HOST_PAGE_LINE);
          if (port) resolve(port[1]);
        });
        child.on('exit', () => resolve(null));
      });
      expect(line).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('auth surface of the running server', () => {
  let child: ReturnType<typeof spawn> | undefined;
  let baseUrl = '';
  let cookie = '';

  beforeAll(async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, ADMIN_PASSWORD };
    child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
      cwd: projectRoot,
      env,
    });
    const stdout = child.stdout;
    if (!stdout) throw new Error('spawner created no stdout pipe');
    const childProcess = child;
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not boot within 30s')), 30_000);
      stdout.setEncoding('utf8');
      stdout.on('data', (chunk: string) => {
        const match = chunk.match(HOST_PAGE_LINE);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      childProcess.on('exit', (code: number | null) =>
        reject(new Error(`server exited early (code ${code})`)),
      );
    });
    baseUrl = `http://127.0.0.1:${port}`;
  }, 40_000);

  afterAll(async () => {
    child?.kill('SIGTERM');
    let files: string[] = [];
    try {
      files = await readdir(QUIZZES_DIR);
    } catch {
      // no quiz dir — nothing to clean
    }
    await Promise.all(
      files
        .filter((f) => f.startsWith(SMOKE_PREFIX) && f.endsWith('.json'))
        .map((f) => rm(path.join(QUIZZES_DIR, f), { force: true })),
    );
  });

  const parseSetCookie = (header: string | null): string => {
    if (!header) throw new Error('no Set-Cookie presented');
    return header.split(';')[0];
  };

  const authedFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('Cookie', cookie);
    return fetch(`${baseUrl}${path}`, { ...init, headers });
  };

  it('an unauthenticated visitor is redirected to /login from pages', async () => {
    for (const route of ['/', '/editor', '/host', '/dashboard.html', '/host.html']) {
      const res = await fetch(`${baseUrl}${route}`, { redirect: 'manual' });
      expect(res.status, route).toBe(302);
      expect(res.headers.get('location'), route).toBe('/login');
    }
    // /play stays public and serves the player page.
    const play = await fetch(`${baseUrl}/play`);
    expect(play.status).toBe(200);
    expect(await play.text()).toContain('app.title.player');
  });

  it('the static asset split keeps player+shared assets public, page assets gated', async () => {
    for (const file of [
      'tokens.css',
      'host.css', // shared component layer, loaded by the public /login page (issue 01)
      'i18n.js',
      'avatar.js',
      'player.js',
      'question-defaults.js',
    ]) {
      const res = await fetch(`${baseUrl}/${file}`);
      expect(res.status, file).toBe(200);
    }
    // Assets of protected pages: 401 JSON for css/js, page-like redirect for .html.
    expect((await fetch(`${baseUrl}/editor.js`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/dashboard.css`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/dashboard.js`)).status).toBe(401);
    const hostHtml = await fetch(`${baseUrl}/host.html`, { redirect: 'manual' });
    expect(hostHtml.status).toBe(302);
    expect(hostHtml.headers.get('location')).toBe('/login');
    const dashboardHtml = await fetch(`${baseUrl}/dashboard.html`, { redirect: 'manual' });
    expect(dashboardHtml.status).toBe(302);
    // shared login page assets are world-readable (issue 02 surface)
    expect((await fetch(`${baseUrl}/login.html`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/login.css`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/login.js`)).status).toBe(200);
  });

  it('API reads and mutations are 401 unauthorized with the shared error shape', async () => {
    const read = await fetch(`${baseUrl}/api/quizzes`);
    expect(read.status).toBe(401);
    expect(await read.json()).toEqual({ error: expect.any(String) });
    expect((await fetch(`${baseUrl}/api/session`)).status).toBe(401);
    const mutation = await fetch(`${baseUrl}/api/quizzes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Should Never Land' }),
    });
    expect(mutation.status).toBe(401);
    const game = await fetch(`${baseUrl}/api/game/quiz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quizId: 'seed' }),
    });
    expect(game.status).toBe(401);
    const del = await fetch(`${baseUrl}/api/quizzes/seed`, { method: 'DELETE' });
    expect(del.status).toBe(401);
  });

  it('wrong password gets a 401 JSON error (and a modest delay)', async () => {
    const started = Date.now();
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'definitely-wrong' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'wrong password' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(290); // ~300ms delay
  });

  it('logging in sets the session cookie; the gated surface opens up', async () => {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    expect(res.status).toBe(204);
    const setCookie = parseSetCookie(res.headers.get('set-cookie'));
    expect(setCookie).toContain('ka_session=');
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');
    expect(res.headers.get('set-cookie')).toContain('SameSite=Lax');
    cookie = setCookie;
  });

  it('after login / serves the dashboard page and /host the live-game page (issue 04 route map)', async () => {
    for (const route of ['/', '/editor', '/host']) {
      const page = await authedFetch(route);
      expect(page.status, route).toBe(200);
    }
    // Route mapping, not just status: / carries the dashboard markup,
    // /host keeps the host markup moved there by issue 04.
    const dashboard = await (await authedFetch('/')).text();
    expect(dashboard).toContain('app.title.dashboard');
    expect(dashboard).toContain('dashboard.js');
    const hostPage = await (await authedFetch('/host')).text();
    expect(hostPage).toContain('app.title.host');
    expect(hostPage).toContain('host.js');
    expect(hostPage).not.toContain('id="quiz-select"'); // picker moved to dashboard cards
  });

  it('the gated reads open up: session (with the live flag), quiz list, detail and export', async () => {
    // Reads: session + quizzes (+ an existing quiz + its export)
    const session = await (await authedFetch('/api/session')).json();
    expect(typeof (session as { pin: string }).pin).toBe('string');
    // Paid-review fix (issue 04): the wire addition is just `live: boolean` —
    // true only while the engine phase is past the lobby. At boot nothing has
    // started, so loading/list state reads false.
    expect((session as { live: boolean }).live).toBe(false);
    const quizzes = (await (await authedFetch('/api/quizzes')).json()) as Array<{
      id: string;
    }>;
    expect(quizzes.some((q) => q.id === 'seed')).toBe(true);
    expect((await authedFetch('/api/quizzes/seed')).status).toBe(200);
    expect((await authedFetch('/api/quizzes/seed/export')).status).toBe(200);
  });

  it('POST /api/game/quiz still loads a quiz (the dashboard Start target)', async () => {
    const res = await authedFetch('/api/game/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quizId: 'seed' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({ ok: true, id: 'seed' }));
  });

  it('the live flag flips only while a game is actually running (paid-review fix)', async () => {
    // POST /api/game/quiz reset the engine to a fresh LOBBY: loaded ≠ live.
    const before = (await (await authedFetch('/api/session')).json()) as {
      pin: string;
      live: boolean;
    };
    expect(before.live).toBe(false);

    // A real authenticated host starts a real game over the socket.
    const host = connect(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      extraHeaders: { Cookie: cookie },
    });
    const waitState = (predicate: (phase: string) => boolean): Promise<void> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('state never arrived')), 5_000);
        host.on('state', (view: { phase: string }) => {
          if (predicate(view.phase)) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    host.emit('host');
    host.emit('join', { pin: before.pin, name: 'live-flag-smoke', color: 'red' });
    await waitState((phase) => phase === 'lobby');
    host.emit('hostStart');
    await waitState((phase) => phase === 'question');

    const live = (await (await authedFetch('/api/session')).json()) as { live: boolean };
    expect(live.live).toBe(true);

    // endGame resets to the lobby -> not live again (dashboard banner hides).
    host.emit('endGame');
    await waitState((phase) => phase === 'lobby');
    const after = (await (await authedFetch('/api/session')).json()) as { live: boolean };
    expect(after.live).toBe(false);
    host.disconnect();
  });

  it('a forged/garbage session cookie is not authenticated', async () => {
    const res = await fetch(`${baseUrl}/`, {
      redirect: 'manual',
      headers: { Cookie: 'ka_session=123456.not-a-real-signature' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('a logged-in /login visit redirects to the dashboard route', async () => {
    const res = await authedFetch('/login', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it('quiz CRUD works with the cookie end to end (create/read/save/delete)', async () => {
    const created = await authedFetch('/api/quizzes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Smoke Auth Quiz' }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(id.startsWith(SMOKE_PREFIX)).toBe(true);

    const saved = await authedFetch(`/api/quizzes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Smoke Auth Quiz',
        questions: [
          {
            prompt: 'Auth smoke question',
            type: 'multiple-choice',
            timeSeconds: 20,
            options: ['a', 'b'],
            correctIndex: 1,
          },
        ],
      }),
    });
    expect(saved.status).toBe(200);

    const loaded = await authedFetch(`/api/quizzes/${id}`);
    expect((await loaded.json()) as { title: string }).toEqual(
      expect.objectContaining({ title: 'Smoke Auth Quiz' }),
    );
  });

  it('logout clears the cookie and the idempotent second logout is still 204', async () => {
    const res = await authedFetch('/api/logout', { method: 'POST' });
    expect(res.status).toBe(204);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('ka_session=;');
    expect(setCookie).toContain('Max-Age=0');
    // Replaying logout without any cookie: still 204 (idempotent).
    const again = await fetch(`${baseUrl}/api/logout`, { method: 'POST' });
    expect(again.status).toBe(204);
  });

  it('cleans up the smoke quiz it created', async () => {
    const quiz = (await (await authedFetch('/api/quizzes')).json()) as Array<{ id: string }>;
    const mine = quiz.filter((q) => q.id.startsWith(SMOKE_PREFIX)).map((q) => q.id);
    expect(mine.length).toBeGreaterThan(0);
    for (const id of mine) {
      const res = await authedFetch(`/api/quizzes/${id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
    }
  });
});
