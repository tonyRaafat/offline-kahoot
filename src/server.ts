import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAsset } from 'node:sea';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import { GameSession } from './game-session.js';
import { wireSockets } from './socket.js';
import { generatePin } from './pin.js';
import { GameResultsRecorder } from './results.js';
import { detectLanIp, formatJoinUrl, isPortReachable, listenOnFreePort } from './network.js';
import {
  clearedSessionCookie,
  createSessionToken,
  sessionCookie,
  sessionCookieFrom,
  verifySessionToken,
} from './auth.js';
import { requireAdminPassword } from './env.js';
import {
  deleteQuizFile,
  exportQuiz,
  importQuiz,
  listQuizzes,
  newQuizFilePath,
  readQuizFile,
  validateQuiz,
  writeQuizFile,
} from './storage.js';
import { stateView } from './state-view.js';
import {
  dataRootBesideExecutable,
  isRunningAsSea,
  publicPathToAssetKey,
  SEA_SEED_ASSET_KEY,
} from './sea-assets.js';
import type { Quiz } from './engine.js';

const DEFAULT_PORT = 3000;
const PORT_MAX_RETRIES = 9; // 3000..3009 per "default port 3000, auto-increment if busy"
const LOG_PREFIX = '[offline-kahoot]';

/** True when serving from the standalone Node SEA bundle (scripts/build.mjs). */
const RUNNING_AS_SEA = isRunningAsSea();

const app = express();
// Request logging: every incoming HTTP request is logged so we can tell
// whether a player's phone ever reaches this server (diagnosing the
// "page keeps loading" symptom). Runs before all other middleware/routes.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    console.log(
      `${LOG_PREFIX} HTTP ${req.method} ${req.originalUrl} -> ${res.statusCode} ` +
        `(${Date.now() - started}ms) from ${req.ip} agent=${req.headers['user-agent'] ?? '?'}`,
    );
  });
  next();
});
// One http server hosts both the HTTP routes and socket.io, so players join
// over the same host/port the QR code points at.
const httpServer = createServer(app);
// Base dir for filesystem mode. `import.meta.url` survives tsx/ESM but is
// shimmed away by esbuild in the SEA CJS bundle, where the executable location
// is the only meaningful anchor.
const here =
  typeof import.meta.url === 'string'
    ? path.dirname(fileURLToPath(import.meta.url))
    : path.dirname(process.execPath);
const PUBLIC_DIR = path.join(here, '..', 'public');

app.use(express.json());
if (RUNNING_AS_SEA) {
  // Standalone bundle: there is no public/ directory on disk; serve exactly
  // the asset keys baked in at build time (see src/sea-assets.ts), split by
  // visibility (see the asset-visibility sets below): world-readable shared
  // + /play assets for everyone, protected page assets only with a session.
  // Anything else — including API routes — falls through to the handlers
  // below.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    let pathname = req.path;
    try {
      pathname = decodeURIComponent(req.path);
    } catch {
      // malformed escape sequence — resolves to no key below
    }
    const key = publicPathToAssetKey(pathname);
    if (!key) {
      next();
      return;
    }
    const file = key.slice('public/'.length);
    const send = (): boolean => {
      try {
        if (key.endsWith('.woff2')) {
          // Fonts embed as binary assets; utf8 would corrupt them. getAsset
          // without an encoding returns the raw buffer.
          res.type(assetContentType(key)).send(Buffer.from(getAsset(key)));
          return true;
        }
        res.type(assetContentType(key)).send(getAsset(key, 'utf8'));
        return true;
      } catch {
        return false; // listed key whose asset is missing — fall through
      }
    };
    if (PUBLIC_ASSET_FILES.has(file)) {
      if (!send()) next();
      return;
    }
    if (PROTECTED_ASSET_FILES.has(file)) {
      serveProtectedAsset(req, res, file, () => {
        if (!send()) next();
      });
      return;
    }
    next();
  });
} else {
  // Filesystem mode: an explicit an allowlist replaces the blanket
  // express.static so protected page assets are never served anonymously
  // (issue 03's static asset split). Anything unlisted falls through.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    let file: string | null = null;
    try {
      file = decodeURIComponent(req.path.slice(1));
    } catch {
      file = null; // malformed escape sequence — resolve to "not listed"
    }
    if (!file) {
      next(); // malformed or empty — resolve to "not listed"
      return;
    }
    if (file.includes('/') && !file.startsWith('fonts/')) {
      // Pages and API live on named routes; the fonts/ subfolder (issue 05's
      // self-hosted display font) is the one deliberately-listed exception.
      next();
      return;
    }
    if (PUBLIC_ASSET_FILES.has(file)) {
      res.sendFile(path.join(PUBLIC_DIR, file));
      return;
    }
    if (PROTECTED_ASSET_FILES.has(file)) {
      serveProtectedAsset(req, res, file, () => res.sendFile(path.join(PUBLIC_DIR, file)));
      return;
    }
    next();
  });
}

