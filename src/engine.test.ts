import { describe, expect, it } from 'vitest';
import {
  createInitialGame,
  reduce,
  type GameState,
  type Quiz,
} from './engine.js';

// Worked example fixtures. All expected values below are hand-computed literals,
// never derived from the engine's own math.

const QUIZ: Quiz = {
  title: 'Demo Quiz',
  questions: [
    {
      prompt: 'Which is the largest planet?',
      type: 'multiple-choice',
      timeSeconds: 10,
      options: ['Mars', 'Jupiter', 'Earth', 'Venus'],
      correctIndex: 1,
    },
    {
      prompt: 'The sun is a star.',
      type: 'true-false',
      timeSeconds: 20,
      options: ['True', 'False'],
      correctIndex: 0,
    },
  ],
};

// 3s question -> totalMs = 3000. Answer 2255ms in leaves 745ms:
// round(1000 * 745 / 3000) = round(248.33) = 248.
const QUICK_MATHS: Quiz = {
  title: 'Rounding',
  questions: [
    {
      prompt: '2 + 2 = ?',
      type: 'multiple-choice',
      timeSeconds: 3,
      options: ['3', '4'],
      correctIndex: 1,
    },
  ],
};

const START_AT = 1_000_000;
const Q1_DEADLINE = 1_010_000; // 1_000_000 + 10 * 1000
const Q2_DEADLINE = 1_032_000; // next atMs 1_012_000 + 20 * 1000

function lobbyWith(
  quiz: Quiz,
  roster: Array<[playerId: string, name: string, color?: import('./avatar-colors.js').AvatarColor]>,
): GameState {
  let state = createInitialGame(quiz);
  let atMs = START_AT;
  for (const [playerId, name, color = 'red'] of roster) {
    state = reduce(state, { type: 'playerJoin', playerId, name, color, atMs }).state;
    atMs += 1000;
  }
  return state;
}

function start(state: GameState, atMs = START_AT): GameState {
  return reduce(state, { type: 'startQuiz', atMs }).state;
}

describe('createInitialGame', () => {
  it('starts in the lobby with no players, scores, or timer', () => {
    expect(createInitialGame(QUIZ)).toEqual({
      phase: 'lobby',
      quiz: QUIZ,
      players: [],
      scores: {},
      questionIndex: -1,
      timerDeadline: null,
      answers: {},
      firstCorrectAtMs: {},
      leaderboard: [],
    });
  });
});

describe('playerJoin', () => {
  it('adds a player with the given nickname, color and join timestamp', () => {
    const state = lobbyWith(QUIZ, [
      ['p1', 'Alice', 'blue'],
      ['p2', 'Bob', 'yellow'],
    ]);
    expect(state.players).toEqual([
      { id: 'p1', name: 'Alice', color: 'blue', joinedAtMs: 1_000_000 },
      { id: 'p2', name: 'Bob', color: 'yellow', joinedAtMs: 1_001_000 },
    ]);
  });

  it('records a duplicate-looking nickname verbatim (uniqueness is enforced at the socket layer, NOT auto-suffixed here)', () => {
    const state = lobbyWith(QUIZ, [
      ['p1', 'Tony', 'red'],
      ['p2', 'Tony', 'grey'],
    ]);
    expect(state.players.map((p) => ({ name: p.name, color: p.color }))).toEqual([
      { name: 'Tony', color: 'red' },
      { name: 'Tony', color: 'grey' },
    ]);
  });

  it('ignores joins once the quiz has started', () => {
    let state = start(lobbyWith(QUIZ, [['p1', 'Alice', 'green']]));
    const before = state;
    const { state: after, effects } = reduce(state, {
      type: 'playerJoin',
      playerId: 'p2',
      name: 'Late Larry',
      color: 'pink',
      atMs: 1_002_000,
    });
    state = after;
    expect(state.players.map((p) => p.id)).toEqual(['p1']);
    expect(state).toEqual(before);
    expect(effects).toEqual([]);
  });

  it('keeps the stored color through later dispatches and the final roster wipe of scores', () => {
    // Color persists across the whole game: startQuiz doesn't rebuild players,
    // and `end` returns to the lobby keeping the roster (name + color intact).
    let state = lobbyWith(QUIZ, [['p1', 'Ada', 'orange']]);
    state = start(state, START_AT);
    expect(state.players[0]).toEqual({
      id: 'p1',
      name: 'Ada',
      color: 'orange',
      joinedAtMs: 1_000_000,
    });
    state = reduce(state, { type: 'end' }).state;
    expect(state.players[0]?.color).toBe('orange');
  });
});

