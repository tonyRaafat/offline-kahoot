#!/usr/bin/env node
// Smoke test for the standalone executable (NOT part of `npm test` — it needs
// dist/offline-kahoot built first; run `node scripts/build.mjs` beforehand).
//
// What it proves against the bundle running with node:sea embedded assets:
//   1. The executable spawns directly (no `node`/npm on PATH) and serves the
//      embedded public pages + static files (with the auth split: / is now
//      login-protected, /play stays public; see admin-dashboard issues 01-03).
//   2. Runtime data lives BESIDE the executable: the embedded seed.json is
//      materialized into data/quizzes/, listed by /api/quizzes (authenticated),
//      and a finished game writes data/results/ next to the exe — never into
//      the project tree.
//   3. ADMIN_PASSWORD handling: the smoke injects it via the SPAWNED PROCESS
//      ENVIRONMENT (`env: {...process.env, ADMIN_PASSWORD}` — the documented
//      scriptable answer for issue 01; an env var wins over any .env file per
//      src/env.ts precedence). Login obtains the session cookie used hereafter.
//   4. The socket host gate: an ANONYMOUS socket cannot claim `host` and
//      cannot start the game; the authenticated host runs the full game.
//
// Sandbox note: run with `node scripts/smoke-exe.mjs`.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exeName = process.platform === 'win32' ? 'offline-kahoot.exe' : 'offline-kahoot';
const builtExe = path.join(root, 'dist', exeName);
const runDir = path.join(root, 'dist', 'smoke-tmp');
const HOST_PAGE_LINE = /host page: \S*?:(\d+)/;
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD ?? 'smoke-exe-admin-password';
const SESSION_COOKIE_PREFIX = 'ka_session=';

/** Known-good literals: the seed quiz shipped in data/quizzes/seed.json. */
const SEED_ANSWER_INDEX = [1, 1, 2, 0]; // correctIndex per question
const SEED_TITLE = 'Pub Quiz Warm-Up';
const P1_NAME = 'Smoke-Player-1';
const P2_NAME = 'Smoke-Player-2';

