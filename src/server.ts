import { createServer } from 'node:http';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import { GameSession } from './game-session.js';
import { wireSockets } from './socket.js';
import { generatePin } from './pin.js';
import { GameResultsRecorder } from './results.js';
import { detectLanIp, formatJoinUrl, isPortReachable, listenOnFreePort } from './network.js';
import {
  deleteQuizFile,
  exportQuiz,
  listQuizzes,
  newQuizFilePath,
  readQuizFile,
  validateQuiz,
  writeQuizFile,
} from './storage.js';
import { stateView } from './state-view.js';
import type { Quiz } from './engine.js';

const DEFAULT_PORT = 3000;
const PORT_MAX_RETRIES = 9; // 3000..3009 per "default port 3000, auto-increment if busy"
const LOG_PREFIX = '[offline-kahoot]';

const app = express();
// One http server hosts both the HTTP routes and socket.io, so players join
// over the same host/port the QR code points at.
const httpServer = createServer(app);
const here = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use(express.static(path.join(here, '..', 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(here, '..', 'public', 'host.html'));
});

app.get('/play', (_req, res) => {
  res.sendFile(path.join(here, '..', 'public', 'player.html'));
});

app.get('/editor', (_req, res) => {
  res.sendFile(path.join(here, '..', 'public', 'editor.html'));
});

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

function session(): { pin: string; joinUrl: string; qrDataUrl: string } | null {
  return (app.locals.session as { pin: string; joinUrl: string; qrDataUrl: string } | null) ?? null;
}

// Quiz files live in data/quizzes/, one JSON file per quiz; seed.json ships
// with the project and is the quiz loaded at boot.
const QUIZZES_DIR = path.join(here, '..', 'data', 'quizzes');
const SEED_QUIZ_PATH = path.join(QUIZZES_DIR, 'seed.json');
/** Finished-game results go to data/results/YYYY-MM-DD_HHmm.json (see CONTEXT.md). */
const RESULTS_DIR = path.join(here, '..', 'data', 'results');
/** Fallback when storage is unavailable at boot: a game that simply cannot start. */
const FALLBACK_QUIZ: Quiz = { title: 'Untitled Quiz', questions: [] };

async function bootQuiz(): Promise<Quiz> {
  try {
    return await readQuizFile(SEED_QUIZ_PATH);
  } catch (err) {
    console.warn(`${LOG_PREFIX} seed quiz unavailable (${
      err instanceof Error ? err.message : String(err)
    }); starting with an empty quiz`);
    return FALLBACK_QUIZ;
  }
}

// The one live session for this server process, seeded from data/quizzes/seed.json.
const gameSession = new GameSession(await bootQuiz());

const pin = generatePin();
const io = new Server(httpServer);
wireSockets(io, {
  gameSession,
  sessionPin: pin,
  results: new GameResultsRecorder(RESULTS_DIR),
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
    const joinUrl = formatJoinUrl(hostIp, port);
    app.locals.session = {
      pin,
      joinUrl,
      qrDataUrl: await QRCode.toDataURL(joinUrl),
    };

    const reachable = await isPortReachable(hostIp, port);
    console.log(`${LOG_PREFIX} host page: ${joinUrl}`);
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

// Unhandled promise rejections would mask the boot logs above; surface them loudly.
process.on('unhandledRejection', (reason) => {
  console.error(`${LOG_PREFIX} unhandled rejection:`, reason);
  process.exit(1);
});

