// Unit tests for game results: the pure seams (resultsFilename / buildResults)
// fed with worked examples, the thin node:fs/promises writer against a
// throwaway temp dir, and the once-per-game save guard in GameResultsRecorder.

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInitialGame,
  reduce,
  type GameState,
  type Quiz,
  type Reveal,
} from './engine.js';
import { GameResultsRecorder, buildResults, resultsFilename, saveResultsFile } from './results.js';

const quiz: Quiz = {
  title: 'Game Night',
  questions: [
    {
      prompt: 'Which planet is known as the Red Planet?',
      type: 'multiple-choice',
      timeSeconds: 10,
      options: ['Venus', 'Mars'],
      correctIndex: 1,
    },
    {
      prompt: 'Paris is the capital of France.',
      type: 'true-false',
      timeSeconds: 10,
      options: ['True', 'False'],
      correctIndex: 0,
    },
  ],
};

/**
 * Drives the engine through a real game so buildResults() is fed with the
 * exact Reveal payloads the engine broadcasts (never hand-invented ones).
 */
function playGameForResults(): { state: GameState; reveals: Reveal[] } {
  let session = createInitialGame(quiz);
  const reveals: Reveal[] = [];
  const apply = (event: Parameters<typeof reduce>[1]) => {
    const { state: next, effects } = reduce(session, event);
    session = next;
    for (const effect of effects) {
      if (effect.type === 'broadcastReveal') reveals.push(effect.reveal);
    }
  };

  apply({ type: 'playerJoin', playerId: 'p1', name: 'Ada', atMs: 1000 });
  apply({ type: 'playerJoin', playerId: 'p2', name: 'Bob', atMs: 2000 });
  apply({ type: 'startQuiz', atMs: 10_000 });
  // Q0: Ada answers correct at halfway -> round(1000 * 5000 / 10000) = 500.
  apply({ type: 'playerAnswer', playerId: 'p1', answerIndex: 1, atMs: 15_000 });
  apply({ type: 'reveal' });
  apply({ type: 'next', atMs: 20_000 }); // -> leaderboard
  apply({ type: 'next', atMs: 21_000 }); // -> question 1
  // Q1: only Bob answers, and he is wrong.
  apply({ type: 'playerAnswer', playerId: 'p2', answerIndex: 1, atMs: 22_000 });
  apply({ type: 'reveal' });
  apply({ type: 'next', atMs: 25_000 }); // -> leaderboard
  apply({ type: 'next', atMs: 26_000 }); // -> podium
  return { state: session, reveals };
}

describe('resultsFilename', () => {
  it('renders UTC date and minutes: 2024-05-01T13:45:30Z -> 2024-05-01_1345.json', () => {
    expect(resultsFilename(Date.UTC(2024, 4, 1, 13, 45, 30))).toBe('2024-05-01_1345.json');
  });

  it('zero-pads single-digit month, day, hour and minute values', () => {
    expect(resultsFilename(Date.UTC(2025, 0, 5, 2, 7))).toBe('2025-01-05_0207.json');
  });

  it('drops seconds entirely (whole-minute buckets)', () => {
    expect(resultsFilename(Date.UTC(1999, 11, 31, 23, 59, 59))).toBe('1999-12-31_2359.json');
  });
});

describe('buildResults', () => {
  it('projects a full game into the results record shape', () => {
    const { state, reveals } = playGameForResults();
    const endedAtMs = Date.UTC(2024, 4, 1, 14, 0);

    expect(buildResults(state, reveals, endedAtMs)).toEqual({
      quizTitle: 'Game Night',
      endedAt: '2024-05-01T14:00:00.000Z',
      players: [
        { id: 'p1', name: 'Ada' },
        { id: 'p2', name: 'Bob' },
      ],
      finalScores: { p1: 500, p2: 0 },
      questions: [
        {
          prompt: 'Which planet is known as the Red Planet?',
          correctIndex: 1,
          answers: [
            { playerId: 'p1', name: 'Ada', answerIndex: 1, correct: true, points: 500 },
            { playerId: 'p2', name: 'Bob', answerIndex: null, correct: false, points: 0 },
          ],
        },
        {
          prompt: 'Paris is the capital of France.',
          correctIndex: 0,
          answers: [
            { playerId: 'p1', name: 'Ada', answerIndex: null, correct: false, points: 0 },
            { playerId: 'p2', name: 'Bob', answerIndex: 1, correct: false, points: 0 },
          ],
        },
      ],
    });
  });

  it('orders questions by questionIndex even when reveals arrive out of order', () => {
    const state = { ...createInitialGame(quiz), phase: 'podium' } as GameState;
    const second: Reveal = {
      questionIndex: 1,
      correctIndex: 0,
      results: [],
    };
    const first: Reveal = {
      questionIndex: 0,
      correctIndex: 1,
      results: [],
    };
    expect(
      buildResults(state, [second, first], Date.UTC(2024, 4, 1, 14, 0)).questions.map(
        (q) => q.prompt,
      ),
    ).toEqual(['Which planet is known as the Red Planet?', 'Paris is the capital of France.']);
  });
});

