// Boot smoke test for the editor CRUD endpoints in src/server.ts.
// Spawns the real server (tsx) as a child process, parses the "host page:"
// log line for the bound port, then exercises create/read/update/delete
// against the running HTTP stack. The server requires ADMIN_PASSWORD (issue
// 01), so the child gets it via the environment (documented scriptable
// answer for the SPA smoke: real env var, which wins over any .env file);
// mutations and gated reads then go through the login cookie (issue 03).
// The only data/quizzes files it touches start with "smoke-edit-quiz" and
// are removed again in afterAll.

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

const ADMIN_PASSWORD = 'server-crud-test-admin-password';
let child: ReturnType<typeof spawn> | undefined;
let baseUrl = '';
/** Cookie header value `ka_session=<token>` captured from a successful login. */
let cookie = '';

/** Logs in once; test requests then ride the session cookie. */
async function login(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  expect(res.status).toBe(204);
  cookie = parseSetCookie(res.headers.get('set-cookie'));
}

/** First cookie's `name=value` pair, for the Cookie request header. */
function parseSetCookie(header: string | null): string {
  if (!header) throw new Error('no Set-Cookie on login');
  return header.split(';')[0];
}

/** fetch with the session cookie attached (test uses raw cookie headers). */
function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Cookie', cookie);
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

beforeAll(async () => {
  const childEnv = { ...process.env } as NodeJS.ProcessEnv;
  childEnv.ADMIN_PASSWORD = ADMIN_PASSWORD; // wins over any .env file (env.ts precedence)
  child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
    cwd: projectRoot,
    env: childEnv,
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
  await login();
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
  it('serves the editor page at /editor (with the session cookie)', async () => {
    const res = await authedFetch('/editor');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Quiz editor');
  });

  it('creates a quiz via POST /api/quizzes', async () => {
    const res = await authedFetch('/api/quizzes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Smoke Edit Quiz' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; title: string };
    expect(body.id.startsWith(SMOKE_PREFIX)).toBe(true);
    expect(body.title).toBe('Smoke Edit Quiz');
    // an empty-title create is rejected
    const bad = await authedFetch('/api/quizzes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    });
    expect(bad.status).toBe(400);
  });

  it('returns the full quiz JSON via GET /api/quizzes/:id', async () => {
    const res = await authedFetch('/api/quizzes/smoke-edit-quiz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: 'Smoke Edit Quiz', questions: [] });
    expect((await authedFetch('/api/quizzes/no-such-quiz-xyz')).status).toBe(404);
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
    const badRes = await authedFetch('/api/quizzes/smoke-edit-quiz', {
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

    const goodRes = await authedFetch('/api/quizzes/smoke-edit-quiz', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(renamedQuiz),
    });
    expect(goodRes.status).toBe(200);
    const saved = await authedFetch('/api/quizzes/smoke-edit-quiz');
    expect((await saved.json()) as unknown).toEqual(renamedQuiz);
    const list = (await (await authedFetch('/api/quizzes')).json()) as Array<{
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
    const res = await authedFetch('/api/quizzes/..%2Fseed');
    expect(res.status).toBe(400);
    const del = await authedFetch('/api/quizzes/..%2Fseed', { method: 'DELETE' });
    expect(del.status).toBe(400);
  });

  it('removes the quiz via DELETE /api/quizzes/:id', async () => {
    const res = await authedFetch('/api/quizzes/smoke-edit-quiz', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await authedFetch('/api/quizzes/smoke-edit-quiz')).status).toBe(404);
    expect((await authedFetch('/api/quizzes/smoke-edit-quiz', { method: 'DELETE' })).status).toBe(
      404,
    );
  });
});
