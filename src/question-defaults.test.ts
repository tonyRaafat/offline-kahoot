// Unit tests for the editor's default-question helper. Expected values are
// written as literals that match the Question shape in src/engine.ts, never
// recomputed via the helper itself.

import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_SECONDS, newQuestion } from '../public/question-defaults.js';

describe('question-defaults', () => {
  it('defaults the timer to 20 seconds (editor asks for DEFAULT 20s)', () => {
    expect(DEFAULT_TIME_SECONDS).toBe(20);
  });

  it('builds an empty multiple-choice question: 2 blank options, first one correct', () => {
    expect(newQuestion('multiple-choice')).toEqual({
      prompt: '',
      type: 'multiple-choice',
      timeSeconds: 20,
      options: ['', ''],
      correctIndex: 0,
    });
  });

  it('builds a true/false question with fixed options ["True","False"], correctIndex 0', () => {
    expect(newQuestion('true-false')).toEqual({
      prompt: '',
      type: 'true-false',
      timeSeconds: 20,
      options: ['True', 'False'],
      correctIndex: 0,
    });
  });
});
