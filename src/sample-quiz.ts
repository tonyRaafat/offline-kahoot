// Compatibility shim: the sample quiz content moved to data/quizzes/seed.json
// (one quiz = one JSON file). socket.test.ts still imports `sampleQuiz`, and
// loading it through storage also proves the committed seed file is valid.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readQuizFile } from './storage.js';
import type { Quiz } from './engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const sampleQuiz: Quiz = await readQuizFile(
  path.join(here, '..', 'data', 'quizzes', 'seed.json'),
);