describe('startQuiz', () => {
  it('moves lobby -> question 0 and sets the timer deadline', () => {
    const state = lobbyWith(QUIZ, [
      ['p1', 'Alice'],
      ['p2', 'Bob'],
    ]);
    const { state: after, effects } = reduce(state, {
      type: 'startQuiz',
      atMs: START_AT,
    });
    expect(after.phase).toBe('question');
    expect(after.questionIndex).toBe(0);
    expect(after.timerDeadline).toBe(Q1_DEADLINE);
    expect(after.answers).toEqual({});
    expect(effects).toEqual([{ type: 'broadcastState', state: after }]);
  });

  it('ignores startQuiz with no players', () => {
    const { state: after, effects } = reduce(createInitialGame(QUIZ), {
      type: 'startQuiz',
      atMs: START_AT,
    });
    expect(after.phase).toBe('lobby');
    expect(effects).toEqual([]);
  });
});

describe('playerAnswer', () => {
  it('scores a correct answer round(1000 x remainingMs / totalMs)', () => {
    // Answered 2000ms into a 10000ms question: round(1000 * 8000 / 10000) = 800.
    const state = start(lobbyWith(QUIZ, [['p1', 'Alice']]));
    const { state: after, effects } = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 1,
      atMs: 1_002_000,
    });
    expect(after.scores).toEqual({ p1: 800 });
    expect(after.answers).toEqual({
      p1: { answerIndex: 1, atMs: 1_002_000, correct: true, points: 800 },
    });
    expect(effects).toEqual([{ type: 'broadcastState', state: after }]);
  });

  it('scores a full-time instant answer as 1000 (boundary)', () => {
    // Answered at the exact start: remainingMs == totalMs -> round(1000 * 10000/10000) = 1000.
    const state = start(lobbyWith(QUIZ, [['p1', 'Alice']]));
    const { state: after } = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 1,
      atMs: START_AT,
    });
    expect(after.scores).toEqual({ p1: 1000 });
    expect(after.answers).toEqual({
      p1: { answerIndex: 1, atMs: START_AT, correct: true, points: 1000 },
    });
  });

  it('rounds fractional scores (worked example: 248)', () => {
    const state = start(lobbyWith(QUICK_MATHS, [['p1', 'Ann']]));
    const { state: after } = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 1,
      atMs: 1_002_255,
    });
    expect(after.scores).toEqual({ p1: 248 });
  });

  it('gives 0 points for a wrong answer and applies no penalty', () => {
    const state = start(lobbyWith(QUIZ, [['p1', 'Alice']]));
    const { state: after } = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 0,
      atMs: 1_002_000,
    });
    expect(after.scores).toEqual({ p1: 0 });
    expect(after.answers).toEqual({
      p1: { answerIndex: 0, atMs: 1_002_000, correct: false, points: 0 },
    });
  });

  it('accepts an answer submitted exactly at the deadline with 0 points', () => {
    const state = start(lobbyWith(QUIZ, [['p1', 'Alice']]));
    const { state: after } = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 1,
      atMs: Q1_DEADLINE,
    });
    expect(after.answers['p1']).toEqual({
      answerIndex: 1,
      atMs: Q1_DEADLINE,
      correct: true,
      points: 0,
    });
  });

  it('rejects answers submitted after the deadline', () => {
    const state = start(lobbyWith(QUIZ, [['p1', 'Alice']]));
    const { state: after, effects } = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 1,
      atMs: Q1_DEADLINE + 1,
    });
    expect(after.answers).toEqual({});
    expect(after.scores).toEqual({});
    expect(effects).toEqual([
      { type: 'answerRejected', playerId: 'p1', reason: 'late' },
    ]);
  });

  it('rejects a second answer from the same player within one question', () => {
    const state = start(lobbyWith(QUIZ, [['p1', 'Alice']]));
    const afterFirst = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 1,
      atMs: 1_002_000,
    }).state;
    const { state: after, effects } = reduce(afterFirst, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 0,
      atMs: 1_003_000,
    });
    expect(after).toEqual(afterFirst);
    expect(effects).toEqual([
      { type: 'answerRejected', playerId: 'p1', reason: 'already-answered' },
    ]);
  });

  it('rejects answers from unknown players', () => {
    const state = start(lobbyWith(QUIZ, [['p1', 'Alice']]));
    const { state: after, effects } = reduce(state, {
      type: 'playerAnswer',
      playerId: 'ghost',
      answerIndex: 1,
      atMs: 1_002_000,
    });
    expect(after).toEqual(state);
    expect(effects).toEqual([
      { type: 'answerRejected', playerId: 'ghost', reason: 'unknown-player' },
    ]);
  });

  it('rejects out-of-range answer indexes', () => {
    const state = start(lobbyWith(QUIZ, [['p1', 'Alice']]));
    for (const answerIndex of [-1, 4]) {
      const { state: after, effects } = reduce(state, {
        type: 'playerAnswer',
        playerId: 'p1',
        answerIndex,
        atMs: 1_002_000,
      });
      expect(after).toEqual(state);
      expect(effects).toEqual([
        { type: 'answerRejected', playerId: 'p1', reason: 'invalid-answer' },
      ]);
    }
  });

  it('ignores answers outside the question phase', () => {
    const state = lobbyWith(QUIZ, [['p1', 'Alice']]);
    const { state: after, effects } = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 1,
      atMs: START_AT,
    });
    expect(after).toEqual(state);
    expect(effects).toEqual([]);
  });
});

