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
      podiumRevealed: 0,
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
    // p2 never answers so the question stays open (no auto-reveal yet).
    const state = start(lobbyWith(QUIZ, [['p1', 'Alice'], ['p2', 'Bob']]));
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
    // p2 keeps the question open (no auto-reveal on p1's answer).
    const state = start(lobbyWith(QUIZ, [['p1', 'Alice'], ['p2', 'Bob']]));
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

  it('accepts a late answer with 0 points (hidden scoring window)', () => {
    // Past the deadline the remaining time is clamped to 0, so a correct
    // answer still locks in but scores nothing. p2 keeps the question open.
    const state = start(lobbyWith(QUIZ, [['p1', 'Alice'], ['p2', 'Bob']]));
    const { state: after, effects } = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 1,
      atMs: Q1_DEADLINE + 1,
    });
    expect(after.answers['p1']).toEqual({
      answerIndex: 1,
      atMs: Q1_DEADLINE + 1,
      correct: true,
      points: 0,
    });
    expect(after.scores).toEqual({ p1: 0 });
    expect(effects).toEqual([{ type: 'broadcastState', state: after }]);
  });

  it('rejects a second answer from the same player within one question', () => {
    // p2 keeps the question open after p1's first answer (no auto-reveal).
    const state = start(lobbyWith(QUIZ, [['p1', 'Alice'], ['p2', 'Bob']]));
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

describe('auto-reveal (every joined player answered)', () => {
  it('fires as soon as the last roster player answers, identical to a manual reveal', () => {
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
    // p1 alone: the question is still live.
    expect(state.phase).toBe('question');
    expect(state.scores).toEqual({ p1: 800 });

    // p2's answer completes the roster: question -> reveal, with scoring
    // already applied per answer. Same construction as the manual reveal.
    const { state: after, effects } = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p2',
      answerIndex: 0, // wrong
      atMs: 1_003_000,
    });
    expect(after.phase).toBe('reveal');
    expect(after.answers).toEqual({
      p1: { answerIndex: 1, atMs: 1_002_000, correct: true, points: 800 },
      p2: { answerIndex: 0, atMs: 1_003_000, correct: false, points: 0 },
    });
    expect(effects).toEqual([
      {
        type: 'broadcastReveal',
        reveal: {
          questionIndex: 0,
          correctIndex: 1,
          results: [
            { playerId: 'p1', answerIndex: 1, correct: true, points: 800 },
            { playerId: 'p2', answerIndex: 0, correct: false, points: 0 },
          ],
        },
      },
      { type: 'broadcastState', state: after },
    ]);
  });

  it('does not fire while any roster player has not answered', () => {
    let state = start(
      lobbyWith(QUIZ, [
        ['p1', 'Alice'],
        ['p2', 'Bob'],
      ]),
    );
    const { state: after } = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 1,
      atMs: 1_002_000,
    });
    expect(after.phase).toBe('question');
    expect(after.scores).toEqual({ p1: 800 });
  });

  it("is the manual reveal's fallback: a reveal after the auto-reveal is a no-op", () => {
    let state = start(lobbyWith(QUIZ, [['p1', 'Alice']]));
    const { state: revealed } = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p1',
      answerIndex: 1,
      atMs: 1_002_000,
    });
    expect(revealed.phase).toBe('reveal'); // 1-player roster answered -> auto
    const { state: after, effects } = reduce(revealed, { type: 'reveal' });
    expect(after).toEqual(revealed);
    expect(effects).toEqual([]);
  });

  it('a late answer still counts as answered and can trigger the auto-reveal', () => {
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
    const { state: after } = reduce(state, {
      type: 'playerAnswer',
      playerId: 'p2',
      answerIndex: 1,
      atMs: Q1_DEADLINE + 5_000, // well after the deadline
    });
    expect(after.phase).toBe('reveal');
    expect(after.answers['p2']).toEqual({
      answerIndex: 1,
      atMs: Q1_DEADLINE + 5_000,
      correct: true,
      points: 0,
    });
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
    const state = start(lobbyWith(QUIZ, [['p1', 'Alexander']]));
    const { state: after, effects } = reduce(state, {
      type: 'next',
      atMs: START_AT,
    });
    expect(after).toEqual(state);
    expect(effects).toEqual([]);
  });
});

