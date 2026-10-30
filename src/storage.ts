// Quiz persistence: one JSON file per quiz in data/quizzes/.
// validateQuiz/importQuiz/exportQuiz are the pure seam (no I/O); the file
// helpers below are thin node:fs/promises wrappers around them.

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Quiz } from './engine.js';

export type QuizValidationResult =
  | { ok: true; quiz: Quiz }
  | { ok: false; errors: string[] };

const QUIZ_FILE_EXT = '.json';
const ALLOWED_QUESTION_TYPES = new Set(['multiple-choice', 'true-false']);

/**
 * Strict quiz-shape validation for imported/saved JSON. A question keeps its
 * declared type ('true-false' is stored as-is but validated like any other
 * 2-option multiple-choice entry).
 */
export function validateQuiz(raw: unknown): QuizValidationResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['quiz: must be a JSON object'] };
  }
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof obj.title !== 'string' || obj.title.trim() === '') {
    errors.push('title: must be a non-empty string');
  }

  if (!Array.isArray(obj.questions)) {
    errors.push('questions: must be an array');
    return { ok: false, errors };
  }
  obj.questions.forEach((question, index) => {
    validateQuestion(question, `questions[${index}]`, errors);
  });

  return errors.length === 0
    ? { ok: true, quiz: obj as unknown as Quiz }
    : { ok: false, errors };
}

function validateQuestion(raw: unknown, at: string, errors: string[]): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${at}: must be an object`);
    return;
  }
  const q = raw as Record<string, unknown>;

  if (typeof q.prompt !== 'string' || q.prompt.trim() === '') {
    errors.push(`${at}.prompt: must be a non-empty string`);
  }
  if (typeof q.type !== 'string' || !ALLOWED_QUESTION_TYPES.has(q.type)) {
    errors.push(`${at}.type: must be 'multiple-choice' or 'true-false'`);
  }
  if (typeof q.timeSeconds !== 'number' || !Number.isFinite(q.timeSeconds) || q.timeSeconds <= 0) {
    errors.push(`${at}.timeSeconds: must be a positive number`);
  }
  const options = q.options;
  if (
    !Array.isArray(options) ||
    options.length < 2 ||
    options.length > 4 ||
    !options.every((option) => typeof option === 'string')
  ) {
    errors.push(`${at}.options: must be an array of 2-4 strings`);
    return;
  }
  if (
    typeof q.correctIndex !== 'number' ||
    !Number.isInteger(q.correctIndex) ||
    q.correctIndex < 0 ||
    q.correctIndex >= options.length
  ) {
    errors.push(`${at}.correctIndex: must be an integer within the options range`);
  }
}

/** Parses a quiz JSON string (e.g. an uploaded file) through validateQuiz. */
export function importQuiz(jsonString: string): QuizValidationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonString);
  } catch (err) {
    return { ok: false, errors: [`not valid JSON: ${(err as Error).message}`] };
  }
  return validateQuiz(raw);
}

/** Serializes a quiz to pretty-printed JSON (the on-disk / export format). */
export function exportQuiz(quiz: Quiz): string {
  return JSON.stringify(quiz, null, 2);
}

/** Quiz ids for every *.json file in dir (filename without .json), sorted. */
export async function listQuizzes(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.endsWith(QUIZ_FILE_EXT))
    .map((entry) => entry.slice(0, -QUIZ_FILE_EXT.length))
    .sort();
}

/**
 * Reads and validates one quiz file; throws a descriptive Error when the
 * file is missing, unreadable, malformed JSON, or not a valid quiz.
 */
export async function readQuizFile(filePath: string): Promise<Quiz> {
  const text = await readFile(filePath, 'utf8');
  const result = importQuiz(text);
  if (!result.ok) {
    throw new Error(`invalid quiz file ${filePath}: ${result.errors.join('; ')}`);
  }
  return result.quiz;
}

/** Writes a quiz as pretty JSON, creating the parent directory if needed. */
export async function writeQuizFile(filePath: string, quiz: Quiz): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, exportQuiz(quiz), 'utf8');
}

export async function deleteQuizFile(filePath: string): Promise<void> {
  await unlink(filePath);
}

/** Filename-safe id derived from a quiz title: "Pub Quiz & Warm-Up!" -> "pub-quiz-warm-up". */
export function quizSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'quiz';
}

/** Free path for a new quiz file: slug.json, then slug-2.json, slug-3.json, ... */
export async function newQuizFilePath(dir: string, title: string): Promise<string> {
  const slug = quizSlug(title);
  const existing = new Set(await listQuizzes(dir));
  let candidate = slug;
  for (let n = 2; existing.has(candidate); n++) {
    candidate = `${slug}-${n}`;
  }
  return path.join(dir, `${candidate}${QUIZ_FILE_EXT}`);
}