describe('reveal', () => {
  it('emits a deterministic reveal payload and moves to the reveal phase', () => {
    let state = start(
      lobbyWith(QUIZ, [
        ['p1', 'Alice'],
        ['p2', 'Bob'],
        ['p3', 'Cara'],
      ]),
    );
    state = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 1, // correct
      atMs: 1_002_000,
    }).state;
    state = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p2',
      answerIndex: 0, // wrong
      atMs: 1_004_000,
    }).state;
    // p3 never answers.

    const { state: after, effects } = reduce(state, { type: 'reveal' });
    expect(after.phase).toBe('reveal');
    expect(effects).toEqual([
      {
        type: 'broadcastReveal',
        reveal: {
          questionIndex: 0,
          correctIndex: 1,
          results: [
            { playerId: 'p1', answerIndex: 1, correct: true, points: 800 },
            { playerId: 'p2', answerIndex: 0, correct: false, points: 0 },
            { playerId: 'p3', answerIndex: null, correct: false, points: 0 },
          ],
        },
      },
      { type: 'broadcastState', state: after },
    ]);
  });

  it('ignores reveal outside the question phase', () => {
    const state = lobbyWith(QUIZ, [['p1', 'Alice']]);
    const { state: after, effects } = reduce(state, { type: 'reveal' });
    expect(after).toEqual(state);
    expect(effects).toEqual([]);
  });
});

