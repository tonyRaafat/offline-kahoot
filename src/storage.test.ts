// Unit tests for quiz storage: the pure validation seam (validateQuiz /
// importQuiz / exportQuiz) plus the thin node:fs/promises file helpers,
// exercised against a throwaway temp directory.

import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteQuizFile,
  exportQuiz,
  importQuiz,
  listQuizzes,
  newQuizFilePath,
  quizSlug,
  readQuizFile,
  validateQuiz,
  writeQuizFile,
} from './storage.js';
import type { Quiz } from './engine.js';

/** Worked example independent of the implementation: matches src/engine.ts shape. */
const validQuiz: Quiz = {
  title: 'Pub Quiz Warm-Up',
  questions: [
    {
      prompt: 'Which planet is known as the Red Planet?',
      type: 'multiple-choice',
      timeSeconds: 20,
      options: ['Venus', 'Mars', 'Jupiter', 'Mercury'],
      correctIndex: 1,
    },
    {
      prompt: 'The Great Wall of China is visible from space with the naked eye.',
      type: 'true-false',
      timeSeconds: 15,
      options: ['True', 'False'],
      correctIndex: 1,
    },
  ],
};

describe('validateQuiz', () => {
  it('accepts a fully valid quiz unchanged', () => {
    expect(validateQuiz(validQuiz)).toEqual({ ok: true, quiz: validQuiz });
  });

  it('accepts a 2-option question of either type (true-false is a 2-option choice)', () => {
    const twoOption: unknown = {
      title: 'Two Options',
      questions: [
        {
          prompt: 'Sky is blue by day',
          type: 'true-false',
          timeSeconds: 10,
          options: ['True', 'False'],
          correctIndex: 0,
        },
        {
          prompt: 'Sky is pink by day',
          type: 'multiple-choice',
          timeSeconds: 10,
          options: ['True', 'False'],
          correctIndex: 1,
        },
      ],
    };
    expect(validateQuiz(twoOption)).toEqual({ ok: true, quiz: twoOption });
  });

  it('rejects payloads that are not JSON objects', () => {
    for (const raw of [null, 42, 'quiz', [], true]) {
      const result = validateQuiz(raw);
      expect(result).toEqual({ ok: false, errors: ['quiz: must be a JSON object'] });
    }
  });

  it('rejects a missing / non-string / empty title', () => {
    expect(validateQuiz({ questions: [] })?.ok).toBe(false);
    expect(validateQuiz({ title: 7, questions: [] }).ok).toBe(false);
    expect(validateQuiz({ title: '', questions: [] }).ok).toBe(false);
    expect(validateQuiz({ title: '   ', questions: [] }).ok).toBe(false);
    const result = validateQuiz({ title: '', questions: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('title'));
  });

  it('rejects a missing or non-array questions field', () => {
    expect(validateQuiz({ title: 'X' }).ok).toBe(false);
    expect(validateQuiz({ title: 'X', questions: 'nope' }).ok).toBe(false);
    const result = validateQuiz({ title: 'X', questions: 'nope' });
    if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('questions'));
  });

  it('rejects a question that is not an object', () => {
    const result = validateQuiz({
      title: 'X',
      questions: ['warmup'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('questions[0]'));
  });

  it('rejects empty or missing prompts', () => {
    const result = validateQuiz({
      title: 'X',
      questions: [{ type: 'true-false', timeSeconds: 10, options: ['a', 'b'], correctIndex: 0 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('.prompt'));

    const empty = validateQuiz({
      title: 'X',
      questions: [{ prompt: '  ', type: 'true-false', timeSeconds: 10, options: ['a', 'b'], correctIndex: 0 }],
    });
    expect(empty.ok).toBe(false);
  });

  it('rejects a type outside the two allowed values', () => {
    const result = validateQuiz({
      title: 'X',
      questions: [{ prompt: 'p', type: 'open-ended', timeSeconds: 10, options: ['a', 'b'], correctIndex: 0 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('.type'));
  });

  it('rejects non-positive, non-finite, or non-numeric timeSeconds', () => {
    for (const timeSeconds of [0, -5, '20', NaN, Infinity]) {
      const result = validateQuiz({
        title: 'X',
        questions: [{ prompt: 'p', type: 'true-false', timeSeconds, options: ['a', 'b'], correctIndex: 0 }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('.timeSeconds'));
    }
  });

  it('rejects options that are not a string array of 2-4 entries', () => {
    for (const options of [undefined, 'a,b', 7, ['only'], ['a', 'b', 'c', 'd', 'e'], ['a', 2]]) {
      const result = validateQuiz({
        title: 'X',
        questions: [{ prompt: 'p', type: 'true-false', timeSeconds: 10, options: options as never, correctIndex: 0 }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('.options'));
    }
  });

  it('rejects a correctIndex outside the options range or not an integer', () => {
    for (const correctIndex of [-1, 2, 1.5, null]) {
      const result = validateQuiz({
        title: 'X',
        questions: [{ prompt: 'p', type: 'true-false', timeSeconds: 10, options: ['a', 'b'], correctIndex }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('.correctIndex'));
    }
  });

  it('rejects a later question (index surfaces in errors)', () => {
    const result = validateQuiz({
      title: 'X',
      questions: [
        { prompt: 'ok?', type: 'true-false', timeSeconds: 10, options: ['a', 'b'], correctIndex: 0 },
        { prompt: 'bad?', type: 'true-false', timeSeconds: -1, options: ['a', 'b'], correctIndex: 0 },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('questions[1].timeSeconds'));
  });
});

describe('importQuiz / exportQuiz', () => {
  it('parses and validates a valid JSON string', () => {
    const result = importQuiz(JSON.stringify(validQuiz));
    expect(result).toEqual({ ok: true, quiz: validQuiz });
  });

  it('reports malformed JSON with a clear error', () => {
    const result = importQuiz('{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('not valid JSON');
  });

  it('reports an invalid quiz shape with validation errors', () => {
    const result = importQuiz('{"title": ""}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  it('exports to a parseable JSON string', () => {
    expect(JSON.parse(exportQuiz(validQuiz))).toEqual(validQuiz);
  });
});

let tmpDir: string;
const quizDir = () => path.join(tmpDir, 'quizzes');

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'kahoot-quizzes-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('quiz file helpers', () => {
  it('lists an absent quiz directory as empty', async () => {
    expect(await listQuizzes(quizDir())).toEqual([]);
  });

  it('lists quiz ids (filename without .json), sorted, ignoring other files', async () => {
    await mkdir(quizDir());
    await writeFile(path.join(quizDir(), 'b-team.json'), '{}');
    await writeFile(path.join(quizDir(), 'a-team.json'), '{}');
    await writeFile(path.join(quizDir(), 'notes.txt'), 'not a quiz');
    await writeFile(path.join(quizDir(), 'draft.json.bak'), 'not a quiz');
    expect(await listQuizzes(quizDir())).toEqual(['a-team', 'b-team']);
  });

  it('writeQuizFile / readQuizFile round-trip a quiz (creating the directory)', async () => {
    const target = path.join(quizDir(), 'seed.json');
    await writeQuizFile(target, validQuiz);
    expect(await readQuizFile(target)).toEqual(validQuiz);
  });

  it('readQuizFile throws a clear error on malformed or invalid quiz files', async () => {
    await mkdir(quizDir());
    await writeFile(path.join(quizDir(), 'broken.json'), '{oops');
    await writeFile(
      path.join(quizDir(), 'bad-shape.json'),
      JSON.stringify({ title: '', questions: [] }),
    );
    await expect(readQuizFile(path.join(quizDir(), 'broken.json'))).rejects.toThrow(/not valid JSON/);
    await expect(readQuizFile(path.join(quizDir(), 'bad-shape.json'))).rejects.toThrow(/title/);
  });

  it('deleteQuizFile removes the quiz file', async () => {
    const target = path.join(quizDir(), 'temp.json');
    await mkdir(quizDir());
    await writeQuizFile(target, validQuiz);
    expect(await listQuizzes(quizDir())).toEqual(['temp']);
    await deleteQuizFile(target);
    expect(await listQuizzes(quizDir())).toEqual([]);
  });

  it('quizSlug slugs a title to a filename-safe id', () => {
    expect(quizSlug('Pub Quiz & Warm-Up!')).toBe('pub-quiz-warm-up');
    expect(quizSlug('Maths: Fractions')).toBe('maths-fractions');
  });

  it('newQuizFilePath returns slug.json, then slug-2.json on collision', async () => {
    await mkdir(quizDir());
    expect(await newQuizFilePath(quizDir(), 'Pub Quiz')).toBe(path.join(quizDir(), 'pub-quiz.json'));
    await writeQuizFile(path.join(quizDir(), 'pub-quiz.json'), validQuiz);
    const next = await newQuizFilePath(quizDir(), 'Pub Quiz');
    expect(next).toBe(path.join(quizDir(), 'pub-quiz-2.json'));
  });
});