/** Waits for a socket event matching predicate; rejects on timeout. */
function waitForEvent(socket, event, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${label}`)),
      timeoutMs,
    );
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

function waitPort(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('executable did not report its port within 30s')),
      30_000,
    );
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const match = chunk.match(HOST_PAGE_LINE);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`executable exited (code ${code}) before listening`));
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let child;
try {
  const smokeStartedAtMs = Date.now();
  assert.ok(existsSync(builtExe), `no executable at ${builtExe} — run scripts/build.mjs first`);

  // Fresh dir: forces data/ creation beside this copy of the exe.
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const exePath = path.join(runDir, exeName);
  copyFileSync(builtExe, exePath);

  // Act like a target machine WITHOUT node: run the copied exe directly.
  // (Documented smoke answer for issue 01: ADMIN_PASSWORD rides the spawned
  // process environment, which src/env.ts keeps ahead of any .env file.)
  child = spawn(exePath, [], {
    cwd: runDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ADMIN_PASSWORD },
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => {
    if (process.env.SMOKE_VERBOSE) console.error('EXE STDERR:', c);
  });
  child.on('exit', (code) => {
    if (process.env.SMOKE_VERBOSE) console.error('EXE EXITED with code', code);
  });
  const port = await waitPort(child);
  const baseUrl = `http://127.0.0.1:${port}`;

  // --- auth: anonymous is locked out, login opens the bundle up -----------
  await (async () => {
    const anonHome = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    assert.equal(anonHome.status, 302, 'anonymous GET / must redirect');
    assert.equal(anonHome.headers.get('location'), '/login', 'redirect target is /login');
    const anonEditor = await fetch(`${baseUrl}/editor`, { redirect: 'manual' });
    assert.equal(anonEditor.status, 302);
    const anonPlayer = await fetch(`${baseUrl}/play`);
    assert.equal(anonPlayer.status, 200, '/play must stay public');
    const anonQuizzes = await fetch(`${baseUrl}/api/quizzes`);
    assert.equal(anonQuizzes.status, 401, 'anonymous API read must be 401');
    assert.deepEqual(await anonQuizzes.json(), { error: 'unauthorized: log in at /login' });
    const anonAsset = await fetch(`${baseUrl}/host.css`);
    assert.equal(anonAsset.status, 401, 'anonymous protected page asset must be 401');
    // Issue 05: the self-hosted Montserrat woff2 files are shared/public assets
    // (login loads them before any session) served straight from the bundle.
    const anonFont = await fetch(`${baseUrl}/fonts/montserrat-latin-700-normal.woff2`);
    assert.equal(anonFont.status, 200, 'anonymous shared font asset must be public');
    assert.match(anonFont.headers.get('content-type') ?? '', /font\/woff2/);
    const anonHostStart = await fetch(`${baseUrl}/api/game/quiz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quizId: 'seed' }),
    });
    assert.equal(anonHostStart.status, 401, 'anonymous mutation must be 401');
  })();

  // Bad password: 401 + JSON error (issue 02 surface).
  const badLogin = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'not-it' }),
  });
  assert.equal(badLogin.status, 401);
  assert.deepEqual(await badLogin.json(), { error: 'wrong password' });

  // Good password -> session cookie for the rest of the smoke.
  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  assert.equal(loginRes.status, 204);
  const setCookie = loginRes.headers.get('set-cookie') ?? '';
  assert.ok(setCookie.startsWith(SESSION_COOKIE_PREFIX), 'login must set the session cookie');
  const cookie = setCookie.split(';')[0];
  const withCookie = (route, init = {}) =>
    fetch(`${baseUrl}${route}`, { ...init, headers: { Cookie: cookie, ...(init.headers || {}) } });

  // --- static + editor page served from the bundle (authenticated) --------
  for (const route of [
    '/',
    '/play',
    '/host',
    '/editor',
    '/host.css',
    '/dashboard.css',
    '/editor.js',
    '/dashboard.js',
    '/player.js',
  ]) {
    const res = await withCookie(route);
    assert.equal(res.status, 200, `GET ${route} must serve from the bundle`);
    if (route.endsWith('.html')) {
      const text = await res.text();
      assert.match(text, /<html/i, `GET ${route} must return a page`);
      // Issue 04 route map: / must be the dashboard page, /host the host page.
      if (route === '/') assert.match(text, /app\.title\.dashboard/, '/ must serve the dashboard');
      if (route === '/host') assert.match(text, /app\.title\.host/, '/host must serve the host page');
    }
  }
  const badFile = await fetch(`${baseUrl}/server.cjs`);
  assert.notEqual(badFile.status, 200, 'unknown assets must not be served');
  const badNested = await fetch(`${baseUrl}/public/host.js/../host.js`);
  assert.notEqual(badNested.status, 200, 'traversal-style requests must not be served');

  // Embedded seed quiz materialized beside the exe; bundle stays read-only.
  assert.ok(existsSync(path.join(runDir, 'data', 'quizzes', 'seed.json')));
  const quizzes = await withCookie('/api/quizzes').then((r) => r.json());
  assert.ok(
    quizzes.some((q) => q.id === 'seed' && q.title === SEED_TITLE && q.questionCount === 4),
    'picker must list the embedded seed quiz: seed materialized beside exe',
  );

  // --- sockets: anonymous spoof first, then the authenticated host ---------
  const client = () => {
    const socket = io(baseUrl, {
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
    });
    if (process.env.SMOKE_VERBOSE) {
      socket.onAny((ev, ...args) => console.log('SOCKET>>', ev, JSON.stringify(args[0] ?? null).slice(0, 160)));
      socket.on('answerRejected', (r) => console.log('SOCKET>> answerRejected', JSON.stringify(r)));
    }
    return socket;
  };

  // Spoof check (issue 03): anonymous socket claims host, then hostStart ->
  // the game must NOT start (no question or lobby state within the window).
  await (async () => {
    const spoof = client();
    spoof.emit('host');
    spoof.emit('hostStart');
    let spoofStates = 0;
    spoof.on('state', () => spoofStates++);
    await wait(1200);
    assert.equal(spoofStates, 0, 'anonymous socket must not drive the game');
    spoof.disconnect();
    await wait(100);
  })();

  const session = await withCookie('/api/session').then((r) => r.json());
  assert.equal(typeof session.pin, 'string');
  // Issue-05 paid-review fix: `live` is false in the lobby — the dashboard
  // banner must not claim a game is live before the host actually starts one.
  assert.equal(session.live, false, 'a loaded lobby is not a live game');

  // Dashboard Start flow (issue 04): POST /api/game/quiz loads the seed quiz
  // into the live session before the host screen takes it live.
  const dashboardStart = await withCookie('/api/game/quiz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quizId: 'seed' }),
  });
  assert.equal(dashboardStart.status, 200, 'dashboard Start (POST /api/game/quiz) must work');
  assert.deepEqual(await dashboardStart.json(), { ok: true, id: 'seed', title: SEED_TITLE, questionCount: 4 });

  // The REAL host cookie rides its handshake (withCredentials in the pages).
  const host = io(baseUrl, {
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
    extraHeaders: { Cookie: cookie },
  });
  if (process.env.SMOKE_VERBOSE) {
    host.onAny((ev, ...args) => console.log('SOCKET>> host', ev, JSON.stringify(args[0] ?? null).slice(0, 160)));
  }
  // Wire contract: `host` only MARKS the socket; the first broadcast is a
  // join's state (no state is emitted for the marking itself).
  host.emit('host');

  // --- players join over the wire ----------------------------------------
  // Wire contract (src/socket.ts): join { pin, name } -> `joined` + `state`.
  const player1 = client();
  const player2 = client();
  player1.emit('join', { pin: session.pin, name: P1_NAME, color: 'red' });
  player2.emit('join', { pin: session.pin, name: P2_NAME, color: 'blue' });
  const p1Id = (await waitForEvent(player1, 'joined', (j) => j.name === P1_NAME, 10_000, 'p1 joined')).playerId;
  const p2Id = (await waitForEvent(player2, 'joined', (j) => j.name === P2_NAME, 10_000, 'p2 joined')).playerId;
  assert.notEqual(p1Id, p2Id);
  const lobby = await waitForEvent(
    host,
    'state',
    (s) => s.phase === 'lobby' && s.players.length === 2,
    10_000,
    '2 players in lobby',
  );
  assert.deepEqual(
    lobby.players.map((p) => p.name).sort(),
    [P1_NAME, P2_NAME],
  );

  // --- full game: launch -> 4x answer/reveal/next -> podium ---------------
  const questionTimeoutMs = 30_000;
  for (let q = 0; q < SEED_ANSWER_INDEX.length; q++) {
    if (q === 0) host.emit('hostStart');
    const question = await waitForEvent(
      host,
      'state',
      (s) => s.phase === 'question' && s.currentQuestion?.questionIndex === q,
      questionTimeoutMs,
      `question ${q} state`,
    );
    assert.ok(question.currentQuestion.prompt.length > 0);
    assert.equal('correctIndex' in question.currentQuestion, false, 'state view must not leak answers');
    if (q === 0) {
      // The live flag rides with the running engine (issue-05 paid-review fix).
      const midGame = await withCookie('/api/session').then((r) => r.json());
      assert.equal(midGame.live, true, 'a running game must report live');
    }
    // Player 1 answers correctly; player 2 picks a different option.
    player1.emit('answer', { answerIndex: SEED_ANSWER_INDEX[q] });
    player2.emit('answer', { answerIndex: (SEED_ANSWER_INDEX[q] + 1) % 4 });

    // Host reveal: broadcastReveal then state(reveal). Both listeners are
    // registered BEFORE the emit — the reveal-phase state broadcast drives
    // faster than a second round-trip could.
    const revealWait = waitForEvent(
      host,
      'reveal',
      (r) => r.questionIndex === q,
      questionTimeoutMs,
      `reveal ${q}`,
    );
    const revealStateWait = waitForEvent(
      host,
      'state',
      (s) => s.phase === 'reveal',
      questionTimeoutMs,
      `reveal state ${q}`,
    );
    host.emit('reveal');
    const reveal = await revealWait;
    await revealStateWait;
    assert.equal(reveal.correctIndex, SEED_ANSWER_INDEX[q]);
    assert.equal(reveal.results.length, 2);
    assert.equal(reveal.results.find((r) => r.playerId === p1Id).correct, true);
    assert.equal(reveal.results.find((r) => r.playerId === p2Id).correct, false);

    host.emit('next');
    const board = await waitForEvent(
      host,
      'state',
      (s) => s.phase === 'leaderboard',
      questionTimeoutMs,
      `leaderboard after question ${q}`,
    );
    if (q !== SEED_ANSWER_INDEX.length - 1) {
      assert.equal(board.leaderboard[0], p1Id, 'correct player must lead the board');
      host.emit('next'); // leaderboard -> next question
      continue;
    }
    // Final question: leaderboard -> next -> podium.
    host.emit('next');
    const podium = await waitForEvent(
      host,
      'state',
      (s) => s.phase === 'podium',
      questionTimeoutMs,
      'podium',
    );
    assert.equal(podium.leaderboard[0], p1Id);
    assert.ok(podium.scores[p1Id] > 0, 'player 1 must have scored points');
    assert.equal(podium.scores[p2Id], 0);
  }

  // --- results written beside the exe ------------------------------------
  const resultsDir = path.join(runDir, 'data', 'results');
  // The save happens async on the podium broadcast; poll briefly.
  const resultFiles = await (async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const files = readdirSync(resultsDir).filter((f) => f.endsWith('.json'));
        if (files.length > 0) return files;
      } catch {
        // dir not yet created
      }
      await wait(100);
    }
    return [];
  })();
  assert.equal(resultFiles.length, 1, 'exactly one results file for the one finished game');

  const results = JSON.parse(
    readFileSync(path.join(resultsDir, resultFiles[0]), 'utf8'),
  );
  assert.equal(results.quizTitle, SEED_TITLE);
  assert.equal(results.players.length, 2);
  assert.equal(results.questions.length, SEED_ANSWER_INDEX.length);

  // --- nothing runtime-writable landed in the project tree ---------------
  // A dev machine's data/results may already hold REAL games from manual
  // play, which the smoke may not touch or delete. So assert freshness
  // instead of emptiness: nothing was WRITTEN into the project tree during
  // this run (the exe writes beside itself instead).
  assert.ok(existsSync(path.join(root, 'data', 'quizzes', 'seed.json')));
  const projectResults = path.join(root, 'data', 'results');
  const newProjectResults = existsSync(projectResults)
    ? readdirSync(projectResults).filter((file) => {
        try {
          return statSync(path.join(projectResults, file)).mtimeMs > smokeStartedAtMs;
        } catch {
          return true; // unreadable -> treated as suspicious
        }
      })
    : [];
  assert.deepEqual(
    newProjectResults,
    [],
    'the exe must write results beside itself, never into the project tree',
  );

  console.log(
    'SMOKE PASS: launch, join x2, 4x answer/reveal/next, podium and results saving all ' +
      'completed on the standalone executable with runtime data beside it.',
  );
} finally {
  if (child) {
    child.kill('SIGTERM');
    await wait(300); // let the process and its file handles drop
    child = undefined;
  }
  rmSync(runDir, { recursive: true, force: true });
}