describe('next, leaderboard, podium', () => {
  // p1 answers Q1 correctly at 2000ms  -> round(1000 * 8000 / 10000) = 800
  // p2 answers Q1 correctly at 2001ms  -> round(1000 * 7999 / 10000) = = 800
  // p3 answers nothing and p4 is wrong on both questions -> 0.
  // p1 vs p2 tie on 800: earlier correct answer wins (2000 < 2001).
  function tieState(): GameState {
    let state = start(
      lobbyWith(QUIZ, [
        ['p2', 'Bob'],
        ['p1', 'Alice'],
        ['p4', 'Dana'],
        ['p3', 'Cara'],
      ]),
    );
    state = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 1,
      atMs: 1_002_000,
    }).state;
    state = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p2',
      answerIndex: 1,
      atMs: 1_002_001,
    }).state;
    state = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p4',
      answerIndex: 0,
      atMs: 1_003_000,
    }).state;
    return state;
  }

  it('moves reveal -> leaderboard ordered by score desc, earlier correct answer first on ties', () => {
    const state = reduce(tieState(), { type: 'reveal' }).state;
    const { state: after, effects } = reduce(state, {
      type: 'next',
      atMs: 1_011_000,
    });
    expect(after.phase).toBe('leaderboard');
    expect(after.timerDeadline).toBe(null);
    expect(after.answers).toEqual({});
    expect(after.questionIndex).toBe(0);
    expect(after.leaderboard).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(effects).toEqual([{ type: 'broadcastState', state: after }]);
  });

  it('falls back to stable id ordering when scores and correct times are equal', () => {
    // 'z' joins first, 'a' second; both are wrong on Q1 -> both score 0.
    let state = start(
      lobbyWith(QUIZ, [
        ['z', 'Zoe'],
        ['a', 'Amy'],
      ]),
    );
    state = reduce(state, {
      type: 'playerAnswer',
      playerId: 'z',
      answerIndex: 0,
      atMs: 1_002_000,
    }).state;
    state = reduce(state, {
      type: 'playerAnswer',
      playerId: 'a',
      answerIndex: 0,
      atMs: 1_004_000,
    }).state;
    const revealState = reduce(state, { type: 'reveal' }).state;
    const after = reduce(revealState, { type: 'next', atMs: 1_011_000 }).state;
    expect(after.leaderboard).toEqual(['a', 'z']);
  });

  it('moves leaderboard -> the next question with a fresh deadline', () => {
    const state = reduce(tieState(), { type: 'reveal' }).state;
    const leaderboard = reduce(state, { type: 'next', atMs: 1_011_000 }).state;
    const { state: after, effects } = reduce(leaderboard, {
      type: 'next',
      atMs: 1_012_000,
    });
    expect(after.phase).toBe('question');
    expect(after.questionIndex).toBe(1);
    expect(after.timerDeadline).toBe(Q2_DEADLINE); // 1_012_000 + 20 * 1000
    expect(after.answers).toEqual({});
    expect(effects).toEqual([{ type: 'broadcastState', state: after }]);
  });

  it('transitions to the podium after the last question, keeping deterministic order', () => {
    // Q1 (10s): p1 correct at 2000ms -> round(1000 * 8000 / 10000) = 800;
    //           p2 never answers; p4 wrong -> 0; p3 never answers.
    // Q2 (20s): p2 correct at 4000ms -> round(1000 * 16000 / 20000) = 800;
    //           p1 wrong -> stays 800.
    // Final scores tie at 800; p1's correct answer (at 2000, during Q1) is
    // earlier than p2's (at 4000, during Q2), so p1 ranks first.
    let state = start(
      lobbyWith(QUIZ, [
        ['p1', 'Alice'],
        ['p2', 'Bob'],
        ['p4', 'Dana'],
        ['p3', 'Cara'],
      ]),
    );
    state = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 1,
      atMs: 1_002_000,
    }).state;
    state = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p4',
      answerIndex: 0,
      atMs: 1_003_000,
    }).state;
    state = reduce(state, { type: 'reveal' }).state;
    state = reduce(state, { type: 'next', atMs: 1_011_000 }).state;
    state = reduce(state, { type: 'next', atMs: 1_012_000 }).state; // -> question 1
    state = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p2',
      answerIndex: 0, // correct on Q2 (correctIndex 0)
      atMs: 1_016_000,
    }).state;
    state = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 1, // wrong on Q2
      atMs: 1_017_000,
    }).state;

    expect(state.scores).toEqual({ p1: 800, p2: 800, p4: 0 });

    state = reduce(state, { type: 'reveal' }).state;
    const leaderboard = reduce(state, { type: 'next', atMs: 1_033_000 }).state;
    expect(leaderboard.phase).toBe('leaderboard');
    expect(leaderboard.leaderboard).toEqual(['p1', 'p2', 'p3', 'p4']);

    const { state: podium } = reduce(leaderboard, {
      type: 'next',
      atMs: 1_034_000,
    });
    expect(podium.phase).toBe('podium');
    expect(podium.leaderboard).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(podium.timerDeadline).toBe(null);
  });

  it('ignores next outside reveal/leaderboard phases', () => {
    const state = start(lobbyWith(QUIZ, [['p1', 'Alice']]));
    const { state: after, effects } = reduce(state, {
      type: 'next',
      atMs: START_AT,
    });
    expect(after).toEqual(state);
    expect(effects).toEqual([]);
  });
});

