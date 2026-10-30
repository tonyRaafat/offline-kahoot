import { describe, expect, it } from 'vitest';
import { createInitialGame, reduce } from './engine.js';
import { stateView } from './state-view.js';

describe('stateView', () => {
  it('projects phase, quiz title, players and scores onto independent literal values', () => {
    const base = createInitialGame({
      title: 'Trivia Night',
      questions: [
        { prompt: 'q?', type: 'multiple-choice', timeSeconds: 10, options: ['a', 'b'], correctIndex: 0 },
      ],
    });
    const { state } = (() => {
      // simulate two joins by inlining the expected player records
      return {
        state: {
          ...base,
          players: [
            { id: 'p1', name: 'Tony', joinedAtMs: 1 },
            { id: 'p2', name: 'Tony-2', joinedAtMs: 2 },
          ],
          scores: { p1: 100 },
        },
      };
    })();

    expect(stateView(state)).toEqual({
      phase: 'lobby',
      quizTitle: 'Trivia Night',
      players: [
        { id: 'p1', name: 'Tony' },
        { id: 'p2', name: 'Tony-2' },
      ],
      scores: { p1: 100 },
      leaderboard: [],
      currentQuestion: null,
    });
  });

  it('never leaks quiz internals (questions/correct answers) or answer records', () => {
    const state = createInitialGame({
      title: 'T',
      questions: [
        { prompt: 'q?', type: 'true-false', timeSeconds: 5, options: ['a', 'b'], correctIndex: 1 },
      ],
    });
    const view = stateView(state) as unknown as Record<string, unknown>;
    expect(view).not.toHaveProperty('quiz');
    expect(view).not.toHaveProperty('answers');
    expect(view).not.toHaveProperty('correctIndex');
  });

  it('during the question phase exposes the leaderboard and a sanitized currentQuestion', () => {
    // Independent expected literals: startQuiz at 5_000 with a 30s question
    // puts the timer deadline at 35_000.
    let state = createInitialGame({
      title: 'T',
      questions: [
        {
          prompt: '2 + 2 = ?',
          type: 'multiple-choice',
          timeSeconds: 30,
          options: ['3', '4', '5'],
          correctIndex: 1,
        },
      ],
    });
    state = reduce(state, { type: 'playerJoin', playerId: 'p1', name: 'Ada', atMs: 1 }).state;
    state = reduce(state, { type: 'startQuiz', atMs: 5_000 }).state;

    const view = stateView(state);
    expect(view.currentQuestion).toEqual({
      questionIndex: 0,
      prompt: '2 + 2 = ?',
      options: ['3', '4', '5'],
      timeSeconds: 30,
      timerDeadline: 35_000,
    });
    expect(view.leaderboard).toEqual([]);

    // The sanitized view must not carry the correct answer anywhere.
    expect(JSON.stringify(view)).not.toContain('correctIndex');
    expect(JSON.stringify(view)).not.toContain('answers');
    expect(view).not.toHaveProperty('quiz');
  });

  it('clears currentQuestion outside the question phase (reveal/leaderboard/podium)', () => {
    let state = createInitialGame({
      title: 'T',
      questions: [
        { prompt: 'q?', type: 'true-false', timeSeconds: 5, options: ['True', 'False'], correctIndex: 1 },
      ],
    });
    state = reduce(state, { type: 'playerJoin', playerId: 'p1', name: 'Ada', atMs: 1 }).state;
    state = reduce(state, { type: 'startQuiz', atMs: 1_000 }).state;
    state = reduce(state, { type: 'reveal' }).state;

    expect(state.phase).toBe('reveal');
    expect(stateView(state).currentQuestion).toBeNull();

    state = reduce(state, { type: 'next', atMs: 2_000 }).state;
    expect(state.phase).toBe('leaderboard');
    expect(stateView(state).currentQuestion).toBeNull();
    // The engine-computed leaderboard ordering is passed through.
    expect(stateView(state).leaderboard).toEqual(['p1']);
  });
});
