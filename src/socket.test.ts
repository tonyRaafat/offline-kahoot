// Socket-level smoke test: boots a minimal http.Server + socket.io with the
// real wireSockets() wiring and drives the join contract end to end —
// joinError on a bad PIN, `joined`+`state` on a valid join, duplicate-name
// suffixing across the wire, and reconnect resuming the same player — then a
// full question cycle: hostStart, answers, reveal, leaderboards, podium.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { GameSession } from './game-session.js';
import { wireSockets } from './socket.js';
import { sampleQuiz } from './sample-quiz.js';

const SESSION_PIN = '123456';
let httpServer: HttpServer | undefined;
let baseUrl = '';

const clients: ClientSocket[] = [];

beforeAll(async () => {
  const app = expressless();
  httpServer = createServer(app);
  wireSockets(new Server(httpServer), {
    gameSession: new GameSession({ title: 'Test quiz', questions: [] }),
    sessionPin: SESSION_PIN,
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

/** Connects a fresh client socket and waits for the initial connection. */
function open(): ClientSocket {
  return openAt(baseUrl);
}

/** Same as open() but pointed at an ad-hoc server from bootQuizServer(). */
function openAt(url: string): ClientSocket {
  const client = connect(url, { transports: ['websocket'] });
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
}
interface StateViewPayload {
  phase: string;
  quizTitle: string;
  players: Array<{ id: string; name: string }>;
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
    client.emit('join', { pin: '999999', name: 'Tony' });
    await expect(error).resolves.toEqual({ reason: 'bad-pin' });
  });

  it('rejects a bad nickname with joinError bad-name', async () => {
    const client = open();
    const error = nextEvent<JoinErrorPayload>(client, 'joinError');
    client.emit('join', { pin: SESSION_PIN, name: '' });
    await expect(error).resolves.toEqual({ reason: 'bad-name' });
  });

  it('accepts a valid join: joined with the id + final name, then broadcast state', async () => {
    const client = open();
    const joined = nextEvent<JoinedPayload>(client, 'joined');
    const state = nextEvent<StateViewPayload>(client, 'state');
    client.emit('join', { pin: SESSION_PIN, name: 'Tony' });

    const joinedPayload = await joined;
    expect(joinedPayload.name).toBe('Tony');
    expect(joinedPayload.playerId).toMatch(/[0-9a-f-]{36}/i);
    const statePayload = await state;
    expect(statePayload.phase).toBe('lobby');
    expect(statePayload.quizTitle).toBe('Test quiz');
    expect(statePayload.players).toEqual([
      { id: joinedPayload.playerId, name: 'Tony' },
    ]);
  });

  it('auto-suffixes duplicate nicknames on the wire (Tony -> Tony-2)', async () => {
    const first = open();
    const joinedFirst = nextEvent<JoinedPayload>(first, 'joined');
    first.emit('join', { pin: SESSION_PIN, name: 'Sofie' });
    await joinedFirst;

    const second = open();
    const joinedSecond = nextEvent<JoinedPayload>(second, 'joined');
    second.emit('join', { pin: SESSION_PIN, name: 'Sofie' });
    await expect(joinedSecond).resolves.toMatchObject({ name: 'Sofie-2' });
  });

  it('reconnect resumes the existing player instead of duplicating it', async () => {
    const first = open();
    const joined = nextEvent<JoinedPayload>(first, 'joined');
    first.emit('join', { pin: SESSION_PIN, name: 'Rejoiner' });
    const { playerId, name } = await joined;

    first.disconnect();

    const resumed = open();
    const rejoined = nextEvent<JoinedPayload>(resumed, 'joined');
    const state = nextEvent<StateViewPayload>(resumed, 'state');
    resumed.emit('join', { pin: SESSION_PIN, name: 'Rejoiner', playerId });

    await expect(rejoined).resolves.toEqual({ playerId, name });
    const statePayload = await state;
    const roster = statePayload.players.filter((p) => p.name.startsWith('Rejoiner'));
    expect(roster).toEqual([{ id: playerId, name }]);
  });
});

interface JoinErrorPayload {
  reason: string;
}

/**
 * Boots an isolated http + socket.io server wired through wireSockets() with
 * its own GameSession, so question-cycle tests never disturb the join tests'
 * shared lobby-phase session.
 */
async function bootQuizServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const bootServer = createServer(expressless());
  wireSockets(new Server(bootServer), {
    gameSession: new GameSession(sampleQuiz),
    sessionPin: SESSION_PIN,
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
  socket.emit('join', { pin: SESSION_PIN, name });
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
      const host = openAt(boot.baseUrl);
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
      const host = openAt(boot.baseUrl);
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
      const host = openAt(boot.baseUrl);
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
      const host = openAt(boot.baseUrl);
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
      const host = openAt(boot.baseUrl);
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
});