/**
 * MIME for an embedded asset key: express' res.type() treats a string with a
 * '/' as a literal Content-Type, so passing the full 'public/x.css' key set a
 * wrong header — key the lookup off the extension instead.
 */
function assetContentType(key: string): string {
  return key.slice(key.lastIndexOf('.') + 1); // e.g. 'css' -> text/css
}

/**
 * Static-asset visibility splits (the names of files in public/):
 *   - PUBLIC: shared tokens/i18n/avatars + /login, /play files, and host.css —
 *     fetchable by any visitor (players must remain able to join, and the
 *     login page loads the shared component layer, issue 01).
 *   - PROTECTED: page-specific assets of the admin pages; anonymous requests
 *     get a page-like redirect for .html (so typing /host.html lands on the
 *     login flow) and a 401 JSON for css/js (fetches by pages the user must
 *     already be authorized for). Issue 04 extended PROTECTED with the
 *     dashboard page assets.
 */
const PUBLIC_ASSET_FILES: ReadonlySet<string> = new Set([
  'tokens.css',
  // Shared component layer (issue 01): the anonymous /login page now loads
  // host.css like every other page, so it must be world-readable too. It
  // carries no secrets — it is chrome styling only.
  'host.css',
  'i18n.js',
  'avatar.js',
  'question-defaults.js',
  'question-defaults.d.ts',
  // Self-hosted Montserrat woff2 (issue 05): public like the other shared
  // assets, because the (public) login page loads them before any session.
  'fonts/montserrat-latin-400-normal.woff2',
  'fonts/montserrat-latin-700-normal.woff2',
  'fonts/montserrat-latin-800-normal.woff2',
  'fonts/montserrat-latin-ext-400-normal.woff2',
  'fonts/montserrat-latin-ext-700-normal.woff2',
  'fonts/montserrat-latin-ext-800-normal.woff2',
  'player.html',
  'player.js',
  'login.html',
  'login.js',
  'login.css',
]);
const PROTECTED_ASSET_FILES: ReadonlySet<string> = new Set([
  'dashboard.html',
  'dashboard.js',
  'dashboard.css',
  'host.html',
  'host.js',
  'editor.html',
  'editor.js',
  'editor.css',
]);

/** Gate one protected asset: session -> serve; .html redirects, rest 401 JSON. */
function serveProtectedAsset(
  req: express.Request,
  res: express.Response,
  file: string,
  send: () => void,
): void {
  if (isSessionValid(req)) {
    send();
    return;
  }
  if (file.endsWith('.html')) {
    res.redirect('/login');
    return;
  }
  res.status(401).json({ error: 'unauthorized: log in at /login' });
}

/** True when the request carries a valid signed session cookie. */
function isSessionValid(req: Pick<express.Request, 'headers'>): boolean {
  return verifySessionToken(sessionCookieFrom(req.headers));
}

/** Unauthenticated pages/admin data always bounce to the login page. */
function requireLoginPage(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (isSessionValid(req)) {
    next();
    return;
  }
  res.redirect('/login');
}