describe('saveResultsFile', () => {
  let tmpRoot = '';

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'kahoot-results-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('never overwrites: a second save in the same minute gets a -2 suffix', async () => {
    const dir = path.join(tmpRoot, 'results');
    const results = {
      quizTitle: 'Game Night',
      endedAt: '2024-05-01T14:00:00.000Z',
      players: [],
      finalScores: {},
      questions: [],
    };
    await saveResultsFile(dir, { ...results, quizTitle: 'First game' });
    await saveResultsFile(dir, { ...results, quizTitle: 'Second game' });

    expect((await readdir(dir)).sort()).toEqual(['2024-05-01_1400-2.json', '2024-05-01_1400.json']);
    expect(
      JSON.parse(await readFile(path.join(dir, '2024-05-01_1400.json'), 'utf8')).quizTitle,
    ).toBe('First game');
  });

  it('creates the directory if needed and writes the formatted record under the timestamped name', async () => {
    const dir = path.join(tmpRoot, 'results');
    const results = {
      quizTitle: 'Game Night',
      endedAt: '2024-05-01T14:00:00.000Z',
      players: [{ id: 'p1', name: 'Ada' }],
      finalScores: { p1: 500 },
      questions: [],
    };
    await saveResultsFile(dir, results);

    expect(await readdir(dir)).toEqual(['2024-05-01_1400.json']);
    const readBack = JSON.parse(
      await readFile(path.join(dir, '2024-05-01_1400.json'), 'utf8'),
    );
    expect(readBack).toEqual(results);
    // Human-readable formatting, not single-line minified JSON.
    expect(await readFile(path.join(dir, '2024-05-01_1400.json'), 'utf8')).toContain('\n');
  });
});

describe('GameResultsRecorder', () => {
  let tmpRoot = '';
  let dir = '';

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'kahoot-recorder-'));
    dir = path.join(tmpRoot, 'results');
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  const questionStartState = (): GameState => ({
    ...createInitialGame(quiz),
    phase: 'question',
    questionIndex: 0,
    timerDeadline: 30_000,
  });

  const podiumState = playGameForResults().state;

  const reveal: Reveal = {
    questionIndex: 0,
    correctIndex: 1,
    results: [{ playerId: 'p1', answerIndex: 1, correct: true, points: 500 }],
  };

  it('saves exactly once: podium state saves, later endGame from the same game does not', async () => {
    const recorder = new GameResultsRecorder(dir, () => undefined);
    recorder.onState(questionStartState());
    recorder.addReveal(reveal);
    await recorder.onState(podiumState);
    await recorder.endGame(podiumState); // host presses "Back to lobby" after the podium

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const saved = JSON.parse(await readFile(path.join(dir, files[0]), 'utf8'));
    expect(saved.quizTitle).toBe('Game Night');
    expect(saved.questions).toHaveLength(1);
  });

  it('endGame alone (game cut short) saves once with the scores still present', async () => {
    const recorder = new GameResultsRecorder(dir, () => undefined);
    recorder.onState(questionStartState());
    recorder.addReveal(reveal);
    await recorder.endGame(podiumState);

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const saved = JSON.parse(await readFile(path.join(dir, files[0]), 'utf8'));
    expect(saved.finalScores).toEqual({ p1: 500, p2: 0 });
  });

  it('resets accumulation when a new game starts, so the second game saves its own file', async () => {
    const recorder = new GameResultsRecorder(dir, () => undefined);
    recorder.onState(questionStartState());
    recorder.addReveal(reveal);
    await recorder.onState(podiumState); // game 1 saved
    recorder.onState(questionStartState()); // game 2 starts
    recorder.addReveal({
      questionIndex: 0,
      correctIndex: 1,
      results: [{ playerId: 'p1', answerIndex: 0, correct: false, points: 0 }],
    });
    await recorder.onState(podiumState); // game 2 saved with its own reveal

    const files = await readdir(dir);
    expect(files).toHaveLength(2);
    const second = JSON.parse(
      await readFile(path.join(dir, files.find((f) => f.endsWith('-2.json'))!), 'utf8'),
    );
    expect(second.questions[0].answers[0].answerIndex).toBe(0);
  });

  it('ignores non-completion states and never writes a file for them', async () => {
    const recorder = new GameResultsRecorder(dir, () => undefined);
    recorder.onState(questionStartState());
    recorder.addReveal(reveal);
    recorder.onState({ ...createInitialGame(quiz), phase: 'leaderboard' });
    expect(await readdir(tmpRoot)).toEqual([]);
  });
});
