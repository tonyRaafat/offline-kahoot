// Socket-level smoke test: boots a minimal http.Server + socket.io with the
// real wireSockets() wiring and drives the join contract end to end —
// joinError on a bad PIN, `joined`+`state` on a valid join, duplicate-name
// suffixing across the wire, and reconnect resuming the same player — then a
// full question cycle: hostStart, answers, reveal, leaderboards, podium.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import type { Quiz } from './engine.js';
import { GameSession } from './game-session.js';
import { wireSockets } from './socket.js';
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from './auth.js';
import { GameResultsRecorder } from './results.js';
import { sampleQuiz } from './sample-quiz.js';

const SESSION_PIN = '123456';

/** Test admin password: hosts authenticate with a cookie signed from this. */
const ADMIN_PASSWORD = 'socket-test-admin-password';
let sessionToken = '';
let httpServer: HttpServer | undefined;
let baseUrl = '';

const clients: ClientSocket[] = [];

beforeAll(async () => {
  sessionToken = createSessionToken(ADMIN_PASSWORD);
  const app = expressless();
  httpServer = createServer(app);
  wireSockets(new Server(httpServer), {
    gameSession: new GameSession({ title: 'Test quiz', questions: [] }),
    sessionPin: SESSION_PIN,
    // Host-auth checker, wired like the production boot in src/server.ts:
    verifySessionToken: (token) => verifySessionToken(token, ADMIN_PASSWORD),
  });
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

// Minimal stand-in for the Express app: wireSockets only needs the http server.
function expressless() {
  return (_req: unknown, res: { end: (s: string) => void }) => res.end('ok');
}

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
});

/**
 * Connects a fresh client socket. By default it presents NO session cookie
 * (exactly like a /play player); `open({ auth: true })` joins the handshake
 * with a valid admin session so the socket may claim the `host` role.
 */
function open(opts: { auth?: boolean } = {}): ClientSocket {
  return openAt(baseUrl, opts);
}