// /login: GET is public (but an already-logged-in visitor goes straight to
// the dashboard route, which serves the issue-04 dashboard page).
app.get('/login', (req, res) => {
  if (isSessionValid(req)) {
    res.redirect('/');
    return;
  }
  sendPage(res, 'login.html');
});

// Dashboard at / (admin-dashboard issue 04): the quiz-management home page.
app.get('/', requireLoginPage, (_req, res) => {
  sendPage(res, 'dashboard.html');
});

// /host is the live-game page (issue 04 moved the host flow here from /).
app.get('/host', requireLoginPage, (_req, res) => {
  sendPage(res, 'host.html');
});

// /play stays world-readable: players never log in.
app.get('/play', (_req, res) => {
  sendPage(res, 'player.html');
});

app.get('/editor', requireLoginPage, (_req, res) => {
  sendPage(res, 'editor.html');
});

/** Serves one app page from the embedded assets (SEA) or public/ (npm start). */
function sendPage(
  res: express.Response,
  pageFile:
    | 'dashboard.html'
    | 'host.html'
    | 'player.html'
    | 'editor.html'
    | 'login.html',
): void {
  if (RUNNING_AS_SEA) {
    const key = publicPathToAssetKey(`/${pageFile}`);
    if (!key) {
      res.status(404).end();
      return;
    }
    res.type(assetContentType(key)).send(getAsset(key, 'utf8'));
    return;
  }
  res.sendFile(path.join(PUBLIC_DIR, pageFile));
}

/** Quiz ids are filenames; reject anything that could escape data/quizzes/. */
function isSafeQuizId(id: unknown): id is string {
  return (
    typeof id === 'string' && id.length > 0 && !id.includes('..') && /^[A-Za-z0-9._-]+$/.test(id)
  );
}

/** Missing file, malformed JSON, or invalid shape all read as "unknown quiz". */
async function readStoredQuiz(id: string): Promise<Quiz | null> {
  try {
    return await readQuizFile(path.join(QUIZZES_DIR, `${id}.json`));
  } catch {
    return null;
  }
}

// Every /api route is admin surface (quiz CRUD/import/export, the live-game
// session/quiz reads) EXCEPT the two auth endpoints, which stay open. All the
// gated routes share one 401 JSON error shape ({error}, matching the {error}
// convention the editor already surfaces).
app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') {
    next();
    return;
  }
  if (isSessionValid(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized: log in at /login' });
});

/** Wrong-password responses are delayed to blunt brute forcing a LAN tool. */
const WRONG_PASSWORD_DELAY_MS = 300;

/** Login: {password} -> a signed session cookie (HttpOnly, SameSite=Lax, /). */
app.post('/api/login', (req, res) => {
  const raw = (req.body as { password?: unknown } | null)?.password;
  const given = typeof raw === 'string' ? raw : '';
  const expected = adminPasswordValue;
  // SHA-256 then timingSafeEqual so the comparison is constant-time including
  // length differences (raw byte buffers would throw on unequal lengths).
  const digest = (s: string): Buffer => createHash('sha256').update(s).digest();
  if (expected.length === 0 || !timingSafeEqual(digest(given), digest(expected))) {
    setTimeout(
      () => res.status(401).json({ error: 'wrong password' }),
      WRONG_PASSWORD_DELAY_MS,
    );
    return;
  }
  res.setHeader('Set-Cookie', sessionCookie(createSessionToken(expected)));
  res.status(204).end();
});

/** Logout: clears the session cookie; idempotent (always 204). */
app.post('/api/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearedSessionCookie());
  res.status(204).end();
});

app.get('/api/session', async (_req, res) => {
  res.json(session());
});
// Browse stored quizzes: [{ id, title, questionCount }]. Unreadable files are
// skipped so one corrupt file cannot break the whole picker.
app.get('/api/quizzes', async (_req, res) => {
  const ids = await listQuizzes(QUIZZES_DIR);
  const quizzes = (
    await Promise.all(ids.map(async (id) => ({ id, quiz: await readStoredQuiz(id) })))
  )
    .filter((entry): entry is { id: string; quiz: Quiz } => entry.quiz !== null)
    .map(({ id, quiz }) => ({ id, title: quiz.title, questionCount: quiz.questions.length }));
  res.json(quizzes);
});

