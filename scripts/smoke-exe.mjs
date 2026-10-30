#!/usr/bin/env node
// Smoke test for the standalone executable (NOT part of `npm test` — it needs
// dist/offline-kahoot built first; run `node scripts/build.mjs` beforehand).
//
// What it proves against the bundle running with node:sea embedded assets:
//   1. The executable spawns directly (no `node`/npm on PATH) and serves the
//      embedded public pages (/, /play, /editor) and static files.
//   2. Runtime data lives BESIDE the executable: the embedded seed.json is
//      materialized into data/quizzes/, listed by /api/quizzes, and a finished
//      game writes data/results/ next to the exe — never into the project tree.
//   3. A complete game over the wire on the standalone binary:
//      launch -> join (2 players + host) -> 4x answer/reveal/next -> podium.
//
// Sandbox note: run with `node scripts/smoke-exe.mjs`.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exeName = process.platform === 'win32' ? 'offline-kahoot.exe' : 'offline-kahoot';
const builtExe = path.join(root, 'dist', exeName);
const runDir = path.join(root, 'dist', 'smoke-tmp');
const HOST_PAGE_LINE = /host page: \S*?:(\d+)/;

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
  assert.ok(existsSync(builtExe), `no executable at ${builtExe} — run scripts/build.mjs first`);

  // Fresh dir: forces data/ creation beside this copy of the exe.
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const exePath = path.join(runDir, exeName);
  copyFileSync(builtExe, exePath);

  // Act like a target machine WITHOUT node: run the copied exe directly.
  child = spawn(exePath, [], { cwd: runDir, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => {
    if (process.env.SMOKE_VERBOSE) console.error('EXE STDERR:', c);
  });
  child.on('exit', (code) => {
    if (process.env.SMOKE_VERBOSE) console.error('EXE EXITED with code', code);
  });
  const port = await waitPort(child);
  const baseUrl = `http://127.0.0.1:${port}`;

  // --- static + editor page served from the bundle ------------------------
  for (const route of ['/', '/play', '/editor', '/host.css', '/editor.js', '/player.js']) {
    const res = await fetch(`${baseUrl}${route}`);
    assert.equal(res.status, 200, `GET ${route} must serve from the bundle`);
    if (route.endsWith('.html')) {
      const text = await res.text();
      assert.match(text, /<html/i, `GET ${route} must return a page`);
    }
  }
  const badFile = await fetch(`${baseUrl}/server.cjs`);
  assert.notEqual(badFile.status, 200, 'unknown assets must not be served');
  const badNested = await fetch(`${baseUrl}/public/host.js/../host.js`);
  assert.notEqual(badNested.status, 200, 'traversal-style requests must not be served');

  // Embedded seed quiz materialized beside the exe; bundle stays read-only.
  assert.ok(existsSync(path.join(runDir, 'data', 'quizzes', 'seed.json')));
  const quizzes = await fetch(`${baseUrl}/api/quizzes`).then((r) => r.json());
  assert.ok(
    quizzes.some((q) => q.id === 'seed' && q.title === SEED_TITLE && q.questionCount === 4),
    'picker must list the embedded seed quiz: seed materialized beside exe',
  );

  // --- sockets: host marks itself ----------------------------------------
  const session = await fetch(`${baseUrl}/api/session`).then((r) => r.json());
  assert.equal(typeof session.pin, 'string');

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
  const host = client();
  // Wire contract: `host` only MARKS the socket; the first broadcast is a
  // join's state (no state is emitted for the marking itself).
  host.emit('host');

  // --- players join over the wire ----------------------------------------
  // Wire contract (src/socket.ts): join { pin, name } -> `joined` + `state`.
  const player1 = client();
  const player2 = client();
  player1.emit('join', { pin: session.pin, name: P1_NAME });
  player2.emit('join', { pin: session.pin, name: P2_NAME });
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
  assert.ok(existsSync(path.join(root, 'data', 'quizzes', 'seed.json')));
  const projectResults = path.join(root, 'data', 'results');
  assert.ok(!existsSync(projectResults) || readdirSync(projectResults).length === 0);

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
