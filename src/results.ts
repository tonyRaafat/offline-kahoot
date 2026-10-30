// Game results: the finish-game seam between engine state and the filesystem.
//
// Pure projection (buildResults) and a thin node:fs/promises writer
// (saveResultsFile) live beside a GameResultsRecorder that the socket layer
// feeds with engine Effects; it accumulates per-question reveals, saves a game
// exactly once, and resets when a new game starts. No wall clock inside the
// pure helpers — timestamps are passed in, keeping tests deterministic.

import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GameState, Reveal } from './engine.js';

export interface ResultsAnswer {
  playerId: string;
  name: string;
  answerIndex: number | null;
  correct: boolean;
  points: number;
}

export interface ResultsQuestion {
  prompt: string;
  correctIndex: number;
  answers: ResultsAnswer[];
}

export interface ResultsRecord {
  quizTitle: string;
  endedAt: string;
  players: Array<{ id: string; name: string }>;
  finalScores: Record<string, number>;
  questions: ResultsQuestion[];
}

/** 'YYYY-MM-DD_HHmm.json' in UTC, so names are stable across timezones. */
export function resultsFilename(endedAtMs: number): string {
  const d = new Date(endedAtMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}.json`
  );
}

/**
 * Projects one finished game into the persisted results record. `state` is the
 * pre-end state (post-`end` state has scores cleared), `reveals` are the
 * broadcastReveal payloads accumulated during the game; players without a
 * score entry (never answered) read as 0 points.
 */
export function buildResults(
  state: GameState,
  reveals: Reveal[],
  endedAtMs: number,
): ResultsRecord {
  const names = new Map(state.players.map((p) => [p.id, p.name]));
  const questions = [...reveals]
    .sort((a, b) => a.questionIndex - b.questionIndex)
    .map((reveal) => ({
      prompt: state.quiz.questions[reveal.questionIndex]?.prompt ?? '',
      correctIndex: reveal.correctIndex,
      answers: reveal.results.map((result) => ({
        playerId: result.playerId,
        name: names.get(result.playerId) ?? result.playerId,
        answerIndex: result.answerIndex,
        correct: result.correct,
        points: result.points,
      })),
    }));
  return {
    quizTitle: state.quiz.title,
    endedAt: new Date(endedAtMs).toISOString(),
    players: state.players.map(({ id, name }) => ({ id, name })),
    finalScores: Object.fromEntries(state.players.map((p) => [p.id, state.scores[p.id] ?? 0])),
    questions,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** mkdir -p the results dir, then write the record as pretty JSON. Two games
 *  finishing within one minute share the timestamped name, so collisions get a
 *  `-2`, `-3`, ... suffix instead of overwriting an earlier game's results. */
export async function saveResultsFile(dir: string, results: ResultsRecord): Promise<string> {
  await mkdir(dir, { recursive: true });
  const base = resultsFilename(Date.parse(results.endedAt));
  let name = base;
  for (let n = 2; await fileExists(path.join(dir, name)); n++) {
    name = base.replace(/\.json$/, `-${n}.json`);
  }
  const filePath = path.join(dir, name);
  await writeFile(filePath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  return filePath;
}

const LOG_PREFIX = '[offline-kahoot]';

/**
 * Accumulates one game's reveals and saves its results exactly once:
 * on the broadcast state that reaches the podium (natural completion) or on an
 * explicit endGame(); starting question 0 again starts a fresh game.
 */
export class GameResultsRecorder {
  private reveals: Reveal[] = [];
  private savedForThisGame = false;

  constructor(
    private readonly resultsDir: string,
    private readonly onError: (err: unknown) => void = (err) =>
      console.error(`${LOG_PREFIX} failed to save results:`, err),
  ) {}

  /** A new game started (broadcast state in the question phase at index 0). */
  onState(state: GameState): Promise<void> | undefined {
    if (state.phase === 'question' && state.questionIndex === 0 && state.timerDeadline !== null) {
      this.reset();
      return;
    }
    if (state.phase === 'podium') return this.endGame(state);
  }

  /** Called with every broadcastReveal effect during the live game. */
  addReveal(reveal: Reveal): void {
    if (!this.savedForThisGame) this.reveals.push(reveal);
  }

  /** Saves the given pre-end state once per game; later calls are no-ops. */
  endGame(state: GameState): Promise<void> | undefined {
    if (this.savedForThisGame) return;
    this.savedForThisGame = true;
    return this.save(state);
  }

  private reset(): void {
    this.reveals = [];
    this.savedForThisGame = false;
  }

  private async save(state: GameState): Promise<void> {
    try {
      await saveResultsFile(this.resultsDir, buildResults(state, [...this.reveals], Date.now()));
    } catch (err) {
      this.onError(err);
    }
  }
}