// Host quiz selection: swap the live session into a fresh lobby for the
// selected quiz (joined players are preserved) and push the new state view.
app.post('/api/game/quiz', async (req, res) => {
  const { quizId } = req.body as { quizId?: unknown };
  if (!isSafeQuizId(quizId)) {
    res.status(400).json({ error: 'quizId must be the name of a stored quiz file (without .json)' });
    return;
  }
  const quiz = await readStoredQuiz(quizId);
  if (!quiz) {
    res.status(404).json({ error: `unknown quiz id: ${quizId}` });
    return;
  }
  gameSession.loadQuiz(quiz);
  io.emit('state', stateView(gameSession.current));
  res.json({ ok: true, id: quizId, title: quiz.title, questionCount: quiz.questions.length });
});

// Import: the request body IS the quiz JSON; validate strictly, then persist
// under a unique filename derived from the title.
app.post('/api/quizzes/import', async (req, res) => {
  const result = validateQuiz(req.body);
  if (!result.ok) {
    res.status(400).json({ error: 'invalid quiz', errors: result.errors });
    return;
  }
  const filePath = await newQuizFilePath(QUIZZES_DIR, result.quiz.title);
  await writeQuizFile(filePath, result.quiz);
  const id = path.basename(filePath, '.json');
  res
    .status(201)
    .json({ ok: true, id, title: result.quiz.title, questionCount: result.quiz.questions.length });
});

// Editor CRUD: one quiz = one data/quizzes/<id>.json file. Every :id route
// reuses isSafeQuizId() (see below) so ids can never escape data/quizzes/.

// Full quiz JSON for editing on /editor.
app.get('/api/quizzes/:id', async (req, res) => {
  const { id } = req.params;
  if (!isSafeQuizId(id)) {
    res.status(400).json({ error: 'invalid quiz id' });
    return;
  }
  const quiz = await readStoredQuiz(id);
  if (!quiz) {
    res.status(404).json({ error: `unknown quiz id: ${id}` });
    return;
  }
  res.json(quiz);
});

// Editor creation: { title } only — the quiz starts empty, persisted under a
// unique slug filename just like the import route.
app.post('/api/quizzes', async (req, res) => {
  const title = (req.body as { title?: unknown } | null)?.title;
  if (typeof title !== 'string' || title.trim() === '') {
    res.status(400).json({ error: 'title: must be a non-empty string' });
    return;
  }
  const filePath = await newQuizFilePath(QUIZZES_DIR, title);
  await writeQuizFile(filePath, { title, questions: [] });
  const id = path.basename(filePath, '.json');
  res.status(201).json({ id, title });
});

// Editor save / rename: the body IS the full quiz object. validateQuiz stays
// authoritative; invalid saves are rejected with the full error list.
app.put('/api/quizzes/:id', async (req, res) => {
  const { id } = req.params;
  if (!isSafeQuizId(id)) {
    res.status(400).json({ error: 'invalid quiz id' });
    return;
  }
  if (!(await readStoredQuiz(id))) {
    res.status(404).json({ error: `unknown quiz id: ${id}` });
    return;
  }
  const result = validateQuiz(req.body);
  if (!result.ok) {
    res.status(400).json({ error: 'invalid quiz', errors: result.errors });
    return;
  }
  await writeQuizFile(path.join(QUIZZES_DIR, `${id}.json`), result.quiz);
  res.json({ ok: true, id, title: result.quiz.title, questionCount: result.quiz.questions.length });
});

// Editor delete: removes the quiz file; unknown ids read as 404 (ENOENT).
app.delete('/api/quizzes/:id', async (req, res) => {
  const { id } = req.params;
  if (!isSafeQuizId(id)) {
    res.status(400).json({ error: 'invalid quiz id' });
    return;
  }
  try {
    await deleteQuizFile(path.join(QUIZZES_DIR, `${id}.json`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: `unknown quiz id: ${id}` });
      return;
    }
    throw err;
  }
  res.json({ ok: true, id });
});

