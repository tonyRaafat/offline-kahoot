// Boot smoke test for the editor CRUD endpoints in src/server.ts.
// Spawns the real server (tsx) as a child process, parses the "host page:"
// log line for the bound port, then exercises create/read/update/delete
// against the running HTTP stack. The only data/quizzes files it touches
// start with "smoke-edit-quiz" and are removed again in afterAll.

import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const QUIZZES_DIR = path.join(projectRoot, 'data', 'quizzes');
const SMOKE_PREFIX = 'smoke-edit-quiz';
const HOST_PAGE_LINE = /host page: \S*?:(\d+)/;

/** Worked example: matches the Question shape in src/engine.ts. */
const renamedQuiz = {
  title: 'Smoke Edit Quiz Renamed',
  questions: [
    {
      prompt: 'Smoke question one',
      type: 'multiple-choice',
      timeSeconds: 20,
      options: ['a', 'b'],
      correctIndex: 1,
    },
  ],
};

let child: ReturnType<typeof spawn> | undefined;
let baseUrl = '';

beforeAll(async () => {
  child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
    cwd: projectRoot,
  });
  const stdout = child.stdout; // non-null because default stdio is 'pipe'
  if (!stdout) throw new Error('spawner created no stdout pipe');
  const childProcess = child;
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not boot within 30s')), 30_000);
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      const match = chunk.match(HOST_PAGE_LINE);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    childProcess.on('exit', (code: number | null) => reject(new Error(`server exited early (code ${code})`)));
  });
  baseUrl = `http://127.0.0.1:${port}`;
}, 40_000);

afterAll(async () => {
  child?.kill('SIGTERM');
  let files: string[] = [];
  try {
    files = await readdir(QUIZZES_DIR);
  } catch {
    // no quiz dir — nothing to clean
  }
  await Promise.all(
    files
      .filter((file) => file.startsWith(SMOKE_PREFIX) && file.endsWith('.json'))
      .map((file) => rm(path.join(QUIZZES_DIR, file), { force: true })),
  );
});

describe('editor endpoints boot smoke', () => {
  it('serves the editor page at /editor', async () => {
    const res = await fetch(`${baseUrl}/editor`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Quiz editor');
  });

  it('creates a quiz via POST /api/quizzes', async () => {
    const res = await fetch(`${baseUrl}/api/quizzes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Smoke Edit Quiz' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; title: string };
    expect(body.id.startsWith(SMOKE_PREFIX)).toBe(true);
    expect(body.title).toBe('Smoke Edit Quiz');
    // an empty-title create is rejected
    const bad = await fetch(`${baseUrl}/api/quizzes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    });
    expect(bad.status).toBe(400);
  });

  it('returns the full quiz JSON via GET /api/quizzes/:id', async () => {
    const res = await fetch(`${baseUrl}/api/quizzes/smoke-edit-quiz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: 'Smoke Edit Quiz', questions: [] });
    expect((await fetch(`${baseUrl}/api/quizzes/no-such-quiz-xyz`)).status).toBe(404);
  });

  it('rejects an invalid PUT with the error list, accepts a valid save', async () => {
    const invalid = {
      title: 'Smoke Edit Quiz',
      questions: [
        {
          prompt: '',
          type: 'multiple-choice',
          timeSeconds: 20,
          options: ['only-one'],
          correctIndex: 0,
        },
      ],
    };
    const badRes = await fetch(`${baseUrl}/api/quizzes/smoke-edit-quiz`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invalid),
    });
    expect(badRes.status).toBe(400);
    const badBody = (await badRes.json()) as { errors: string[] };
    expect(badBody.errors).toEqual([
      'questions[0].prompt: must be a non-empty string',
      'questions[0].options: must be an array of 2-4 strings',
    ]);

    const goodRes = await fetch(`${baseUrl}/api/quizzes/smoke-edit-quiz`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(renamedQuiz),
    });
    expect(goodRes.status).toBe(200);
    const saved = await fetch(`${baseUrl}/api/quizzes/smoke-edit-quiz`);
    expect((await saved.json()) as unknown).toEqual(renamedQuiz);
    const list = (await (await fetch(`${baseUrl}/api/quizzes`)).json()) as Array<{
      id: string;
      title: string;
      questionCount: number;
    }>;
    expect(list.find((q) => q.id === 'smoke-edit-quiz')).toEqual({
      id: 'smoke-edit-quiz',
      title: 'Smoke Edit Quiz Renamed',
      questionCount: 1,
    });
  });

  it('path traversal stays blocked on the new :id routes', async () => {
    const res = await fetch(`${baseUrl}/api/quizzes/..%2Fseed`);
    expect(res.status).toBe(400);
    const del = await fetch(`${baseUrl}/api/quizzes/..%2Fseed`, { method: 'DELETE' });
    expect(del.status).toBe(400);
  });

  it('removes the quiz via DELETE /api/quizzes/:id', async () => {
    const res = await fetch(`${baseUrl}/api/quizzes/smoke-edit-quiz`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await fetch(`${baseUrl}/api/quizzes/smoke-edit-quiz`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/quizzes/smoke-edit-quiz`, { method: 'DELETE' })).status).toBe(
      404,
    );
  });
});
