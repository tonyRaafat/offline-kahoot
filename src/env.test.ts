// Unit tests for the hand-rolled .env reader and the ADMIN_PASSWORD boot gate
// in src/env.ts. Pure pieces (parser) are tested directly; the boot gate is
// tested through requireAdminPassword() with isolated .env files in a temp
// dir and save/restore around every process.env mutation.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  defaultEnvFiles,
  loadEnvFiles,
  parseEnvSource,
  requireAdminPassword,
} from './env.js';

const ENV_FILE_DIR = () => mkdtemp(path.join(tmpdir(), 'kahoot-env-'));

const savedEnv: Array<[string, string | undefined]> = [];

function setProcessEnv(key: string, value: string | undefined): void {
  savedEnv.push([key, process.env[key]]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(async () => {
  for (const [key, value] of savedEnv.splice(0).reverse()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('parseEnvSource', () => {
  it('parses KEY=VALUE lines, comments, blank lines and quotes', () => {
    const source = [
      '# full-line comment',
      '',
      'PLAIN=value',
      '  SPACED=  trimmed  ',
      'QUOTE_DOUBLE="kept as-is"',
      "QUOTE_SINGLE='single quoted'",
      'EXPORTISH=left', // a malformed "EXPORT KEY=value" line is ignored below
      'NOKEY',
      '=novalue',
      'UNQUOTED_HASH=abc # not a comment inside values (kept verbatim)',
      'RIGHT_QUOTES="unterminated quote',
    ].join('\n');
    expect(parseEnvSource(source)).toEqual({
      PLAIN: 'value',
      SPACED: 'trimmed',
      QUOTE_DOUBLE: 'kept as-is',
      QUOTE_SINGLE: 'single quoted',
      EXPORTISH: 'left',
      UNQUOTED_HASH: 'abc # not a comment inside values (kept verbatim)',
      RIGHT_QUOTES: '"unterminated quote',
    });
  });

  it('ignores keys that are not env-var identifiers', () => {
    expect(parseEnvSource('BAD-KEY=x\nlower2=y\nA_B_C=z')).toEqual({ lower2: 'y', A_B_C: 'z' });
  });
});

describe('loadEnvFiles', () => {
  it('sets variables from the file but never overrides existing process.env values', async () => {
    const dir = await ENV_FILE_DIR();
    const file = path.join(dir, '.env');
    await writeFile(file, 'ADMIN_PASSWORD=file-password\nOTHER=file-other\n# comment\n');
    setProcessEnv('ADMIN_PASSWORD', 'already-set');
    setProcessEnv('OTHER', undefined);

    loadEnvFiles([file]);

    expect(process.env.ADMIN_PASSWORD).toBe('already-set'); // real env wins
    expect(process.env.OTHER).toBe('file-other');
    delete process.env.OTHER;
  });

  it('ignores files that do not exist', () => {
    expect(() => loadEnvFiles(['/definitely/not/here/.env-not-there'])).not.toThrow();
  });
});

describe('requireAdminPassword (boot fail-fast)', () => {
  it('throws when every looked-up .env file is missing', () => {
    expect(() => requireAdminPassword(['/definitely/not/here/.env'])).toThrow(/ADMIN_PASSWORD(.| )*\.env/s);
  });

  it('throws with a message naming ADMIN_PASSWORD and .env when the var is missing', async () => {
    const dir = await ENV_FILE_DIR();
    const file = path.join(dir, '.env');
    await writeFile(file, 'SOMETHING_ELSE=yes\n');
    try {
      setProcessEnv('ADMIN_PASSWORD', undefined);
      expect(() => requireAdminPassword([file])).toThrow(/ADMIN_PASSWORD/);
      expect(() => requireAdminPassword([file])).toThrow(/\.env/);
    } finally {
      delete process.env.ADMIN_PASSWORD;
    }
  });

  it('throws when ADMIN_PASSWORD is empty or whitespace-only', async () => {
    const dir = await ENV_FILE_DIR();
    const emptyFile = path.join(dir, 'empty.env');
    const blankFile = path.join(dir, 'blank.env');
    await writeFile(emptyFile, 'ADMIN_PASSWORD=\n');
    await writeFile(blankFile, 'ADMIN_PASSWORD="   "\n');
    try {
      setProcessEnv('ADMIN_PASSWORD', undefined);
      expect(() => requireAdminPassword([emptyFile])).toThrow(/empty|not set/i);
      expect(() => requireAdminPassword([blankFile])).toThrow(/empty|not set/i);
    } finally {
      delete process.env.ADMIN_PASSWORD;
    }
  });

  it('returns the trimmed password and normalizes process.env', async () => {
    const dir = await ENV_FILE_DIR();
    const file = path.join(dir, '.env');
    await writeFile(file, 'ADMIN_PASSWORD="  padded-password  "\n');
    try {
      setProcessEnv('ADMIN_PASSWORD', undefined);
      expect(requireAdminPassword([file])).toBe('padded-password');
      expect(process.env.ADMIN_PASSWORD).toBe('padded-password');
    } finally {
      delete process.env.ADMIN_PASSWORD;
    }
  });

  it('a real process.env value skips the missing-file problem entirely', () => {
    setProcessEnv('ADMIN_PASSWORD', 'from-the-environment');
    expect(requireAdminPassword(['/no/.env/anymore'])).toBe('from-the-environment');
  });

  it('defaultEnvFiles lists the CWD .env (and the exe-side one only in SEA mode)', () => {
    const files = defaultEnvFiles();
    expect(files[0]).toBe(path.join(process.cwd(), '.env'));
    expect(files).toHaveLength(1);
  });
});