// Request bodies that are not JSON get a clear JSON error instead of
// express' default HTML 400.
app.use(
  '/api',
  (
    err: Error & { type?: string },
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'request body is not valid JSON' });
      return;
    }
    next(err);
  },
);

// Export: the stored quiz JSON as a downloadable file.
app.get('/api/quizzes/:id/export', async (req, res) => {
  const { id } = req.params;
  if (!isSafeQuizId(id)) {
    res.status(400).json({ error: 'invalid quiz id' });
    return;
  }
  const quiz = await readStoredQuiz(id);
  if (!quiz) {
    res.status(404).json({ error: `unknown quiz id: ${id}` });
    return;
  }
  res.setHeader('Content-Disposition', `attachment; filename="${id}.json"`);
  res.type('application/json').send(exportQuiz(quiz));
});

/**
 * Returns the join info (PIN / join URL / QR) plus a `live` flag: true only
 * while the engine is actually running a game (any phase past the lobby —
 * question / reveal / leaderboard / podium). Issue 04's report flagged the
 * dashboard live banner as "whenever a PIN exists"; the paid-review fix keeps
 * the wire addition minimal (`live: boolean`) — the host pages read
 * pin/joinUrl/qrDataUrl exactly as before.
 */
function session(): { pin: string; joinUrl: string; qrDataUrl: string; live: boolean } | null {
  const base = app.locals.session as
    | { pin: string; joinUrl: string; qrDataUrl: string }
    | null
    | undefined;
  if (!base) return null;
  // The engine phase lives server-side on the live session; only this boolean
  // crosses the wire — phases/questions themselves stay out of the HTTP API.
  return { ...base, live: gameSession.current.phase !== 'lobby' };
}

// Quiz files live in data/quizzes/, one JSON file per quiz. In the standalone
// bundle everything read-only (pages, seed quiz) is INSIDE the executable,
// while runtime-writable data goes beside the executable — the bundle itself
// must never be written to. npm-start mode keeps the project data/ location.
const DATA_ROOT = RUNNING_AS_SEA
  ? dataRootBesideExecutable(process.execPath)
  : path.join(here, '..', 'data');
const QUIZZES_DIR = path.join(DATA_ROOT, 'quizzes');
const SEED_QUIZ_PATH = path.join(QUIZZES_DIR, 'seed.json');
/** Finished-game results go to data/results/YYYY-MM-DD_HHmm.json (see CONTEXT.md). */
const RESULTS_DIR = path.join(DATA_ROOT, 'results');
/** Fallback when storage is unavailable at boot: a game that simply cannot start. */
const FALLBACK_QUIZ: Quiz = { title: 'Untitled Quiz', questions: [] };

async function bootQuiz(): Promise<Quiz> {
  if (!RUNNING_AS_SEA) {
    try {
      return await readQuizFile(SEED_QUIZ_PATH);
    } catch (err) {
      console.warn(`${LOG_PREFIX} seed quiz unavailable (${
        err instanceof Error ? err.message : String(err)
      }); starting with an empty quiz`);
      return FALLBACK_QUIZ;
    }
  }
  // SEA: the seed quiz ships as an embedded asset. First run materializes it
  // beside the executable so the editor lists/edits/deletes it like any other
  // quiz; an existing (possibly edited) copy is never overwritten.
  try {
    return await readQuizFile(SEED_QUIZ_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`${LOG_PREFIX} seed quiz unavailable (${
        err instanceof Error ? err.message : String(err)
      }); starting with an empty quiz`);
      return FALLBACK_QUIZ;
    }
  }
  try {
    const seed = parseEmbeddedSeedQuiz();
    await writeQuizFile(SEED_QUIZ_PATH, seed);
    return seed;
  } catch (err) {
    console.warn(`${LOG_PREFIX} seed quiz unavailable (${
      err instanceof Error ? err.message : String(err)
    }); starting with an empty quiz`);
    return FALLBACK_QUIZ;
  }
}

