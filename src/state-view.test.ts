import { describe, expect, it } from 'vitest';
import { createInitialGame } from './engine.js';
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
});