describe('end', () => {
  it('returns to a clean lobby but keeps the joined players', () => {
    let state = start(
      lobbyWith(QUIZ, [
        ['p1', 'Alice'],
        ['p2', 'Bob'],
      ]),
    );
    state = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 1,
      atMs: 1_002_000,
    }).state;

    const { state: after, effects } = reduce(state, { type: 'end' });
    expect(after.phase).toBe('lobby');
    expect(after.players.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(after.questionIndex).toBe(-1);
    expect(after.timerDeadline).toBe(null);
    expect(after.scores).toEqual({});
    expect(after.answers).toEqual({});
    expect(after.firstCorrectAtMs).toEqual({});
    expect(after.leaderboard).toEqual([]);
    expect(effects).toEqual([{ type: 'broadcastState', state: after }]);
  });

  it('is a no-op when already in the lobby', () => {
    const state = lobbyWith(QUIZ, [['p1', 'Alice']]);
    const { state: after, effects } = reduce(state, { type: 'end' });
    expect(after).toEqual(state);
    expect(effects).toEqual([]);
  });
});

describe('purity and determinism', () => {
  it('is deterministic: the same event sequence yields identical results', () => {
    const events = [
      { type: 'playerJoin', playerId: 'p1', name: 'Tony', color: 'red', atMs: 1_000_000 },
      { type: 'playerJoin', playerId: 'p2', name: 'Tony', color: 'blue', atMs: 1_000_100 },
      { type: 'startQuiz', atMs: 1_001_000 },
      { type: 'playerAnswer', playerId: 'p1', answerIndex: 1, atMs: 1_002_000 },
      { type: 'reveal' },
      { type: 'next', atMs: 1_011_000 },
      { type: 'end' },
    ] as const;
    const first = run(events);
    const second = run(events);
    expect(first).toEqual(second);
  });

  it('does not mutate the state it receives', () => {
    const initial = start(
      lobbyWith(QUIZ, [
        ['p1', 'Alice'],
        ['p2', 'Bob'],
      ]),
    );
    const snapshot = structuredClone(initial);
    reduce(initial, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 1,
      atMs: 1_002_000,
    });
    reduce(initial, { type: 'reveal' });
    reduce(initial, { type: 'playerJoin', playerId: 'p3', name: 'Cara', color: 'green', atMs: 1_009_000 });
    expect(initial).toEqual(snapshot);
  });
});

function run<Event>(events: ReadonlyArray<Event>): {
  state: GameState;
  effects: unknown[];
} {
  let state = createInitialGame(QUIZ);
  const effects: unknown[] = [];
  for (const event of events) {
    const step = reduce(state, event as never);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}