/** Parses the embedded seed asset with the same strict validation as import. */
function parseEmbeddedSeedQuiz(): Quiz {
  const result = importQuiz(getAsset(SEA_SEED_ASSET_KEY, 'utf8'));
  if (!result.ok) {
    throw new Error(`embedded seed quiz invalid: ${result.errors.join('; ')}`);
  }
  return result.quiz;
}

// Assigned in main() BEFORE the server starts listening, so the handlers
// registered above can never run against unset values.
let gameSession!: GameSession;
let io!: Server;
/** The boot-validated admin password (IDENTITY for login + token signing). */
let adminPasswordValue = '';

/** Boot of the live session + stream wiring + listening; no top-level await,
 *  so the SEA bundle can ship this module as CommonJS (SEA requires it). */
async function main(): Promise<void> {
  // Auth gate FIRST (issue 01): refuse to boot without ADMIN_PASSWORD —
  // the server must never run unauthenticated. requireAdminPassword loads
  // .env (CWD, and beside the executable in SEA mode) with real-environment
  // precedence and throws the clear variable+file error on failure.
  try {
    adminPasswordValue = requireAdminPassword();
  } catch (err) {
    console.error(`${LOG_PREFIX} ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(
    `${LOG_PREFIX} ADMIN_PASSWORD loaded; admin sessions are signed cookies (HttpOnly, SameSite=Lax, ~30d)`,
  );
  // The one live session for this server process, seeded from data/quizzes/seed.json.
  gameSession = new GameSession(await bootQuiz());

  const pin = generatePin();
  io = new Server(httpServer);
  wireSockets(io, {
    gameSession,
    sessionPin: pin,
    results: new GameResultsRecorder(RESULTS_DIR),
    // Socket.io host gate (issue 03): only handshakes carrying a valid admin
    // session cookie may claim the `host` role. Production always configures
    // the checker here; wireSockets itself fails closed when a wiring omits
    // it (minimal test boots).
    verifySessionToken: (token) => verifySessionToken(token, adminPasswordValue),
  });
  const lanIp = await detectLanIp(process.platform);
  if (!lanIp) {
    console.warn(`${LOG_PREFIX} could not detect a LAN IP; players may need the host's address manually`);
  }
  const hostIp = lanIp ?? '127.0.0.1';

  listenOnFreePort(
    httpServer,
    DEFAULT_PORT,
    PORT_MAX_RETRIES,
    async (port) => {
      const hostUrl = formatJoinUrl(hostIp, port);
      const joinUrl = formatJoinUrl(hostIp, port, '/play');
      app.locals.session = {
        pin,
        joinUrl,
        qrDataUrl: await QRCode.toDataURL(joinUrl),
      };

      const reachable = await isPortReachable(hostIp, port);
      console.log(`${LOG_PREFIX} host page: ${hostUrl}`);
      console.log(`${LOG_PREFIX} join URL: ${joinUrl}`);
      console.log(`${LOG_PREFIX} session PIN: ${pin}`);
      console.log(
        reachable
          ? `${LOG_PREFIX} port self-test PASS: ${hostIp}:${port} is reachable`
          : `${LOG_PREFIX} port self-test FAIL: ${hostIp}:${port} is NOT reachable — check firewall/host isolation`,
      );
    },
    (err, port) => {
      console.error(
        err.code === 'EADDRINUSE'
          ? `${LOG_PREFIX} no free port found between ${DEFAULT_PORT} and ${port}`
          : `${LOG_PREFIX} failed to listen on port ${port}: ${err.message}`,
      );
      process.exit(1);
    },
  );
}
main();

// Unhandled promise rejections would mask the boot logs above; surface them loudly.
process.on('unhandledRejection', (reason) => {
  console.error(`${LOG_PREFIX} unhandled rejection:`, reason);
  process.exit(1);
});