describe('podiumReveal', () => {
  /** Drives the deterministic path to the podium: every roster player
   *  answers the single QUICK_MATHS question correctly (auto-reveal on the
   *  last answer), then two `next` hops finish at the podium. */
  function toPodium(roster: Array<[playerId: string, name: string]>): GameState {
    let state = start(lobbyWith(QUICK_MATHS, roster));
    for (const [playerId] of roster) {
      state = reduce(state, {
        type: 'playerAnswer',
        playerId,
        answerIndex: QUICK_MATHS.questions[0]!.correctIndex,
        atMs: 1_002_000,
      }).state;
    }
    expect(state.phase).toBe('reveal');
    state = reduce(state, { type: 'next', atMs: 1_003_000 }).state; // -> leaderboard
    state = reduce(state, { type: 'next', atMs: 1_003_500 }).state; // -> podium
    expect(state.phase).toBe('podium');
    return state;
  }

  it('enters the podium fully blank (podiumRevealed 0)', () => {
    const podium = toPodium([
      ['p1', 'Alice'],
      ['p2', 'Bob'],
      ['p3', 'Cara'],
    ]);
    expect(podium.podiumRevealed).toBe(0);
  });

  it('reveals one rank per click, lowest-first, broadcasting every step', () => {
    let state = toPodium([
      ['p1', 'Alice'],
      ['p2', 'Bob'],
      ['p3', 'Cara'],
    ]);
    for (const expected of [1, 2, 3]) {
      const { state: after, effects } = reduce(state, { type: 'podiumReveal' });
      expect(after.podiumRevealed).toBe(expected);
      expect(after.phase).toBe('podium');
      expect(effects).toEqual([{ type: 'broadcastState', state: after }]);
      state = after;
    }
  });

  it('caps at the podium size: clicks past the final reveal are exact no-ops', () => {
    let state = toPodium([
      ['p1', 'Alice'],
      ['p2', 'Bob'],
      ['p3', 'Cara'],
    ]);
    for (let i = 0; i < 3; i++) state = reduce(state, { type: 'podiumReveal' }).state;
    const { state: after, effects } = reduce(state, { type: 'podiumReveal' });
    expect(after).toEqual(state);
    expect(effects).toEqual([]);
  });

  it('caps at min(3, leaderboard length): a 2-player podium fully reveals on step 2', () => {
    let state = toPodium([
      ['p1', 'Alice'],
      ['p2', 'Bob'],
    ]);
    state = reduce(state, { type: 'podiumReveal' }).state; // click 1: 2nd place
    expect(state.podiumRevealed).toBe(1);
    state = reduce(state, { type: 'podiumReveal' }).state; // click 2: 1st place
    expect(state.podiumRevealed).toBe(2);
    const { effects } = reduce(state, { type: 'podiumReveal' });
    expect(effects).toEqual([]);
  });

  it('caps at 3 even with a longer roster (never reveals rank 4+)', () => {
    let state = toPodium([
      ['p1', 'Alice'],
      ['p2', 'Bob'],
      ['p3', 'Cara'],
      ['p4', 'Dana'],
      ['p5', 'Eli'],
    ]);
    for (let i = 1; i <= 3; i++) {
      state = reduce(state, { type: 'podiumReveal' }).state;
      expect(state.podiumRevealed).toBe(i);
    }
    const { state: after, effects } = reduce(state, { type: 'podiumReveal' });
    expect(after).toEqual(state);
    expect(effects).toEqual([]);
  });

  it('is a no-op outside the podium phase (lobby, question)', () => {
    const lobby = lobbyWith(QUICK_MATHS, [['p1', 'Alice']]);
    expect(reduce(lobby, { type: 'podiumReveal' })).toEqual({ state: lobby, effects: [] });
    const question = start(lobby);
    expect(reduce(question, { type: 'podiumReveal' })).toEqual({
      state: question,
      effects: [],
    });
  });

  it('is reset by end (clean lobby) and startQuiz (new game)', () => {
    let state = toPodium([
      ['p1', 'Alice'],
      ['p2', 'Bob'],
    ]);
    state = reduce(state, { type: 'podiumReveal' }).state;
    state = reduce(state, { type: 'podiumReveal' }).state;
    state = reduce(state, { type: 'podiumReveal' }).state;
    expect(state.podiumRevealed).toBe(2);

    const lobby = reduce(state, { type: 'end' }).state;
    expect(lobby.podiumRevealed).toBe(0);

    state = reduce(lobby, { type: 'playerJoin', playerId: 'p3', name: 'Cara', color: 'red', atMs: 2_000 }).state;
    const question = reduce(state, { type: 'startQuiz', atMs: 2_500 }).state;
    expect(question.podiumRevealed).toBe(0);
  });
});

describe('playerLeave', () => {
  it('in the lobby removes the player, cleans scores/answers/firstCorrectAtMs/leaderboard, and broadcasts', () => {
    let state = lobbyWith(QUIZ, [
      ['p1', 'Alice'],
      ['p2', 'Bob'],
    ]);
    // Leave happens only in the lobby, but the map/leaderboard cleanup is
    // still exercised: no-op in the lobby or not, the reducer must not leak
    // stale keys. Seed the maps as if a previous game left data behind.
    state = {
      ...state,
      scores: { p1: 5, p2: 7 },
      firstCorrectAtMs: { p1: 123, p2: 456 },
      answers: { p2: { answerIndex: 0, atMs: 1, correct: false, points: 0 } },
      leaderboard: ['p1', 'p2'],
    };
    const { state: after, effects } = reduce(state, { type: 'playerLeave', playerId: 'p1' });
    expect(after.players.map((p) => p.id)).toEqual(['p2']);
    expect(after.scores).toEqual({ p2: 7 });
    expect(after.firstCorrectAtMs).toEqual({ p2: 456 });
    expect(after.leaderboard).toEqual(['p2']);
    expect(effects).toEqual([{ type: 'broadcastState', state: after }]);
  });

  it('is a no-op for an unknown playerId', () => {
    const state = lobbyWith(QUIZ, [['p1', 'Alice']]);
    const { state: after, effects } = reduce(state, { type: 'playerLeave', playerId: 'ghost' });
    expect(after).toEqual(state);
    expect(effects).toEqual([]);
  });

  it('is ignored when the phase is not lobby (no mid-game roster changes)', () => {
    const started = start(lobbyWith(QUIZ, [['p1', 'Alice']]));
    const { state: after, effects } = reduce(started, { type: 'playerLeave', playerId: 'p1' });
    expect(after).toEqual(started);
    expect(after.players.map((p) => p.id)).toEqual(['p1']);
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