function openAt(url: string, opts: { auth?: boolean } = {}): ClientSocket {
  const client = connect(url, {
    transports: ['websocket'],
    // Socket host gate (admin-dashboard issue 03): the handshake middleware
    // reads this header into socket.data.isAuthenticated; the websocket
    // transport attaches extraHeaders to the initial request too.
    ...(opts.auth
      ? { extraHeaders: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` } }
      : {}),
  });
  clients.push(client);
  return client;
}

/** Resolves with the next payload emitted for `event` on `client`. */
function nextEvent<T>(client: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => client.once(event, (payload: T) => resolve(payload)));
}

/** Resolves with the next `count` payloads of `event` on `client`, in arrival order. */
/**
 * Ordered per-event queue: attaches ONE persistent listener and buffers each
 * payload, so multiple awaited events are consumed one-by-one in arrival order.
 * (Side-by-side once() listeners would all fire on the first event, and a
 * deferred listener can miss events parsed in the same websocket frame.)
 */
function nextBatch<T>(client: ClientSocket, event: string, count: number): Promise<T[]> {
  const buffer: T[] = [];
  const waiters: Array<(payload: T) => void> = [];
  const deliver = (payload: T): void => {
    const waiter = waiters.shift();
    if (waiter) waiter(payload);
    else buffer.push(payload);
  };
  client.on(event, deliver);
  const next = (): Promise<T> => {
    const buffered = buffer.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise<T>((resolve) => waiters.push(resolve));
  };
  return Promise.all(Array.from({ length: count }, next));
}

interface JoinedPayload {
  playerId: string;
  name: string;
  color: string;
}
interface StateViewPayload {
  phase: string;
  quizTitle: string;
  players: Array<{ id: string; name: string; color: string }>;
  scores: Record<string, number>;
  leaderboard: string[];
  currentQuestion: {
    questionIndex: number;
    prompt: string;
    options: string[];
    timeSeconds: number;
    timerDeadline: number;
  } | null;
}
interface RevealPayload {
  questionIndex: number;
  correctIndex: number;
  results: Array<{ playerId: string; answerIndex: number | null; correct: boolean; points: number }>;
}
interface AnswerRejectedPayload {
  reason: string;
}

describe('player join socket contract', () => {
  it('rejects a wrong PIN with joinError bad-pin', async () => {
    const client = open();
    const error = nextEvent<JoinErrorPayload>(client, 'joinError');
    client.emit('join', { pin: '999999', name: 'Tony', color: 'red' });
    await expect(error).resolves.toEqual({ reason: 'bad-pin' });
  });

  it('rejects a bad nickname with joinError bad-name', async () => {
    const client = open();
    const error = nextEvent<JoinErrorPayload>(client, 'joinError');
    client.emit('join', { pin: SESSION_PIN, name: '', color: 'red' });
    await expect(error).resolves.toEqual({ reason: 'bad-name' });
  });

  it('accepts a valid join: joined with the id + final name, then broadcast state', async () => {
    const client = open();
    const joined = nextEvent<JoinedPayload>(client, 'joined');
    const state = nextEvent<StateViewPayload>(client, 'state');
    client.emit('join', { pin: SESSION_PIN, name: 'Tony', color: 'red' });

    const joinedPayload = await joined;
    expect(joinedPayload.name).toBe('Tony');
    expect(joinedPayload.playerId).toMatch(/[0-9a-f-]{36}/i);
    const statePayload = await state;
    expect(statePayload.phase).toBe('lobby');
    expect(statePayload.quizTitle).toBe('Test quiz');
    expect(statePayload.players).toEqual([
      { id: joinedPayload.playerId, name: 'Tony', color: 'red' },
    ]);
  });

  it('rejects a duplicate nickname with joinError nameTaken (no auto-suffixing)', async () => {
    const first = open();
    const joinedFirst = nextEvent<JoinedPayload>(first, 'joined');
    first.emit('join', { pin: SESSION_PIN, name: 'Sofie', color: 'blue' });
    await joinedFirst;

    const second = open();
    const error = nextEvent<JoinErrorPayload>(second, 'joinError');
    second.emit('join', { pin: SESSION_PIN, name: 'Sofie', color: 'green' });
    await expect(error).resolves.toEqual({ reason: 'nameTaken' });
  });

  it('allows a duplicate COLOR but rejects an unknown color with colorRejected', async () => {
    const first = open();
    const joinedFirst = nextEvent<JoinedPayload>(first, 'joined');
    first.emit('join', { pin: SESSION_PIN, name: 'Ada', color: 'blue' });
    const firstJoined = await joinedFirst;

    // Same color as Ada: fine.
    const second = open();
    const joinedSecond = nextEvent<JoinedPayload>(second, 'joined');
    second.emit('join', { pin: SESSION_PIN, name: 'Bob', color: 'blue' });
    const secondJoined = await joinedSecond;
    expect(secondJoined.color).toBe('blue');
    expect(firstJoined.color).toBe('blue');

    // Unknown/missing color: rejected.
    const third = open();
    const error = nextEvent<JoinErrorPayload>(third, 'joinError');
    third.emit('join', { pin: SESSION_PIN, name: 'Cara', color: 'magenta' });
    await expect(error).resolves.toEqual({ reason: 'colorRejected' });

    const fourth = open();
    const error4 = nextEvent<JoinErrorPayload>(fourth, 'joinError');
    fourth.emit('join', { pin: SESSION_PIN, name: 'Dee' });
    await expect(error4).resolves.toEqual({ reason: 'colorRejected' });
  });

  it('reconnect resumes the existing player instead of duplicating it', async () => {
    const first = open();
    const joined = nextEvent<JoinedPayload>(first, 'joined');
    first.emit('join', { pin: SESSION_PIN, name: 'Rejoiner', color: 'pink' });
    const { playerId, name } = await joined;

    first.disconnect();

    const resumed = open();
    const rejoined = nextEvent<JoinedPayload>(resumed, 'joined');
    const state = nextEvent<StateViewPayload>(resumed, 'state');
    resumed.emit('join', { pin: SESSION_PIN, name: 'Rejoiner', color: 'pink', playerId });

    await expect(rejoined).resolves.toEqual({ playerId, name, color: 'pink' });
    const statePayload = await state;
    const roster = statePayload.players.filter((p) => p.name.startsWith('Rejoiner'));
    expect(roster).toEqual([{ id: playerId, name, color: 'pink' }]);
  });

  it('resume with a missing/unknown color restores the stored name + color', async () => {
    const first = open();
    const joined = nextEvent<JoinedPayload>(first, 'joined');
    first.emit('join', { pin: SESSION_PIN, name: 'Restorer', color: 'green' });
    const { playerId, name } = await joined;

    first.disconnect();

    const resumed = open();
    const rejoined = nextEvent<JoinedPayload>(resumed, 'joined');
    resumed.emit('join', { pin: SESSION_PIN, name: 'Restorer', color: 'magenta', playerId });

    // Resume wins over the (invalid) client color: the stored one is kept.
    await expect(rejoined).resolves.toEqual({ playerId, name, color: 'green' });
  });

  it('a stale playerId with an unknown color is still colorRejected (fresh join)', async () => {
    const fresh = open();
    const error = nextEvent<JoinErrorPayload>(fresh, 'joinError');
    fresh.emit('join', { pin: SESSION_PIN, name: 'Newbie', color: 'magenta', playerId: 'ghost' });
    await expect(error).resolves.toEqual({ reason: 'colorRejected' });
  });
});

interface JoinErrorPayload {
  reason: string;
}

describe('player leave socket contract', () => {
  it('removes the leaver from the roster and broadcasts the new state', async () => {
    const boot = await bootQuizServer();
    try {
      const p1 = openAt(boot.baseUrl);
      const p2 = openAt(boot.baseUrl);
      // Drain each join's broadcast before leaving rooms for the leave event.
      await joinPlayer(p1, 'Leaver');
      const stayDrain = nextBatch<StateViewPayload>(p2, 'state', 1);
      const { playerId:StayId } = await joinPlayer(p2, 'Stayer');
      await stayDrain;

      // The remaining player must receive exactly one state after the leave:
      // the post-leave broadcast state.
      const postLeave = nextBatch<StateViewPayload>(p2, 'state', 1);
      p1.emit('leave');
      const [after] = await postLeave;
      expect(after.phase).toBe('lobby');
      expect(after.players).toEqual([
        { id: StayId, name: 'Stayer', color: 'orange' },
      ]);
      expect(after.scores).toEqual({});
    } finally {
      await teardownBoot(boot);
    }
  });

  it('ignores leave from a socket that never joined (no broadcast at all)', async () => {
    const boot = await bootQuizServer();
    try {
      const p1 = openAt(boot.baseUrl);
      await joinPlayer(p1, 'Present');
      const ghost = openAt(boot.baseUrl);
      ghost.emit('leave');

      // No playerLeave dispatch -> no broadcastState to anyone.
      let sawState = 0;
      p1.on('state', () => sawState++);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(sawState).toBe(0);
    } finally {
      await teardownBoot(boot);
    }
  });
});

/**
 * Boots an isolated http + socket.io server wired through wireSockets() with
 * its own GameSession, so question-cycle tests never disturb the join tests'
 * shared lobby-phase session.
 */
async function bootQuizServer(
  quiz: Quiz = sampleQuiz,
  resultsDir?: string,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const bootServer = createServer(expressless());
  wireSockets(new Server(bootServer), {
    gameSession: new GameSession(quiz),
    sessionPin: SESSION_PIN,
    ...(resultsDir ? { results: new GameResultsRecorder(resultsDir) } : {}),
    verifySessionToken: (token) => verifySessionToken(token, ADMIN_PASSWORD),
  });
  await new Promise<void>((resolve) => bootServer.listen(0, '127.0.0.1', resolve));
  const { port } = bootServer.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => bootServer.close(() => resolve())),
  };
}

/** Emits `join` on a socket and resolves with the final `joined` payload. */
async function joinPlayer(socket: ClientSocket, name: string): Promise<JoinedPayload> {
  const joined = nextEvent<JoinedPayload>(socket, 'joined');
  socket.emit('join', { pin: SESSION_PIN, name, color: 'orange' });
  return await joined;
}

/** Disconnects every test client, then closes an ad-hoc bootQuizServer. */
async function teardownBoot(boot: { close: () => Promise<void> }): Promise<void> {
  for (const client of clients.splice(0)) client.disconnect();
  await boot.close();
}

describe('question cycle socket contract', () => {
  it('drives a full game: hostStart -> answers -> reveal -> leaderboards -> podium', async () => {
    const boot = await bootQuizServer();
    try {
      const host = openAt(boot.baseUrl, { auth: true });
      host.emit('host');
      const p1 = openAt(boot.baseUrl);
      const p2 = openAt(boot.baseUrl);
      // Drain every broadcast deterministically: attach listeners BEFORE the
      // triggering emit. Each join broadcasts exactly one state.
      const joinStates = nextBatch<StateViewPayload>(host, 'state', 2);
      const w1 = joinPlayer(p1, 'Ada');
      const w2 = joinPlayer(p2, 'Bob');
      const { playerId: id1 } = await w1;
      const { playerId: id2 } = await w2;
      await joinStates;

      const startBatch = nextBatch<StateViewPayload>(host, 'state', 1);
      host.emit('hostStart');
      const [s0] = await startBatch;
      expect(s0.phase).toBe('question');
      const q0 = sampleQuiz.questions[0];
      expect(s0.currentQuestion).toEqual({
        questionIndex: 0,
        prompt: q0.prompt,
        options: q0.options,
        timeSeconds: q0.timeSeconds,
        timerDeadline: expect.any(Number),
      });
      // The server must not leak the correct answer during the question phase.
      expect(JSON.stringify(s0)).not.toContain('correctIndex');

      const answeredBatch = nextBatch<StateViewPayload>(host, 'state', 2);
      p1.emit('answer', { answerIndex: q0.correctIndex });
      p2.emit('answer', { answerIndex: q0.correctIndex });
      const [a1, afterAnswers] = await answeredBatch; // second state = after both answers
      expect(a1.scores[id1]).toBeGreaterThan(0);
      expect(a1.scores[id2]).toBeUndefined();
      expect(afterAnswers.phase).toBe('question');
      expect(afterAnswers.scores[id1]).toBeGreaterThan(0);
      expect(afterAnswers.scores[id2]).toBeGreaterThan(0);

      const revealOnP1 = nextEvent<RevealPayload>(p1, 'reveal');
      const revealBatch = nextBatch<StateViewPayload>(host, 'state', 1);
      host.emit('reveal');
      const reveal = await revealOnP1;
      const [revealState] = await revealBatch;
      expect(reveal.questionIndex).toBe(0);
      expect(reveal.correctIndex).toBe(q0.correctIndex);
      expect(revealState.phase).toBe('reveal');
      expect(reveal.results).toHaveLength(2);
      expect(reveal.results).toEqual(
        expect.arrayContaining([
          { playerId: id1, answerIndex: q0.correctIndex, correct: true, points: expect.any(Number) },
          { playerId: id2, answerIndex: q0.correctIndex, correct: true, points: expect.any(Number) },
        ]),
      );

      const leaderboardBatch = nextBatch<StateViewPayload>(host, 'state', 1);
      host.emit('next');
      const [lb] = await leaderboardBatch;
      expect(lb.phase).toBe('leaderboard');
      expect(lb.currentQuestion).toBeNull();
      expect(lb.leaderboard).toEqual(expect.arrayContaining([id1, id2]));
      expect(lb.leaderboard).toHaveLength(2);

      for (let i = 1; i < sampleQuiz.questions.length; i++) {
        if (i > 1) {
          const betweenLb = nextBatch<StateViewPayload>(host, 'state', 1);
          host.emit('next'); // reveal of question i-1 -> leaderboard
          expect((await betweenLb)[0].phase).toBe('leaderboard');
        }
        const question = sampleQuiz.questions[i];
        const questionBatch = nextBatch<StateViewPayload>(host, 'state', 1);
        host.emit('next'); // leaderboard -> question i
        const [qs] = await questionBatch;
        expect(qs.phase).toBe('question');
        expect(qs.currentQuestion).toEqual({
          questionIndex: i,
          prompt: question.prompt,
          options: question.options,
          timeSeconds: question.timeSeconds,
          timerDeadline: expect.any(Number),
        });

        const answeredBatchN = nextBatch<StateViewPayload>(host, 'state', 2);
        p1.emit('answer', { answerIndex: question.correctIndex });
        p2.emit('answer', { answerIndex: question.correctIndex });
        await answeredBatchN;

        const revealN = nextEvent<RevealPayload>(p1, 'reveal');
        const revealBatchN = nextBatch<StateViewPayload>(host, 'state', 1);
        host.emit('reveal');
        expect((await revealN).correctIndex).toBe(question.correctIndex);
        const [revealStateN] = await revealBatchN;
        expect(revealStateN.phase).toBe('reveal');
      }

      const finalLbBatch = nextBatch<StateViewPayload>(host, 'state', 1);
      host.emit('next'); // reveal of last question -> leaderboard
      const [finalLb] = await finalLbBatch;
      expect(finalLb.phase).toBe('leaderboard');

      const podiumBatch = nextBatch<StateViewPayload>(host, 'state', 1);
      host.emit('next'); // leaderboard -> podium
      const [pod] = await podiumBatch;
      expect(pod.phase).toBe('podium');
      expect(pod.currentQuestion).toBeNull();
      expect(pod.leaderboard).toEqual(expect.arrayContaining([id1, id2]));
    } finally {
      await teardownBoot(boot);
    }
  });

  it('ignores hostStart/reveal/next from sockets that are not the host', async () => {
    const boot = await bootQuizServer();
    try {
      const host = openAt(boot.baseUrl, { auth: true });
      host.emit('host');
      const player = openAt(boot.baseUrl);
      // Drain the join broadcast before spying on the host socket.
      const joinDrain = nextBatch<StateViewPayload>(host, 'state', 1);
      await joinPlayer(player, 'Lone');
      await joinDrain;

      let sawState = 0;
      let sawReveal = 0;
      host.on('state', () => sawState++);
      host.on('reveal', () => sawReveal++);
      player.emit('hostStart');
      player.emit('reveal');
      player.emit('next');
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(sawState).toBe(0);
      expect(sawReveal).toBe(0);
    } finally {
      await teardownBoot(boot);
    }
  });

  it('rejects an answer from a socket that never joined with answerRejected unknown-player', async () => {
    const boot = await bootQuizServer();
    try {
      const ghost = openAt(boot.baseUrl);
      const rejected = nextEvent<AnswerRejectedPayload>(ghost, 'answerRejected');
      ghost.emit('answer', { answerIndex: 0 });
      await expect(rejected).resolves.toEqual({ reason: 'unknown-player' });
    } finally {
      await teardownBoot(boot);
    }
  });

  it('rejects a second answer on the same question with already-answered', async () => {
    const boot = await bootQuizServer();
    try {
      const host = openAt(boot.baseUrl, { auth: true });
      host.emit('host');
      const player = openAt(boot.baseUrl);
      const joinDrain = nextBatch<StateViewPayload>(player, 'state', 1);
      const { playerId } = await joinPlayer(player, 'Capitan');
      await joinDrain;
      const startBatch = nextBatch<StateViewPayload>(player, 'state', 1);
      host.emit('hostStart');
      await startBatch;

      const q0 = sampleQuiz.questions[0];
      const acceptedBatch = nextBatch<StateViewPayload>(player, 'state', 1);
      player.emit('answer', { answerIndex: q0.correctIndex });
      const [accepted] = await acceptedBatch;
      expect(Object.keys(accepted.scores)).toContain(playerId);

      const rejected = nextEvent<AnswerRejectedPayload>(player, 'answerRejected');
      player.emit('answer', { answerIndex: q0.correctIndex });
      await expect(rejected).resolves.toEqual({ reason: 'already-answered' });
    } finally {
      await teardownBoot(boot);
    }
  });

  it('rejects an out-of-range or malformed answer with invalid-answer', async () => {
    const boot = await bootQuizServer();
    try {
      const host = openAt(boot.baseUrl, { auth: true });
      host.emit('host');
      const player = openAt(boot.baseUrl);
      const joinDrain = nextBatch<StateViewPayload>(player, 'state', 1);
      await joinPlayer(player, 'Wildcard');
      await joinDrain;
      const startBatch = nextBatch<StateViewPayload>(player, 'state', 1);
      host.emit('hostStart');
      await startBatch;

      const outOfRange = nextEvent<AnswerRejectedPayload>(player, 'answerRejected');
      player.emit('answer', { answerIndex: 99 });
      await expect(outOfRange).resolves.toEqual({ reason: 'invalid-answer' });

      const malformed = nextEvent<AnswerRejectedPayload>(player, 'answerRejected');
      player.emit('answer', 'not-an-object');
      await expect(malformed).resolves.toEqual({ reason: 'invalid-answer' });
    } finally {
      await teardownBoot(boot);
    }
  });

  it('rejects an answer submitted after the deadline with late', async () => {
    const boot = await bootQuizServer();
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(1_000_000_000_000);
      const host = openAt(boot.baseUrl, { auth: true });
      host.emit('host');
      const player = openAt(boot.baseUrl);
      const joinDrain = nextBatch<StateViewPayload>(player, 'state', 1);
      await joinPlayer(player, 'Slowpoke');
      await joinDrain;
      const startBatch = nextBatch<StateViewPayload>(player, 'state', 1);
      host.emit('hostStart');
      const [started] = await startBatch;

      const q0 = sampleQuiz.questions[0];
      expect(started.currentQuestion).not.toBeNull();
      const deadline = started.currentQuestion!.timerDeadline; // deadline straight off the wire
      vi.setSystemTime(deadline + 1);

      const rejected = nextEvent<AnswerRejectedPayload>(player, 'answerRejected');
      player.emit('answer', { answerIndex: q0.correctIndex });
      await expect(rejected).resolves.toEqual({ reason: 'late' });
    } finally {
      vi.useRealTimers();
      await teardownBoot(boot);
    }
  });

  it('tells a rejoining player mid-question whether they already answered (resumeAnswerStatus)', async () => {
    const boot = await bootQuizServer();
    try {
      const host = openAt(boot.baseUrl, { auth: true });
      host.emit('host');
      const player = openAt(boot.baseUrl);
      const joinDrain = nextBatch<StateViewPayload>(host, 'state', 1);
      const { playerId, name } = await joinPlayer(player, 'Returnee');
      await joinDrain;

      const startBatch = nextBatch<StateViewPayload>(host, 'state', 1);
      host.emit('hostStart');
      await startBatch;

      // Answer question 0, then drop the connection (page refresh).
      const answeredBatch = nextBatch<StateViewPayload>(host, 'state', 1);
      player.emit('answer', { answerIndex: sampleQuiz.questions[0]!.correctIndex });
      await answeredBatch;
      player.disconnect();
      await delay(50);

      // Reconnect with the SAME identity: joined, then resumeAnswerStatus
      // (question is still live), then state.
      const resumed = openAt(boot.baseUrl);
      const resumedJoined = nextEvent<JoinedPayload>(resumed, 'joined');
      const resumeStatus = nextEvent<{ questionIndex: number; alreadyAnswered: boolean }>(
        resumed,
        'resumeAnswerStatus',
      );
      resumed.emit('join', { pin: SESSION_PIN, name, color: 'orange', playerId });
      await resumedJoined;
      await expect(resumeStatus).resolves.toEqual({ questionIndex: 0, alreadyAnswered: true });
    } finally {
      await teardownBoot(boot);
    }
  });
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ONE_ROUND_QUIZ: Quiz = {
  title: 'Finish Test',
  questions: [
    {
      prompt: '1+1?',
      type: 'multiple-choice',
      timeSeconds: 10,
      options: ['2', '3'],
      correctIndex: 0,
    },
  ],
};

/** Plays one question round to the podium; the player answers `correctIndex`. */
async function playRoundToPodium(
  host: ClientSocket,
  player: ClientSocket,
  correctIndex: number,
): Promise<void> {
  const startBatch = nextBatch<StateViewPayload>(host, 'state', 1);
  host.emit('hostStart');
  const [questionState] = await startBatch;
  expect(questionState.currentQuestion).not.toBeNull();

  const answeredBatch = nextBatch<StateViewPayload>(player, 'state', 1);
  player.emit('answer', { answerIndex: correctIndex });
  const [answered] = await answeredBatch;
  expect(answered.phase).toBe('question');

  const revealDrain = nextEvent<RevealPayload>(player, 'reveal');
  const revealStateBatch = nextBatch<StateViewPayload>(host, 'state', 1);
  host.emit('reveal');
  await revealDrain;
  await revealStateBatch;

  const leaderboardBatch = nextBatch<StateViewPayload>(host, 'state', 1);
  host.emit('next');
  expect((await leaderboardBatch)[0].phase).toBe('leaderboard');

  const podiumBatch = nextBatch<StateViewPayload>(host, 'state', 1);
  host.emit('next'); // final leaderboard -> podium
  expect((await podiumBatch)[0].phase).toBe('podium');
}

describe('finish game: saved results + back to lobby', () => {
  it('endGame after a podium returns the lobby (players kept, scores cleared) and saves one results file per game', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'kahoot-endgame-'));
    const resultsDir = path.join(tmpRoot, 'results');
    const boot = await bootQuizServer(ONE_ROUND_QUIZ, resultsDir);
    try {
      const host = openAt(boot.baseUrl, { auth: true });
      host.emit('host');
      const player = openAt(boot.baseUrl);
      const joinDrain = nextBatch<StateViewPayload>(host, 'state', 1);
      const { playerId } = await joinPlayer(player, 'Iris');
      await joinDrain;

      // Game 1: correct answer -> podium saves the results file.
      await playRoundToPodium(host, player, ONE_ROUND_QUIZ.questions[0]!.correctIndex);
      await delay(100); // let the async save flush
      const files1 = await readdir(resultsDir);
      expect(files1).toHaveLength(1);
      const first = JSON.parse(await readFile(path.join(resultsDir, files1[0]!), 'utf8'));
      expect(first.quizTitle).toBe('Finish Test');
      expect(first.players).toEqual([{ id: playerId, name: 'Iris' }]);
      expect(first.finalScores[playerId]).toBeGreaterThan(0);
      expect(first.questions).toHaveLength(1);
      expect(first.questions[0].correctIndex).toBe(ONE_ROUND_QUIZ.questions[0].correctIndex);
      expect(first.questions[0].prompt).toBe('1+1?');
      expect(first.questions[0].answers).toEqual([
        {
          playerId,
          name: 'Iris',
          answerIndex: ONE_ROUND_QUIZ.questions[0].correctIndex,
          correct: true,
          points: first.finalScores[playerId],
        },
      ]);

      // Host presses "Back to lobby": phase lobby, roster kept, scores cleared.
      const lobbyBatch = nextBatch<StateViewPayload>(host, 'state', 1);
      host.emit('endGame');
      const [lobby] = await lobbyBatch;
      expect(lobby.phase).toBe('lobby');
      expect(lobby.players).toEqual([{ id: playerId, name: 'Iris', color: 'orange' }]);
      expect(lobby.scores).toEqual({});
      expect(lobby.currentQuestion).toBeNull();

      // A second endGame in the lobby is a no-op (engine ignores `end` there).
      let extraStates = 0;
      host.on('state', () => extraStates++);
      host.emit('endGame');
      await delay(100);
      expect(extraStates).toBe(0);

      // Game 2 from the same lobby: accumulation resets, results save again
      // under a fresh filename (a -2 suffix only if the same minute repeats).
      // Answer wrong this time so the two saved records are distinguishable.
      await playRoundToPodium(host, player, 1); // 1 is the wrong option
      await delay(100);
      const files2 = await readdir(resultsDir);
      expect(files2).toHaveLength(2);
      const records = await Promise.all(
        files2.map(async (name) => JSON.parse(await readFile(path.join(resultsDir, name), 'utf8'))),
      );
      // Game 1 (correct answer) and game 2 (wrong answer here) both persisted.
      expect(records.map((r) => r.questions[0].answers[0].correct).sort()).toEqual([
        false,
        true,
      ]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
      await teardownBoot(boot);
    }
  });

  it('syncs state and reveal to reconnecting host and player during a live game', async () => {
    const boot = await bootQuizServer();
    try {
      const host = openAt(boot.baseUrl, { auth: true });
      host.emit('host');
      const player = openAt(boot.baseUrl);
      const joinWait = nextBatch<StateViewPayload>(host, 'state', 1);
      const { playerId } = await joinPlayer(player, 'SyncTest');
      await joinWait;

      // Start quiz
      const startBatch = nextBatch<StateViewPayload>(host, 'state', 1);
      host.emit('hostStart');
      await startBatch;

      // Host reconnects during question phase: emits 'host', receives state immediately
      const host2 = openAt(boot.baseUrl, { auth: true });
      const host2StateBatch = nextBatch<StateViewPayload>(host2, 'state', 1);
      host2.emit('host');
      const [host2State] = await host2StateBatch;
      expect(host2State.phase).toBe('question');
      expect(host2State.currentQuestion?.prompt).toBe(sampleQuiz.questions[0]!.prompt);

      // Reveal answer
      const revealOnP = nextEvent<RevealPayload>(player, 'reveal');
      const revealBatch = nextBatch<StateViewPayload>(host2, 'state', 1);
      host2.emit('reveal');
      await revealOnP;
      await revealBatch;

      // Host reconnects during reveal phase: receives state AND reveal
      const host3 = openAt(boot.baseUrl, { auth: true });
      const host3StateBatch = nextBatch<StateViewPayload>(host3, 'state', 1);
      const host3RevealWait = nextEvent<RevealPayload>(host3, 'reveal');
      host3.emit('host');
      const [host3State] = await host3StateBatch;
      const host3Reveal = await host3RevealWait;
      expect(host3State.phase).toBe('reveal');
      expect(host3Reveal.correctIndex).toBe(sampleQuiz.questions[0]!.correctIndex);

      // Player reconnects during reveal phase: receives state AND reveal
      const player2 = openAt(boot.baseUrl);
      const p2StateBatch = nextBatch<StateViewPayload>(player2, 'state', 1);
      const p2RevealWait = nextEvent<RevealPayload>(player2, 'reveal');
      player2.emit('join', { pin: SESSION_PIN, name: 'SyncTest', color: 'orange', playerId });
      const [p2State] = await p2StateBatch;
      const p2Reveal = await p2RevealWait;
      expect(p2State.phase).toBe('reveal');
      expect(p2Reveal.correctIndex).toBe(sampleQuiz.questions[0]!.correctIndex);
    } finally {
      await teardownBoot(boot);
    }
  });
});

describe('host authentication gate (issue 03)', () => {
  it('an anonymous socket cannot claim host, so hostStart/reveal/next endGame do nothing', async () => {
    const boot = await bootQuizServer();
    try {
      // The spoof: exactly what a malicious /play visitor could emit.
      const anon = openAt(boot.baseUrl);
      const anonStates: StateViewPayload[] = [];
      anon.on('state', (s: StateViewPayload) => anonStates.push(s));
      const anonReveals: RevealPayload[] = [];
      anon.on('reveal', (r: RevealPayload) => anonReveals.push(r));
      anon.emit('host');
      anon.emit('hostStart'); // would have started the quiz before the gate
      anon.emit('reveal');
      anon.emit('next');
      anon.emit('endGame');

      // Owner socket (just to drain and compare): nothing was broadcast at all.
      const spectator = openAt(boot.baseUrl, { auth: true });
      let spectatorEvents = 0;
      spectator.onAny(() => spectatorEvents++);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(anonStates).toEqual([]);
      expect(anonReveals).toEqual([]);
      expect(spectatorEvents).toBe(0);
    } finally {
      await teardownBoot(boot);
    }
  });

  it('a garbage session cookie is treated as anonymous (host claims rejected)', async () => {
    const boot = await bootQuizServer();
    try {
      const forged = connect(boot.baseUrl, {
        transports: ['websocket'],
        extraHeaders: { Cookie: `${SESSION_COOKIE_NAME}=123456.signature-from-elsewhere` },
      });
      clients.push(forged);
      const states: StateViewPayload[] = [];
      forged.on('state', (s: StateViewPayload) => states.push(s));
      forged.emit('host');
      forged.emit('hostStart');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(states).toEqual([]);
    } finally {
      await teardownBoot(boot);
    }
  });

  it('an authenticated socket CAN host the full lobby -> start flow', async () => {
    const boot = await bootQuizServer();
    try {
      const host = openAt(boot.baseUrl, { auth: true });
      host.emit('host');
      // The player joins anonymously, exactly as from /play.
      const player = openAt(boot.baseUrl);
      const joinDrain = nextBatch<StateViewPayload>(host, 'state', 1);
      const { playerId } = await joinPlayer(player, 'Legit');
      await joinDrain;

      const startBatch = nextBatch<StateViewPayload>(host, 'state', 1);
      host.emit('hostStart');
      const [started] = await startBatch;
      expect(started.phase).toBe('question');
      expect(started.currentQuestion?.prompt).toBe(sampleQuiz.questions[0].prompt);
      expect(started.players).toEqual([
        { id: playerId, name: 'Legit', color: 'orange' },
      ]);
    } finally {
      await teardownBoot(boot);
    }
  });
});
