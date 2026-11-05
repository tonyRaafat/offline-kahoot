// Pure, dependency-free game engine — the single test seam of the project.
//
// `reduce(state, event) -> { state, effects }` is the only entry point.
// All time enters the reducer explicitly via `atMs` fields on events and the
// `timerDeadline` stored in state; nothing here reads the wall clock or does
// any I/O, so scoring and late-answer checks are fully deterministic.

import type { AvatarColor } from './avatar-colors.js';

export type Phase = 'lobby' | 'question' | 'reveal' | 'leaderboard' | 'podium';

export interface Question {
  prompt: string;
  type: 'multiple-choice' | 'true-false';
  timeSeconds: number;
  options: string[];
  correctIndex: number;
}

export interface Quiz {
  title: string;
  questions: Question[];
}

export interface Player {
  /** Stable join-issued id; the key used by scores/answers/leaderboard. */
  id: string;
  /** Nickname exactly as the client joined it (uniqueness is enforced at the
   *  socket layer — duplicate names are REJECTED, never auto-suffixed). */
  name: string;
  /** One of the 10 avatar palette keys (src/avatar-colors.ts). */
  color: AvatarColor;
  joinedAtMs: number;
}

export interface AnswerRecord {
  answerIndex: number;
  atMs: number;
  correct: boolean;
  points: number;
}

export interface GameState {
  phase: Phase;
  quiz: Quiz;
  players: Player[];
  /** Cumulative points per player id. */
  scores: Record<string, number>;
  /** Index into quiz.questions; -1 before the quiz starts. */
  questionIndex: number;
  /** Absolute epoch ms at which the current question times out; null outside the question phase. */
  timerDeadline: number | null;
  /** Accepted answers for the current question only; cleared when it ends. */
  answers: Record<string, AnswerRecord>;
  /** Earliest correct-answer ms per player across the whole game (leaderboard tie-break). */
  firstCorrectAtMs: Record<string, number>;
  /** Player ids ordered score desc, then earliest correct answer, then id asc; set on entering leaderboard/podium. */
  leaderboard: string[];
}

export type Event =
  | { type: 'startQuiz'; atMs: number }
  | { type: 'playerJoin'; playerId: string; name: string; color: AvatarColor; atMs: number }
  | { type: 'playerAnswer'; playerId: string; answerIndex: number; atMs: number }
  | { type: 'reveal' }
  | { type: 'next'; atMs: number }
  | { type: 'end' };

export type AnswerRejectReason =
  | 'unknown-player'
  | 'already-answered'
  | 'late'
  | 'invalid-answer';

export interface RevealResult {
  playerId: string;
  answerIndex: number | null;
  correct: boolean;
  points: number;
}

export interface Reveal {
  questionIndex: number;
  correctIndex: number;
  /** One entry per joined player, in join order. */
  results: RevealResult[];
}

export type Effect =
  /** Full state push to host and players. */
  | { type: 'broadcastState'; state: GameState }
  /** Per-question answer reveal, emitted together with broadcastState. */
  | { type: 'broadcastReveal'; reveal: Reveal }
  /** Tells one player their answer was not accepted. */
  | { type: 'answerRejected'; playerId: string; reason: AnswerRejectReason };

export function createInitialGame(quiz: Quiz): GameState {
  return {
    phase: 'lobby',
    quiz,
    players: [],
    scores: {},
    questionIndex: -1,
    timerDeadline: null,
    answers: {},
    firstCorrectAtMs: {},
    leaderboard: [],
  };
}

/** Invalid events are ignored: unchanged state, no effects. */
export function reduce(
  state: GameState,
  event: Event,
): { state: GameState; effects: Effect[] } {
  switch (event.type) {
    case 'playerJoin': {
      if (state.phase !== 'lobby') return { state, effects: [] };
      if (state.players.some((p) => p.id === event.playerId)) {
        return { state, effects: [] };
      }
      const player: Player = {
        id: event.playerId,
        name: event.name,
        color: event.color,
        joinedAtMs: event.atMs,
      };
      const next: GameState = { ...state, players: [...state.players, player] };
      return { state: next, effects: [{ type: 'broadcastState', state: next }] };
    }

    case 'startQuiz': {
      if (
        state.phase !== 'lobby' ||
        state.players.length === 0 ||
        state.quiz.questions.length === 0
      ) {
        return { state, effects: [] };
      }
      const question = state.quiz.questions[0];
      const next: GameState = {
        ...state,
        phase: 'question',
        questionIndex: 0,
        timerDeadline: event.atMs + question.timeSeconds * 1000,
        answers: {},
        leaderboard: [],
      };
      return { state: next, effects: [{ type: 'broadcastState', state: next }] };
    }

    case 'playerAnswer': {
      if (state.phase !== 'question') return { state, effects: [] };
      const player = state.players.find((p) => p.id === event.playerId);
      if (!player) {
        return {
          state,
          effects: [
            {
              type: 'answerRejected',
              playerId: event.playerId,
              reason: 'unknown-player',
            },
          ],
        };
      }
      if (event.playerId in state.answers) {
        return {
          state,
          effects: [
            {
              type: 'answerRejected',
              playerId: event.playerId,
              reason: 'already-answered',
            },
          ],
        };
      }
      const question = state.quiz.questions[state.questionIndex];
      if (state.timerDeadline === null || event.atMs > state.timerDeadline) {
        return {
          state,
          effects: [
            {
              type: 'answerRejected',
              playerId: event.playerId,
              reason: 'late',
            },
          ],
        };
      }
      if (
        !Number.isInteger(event.answerIndex) ||
        event.answerIndex < 0 ||
        event.answerIndex >= question.options.length
      ) {
        return {
          state,
          effects: [
            {
              type: 'answerRejected',
              playerId: event.playerId,
              reason: 'invalid-answer',
            },
          ],
        };
      }
      const totalMs = question.timeSeconds * 1000;
      const remainingMs = state.timerDeadline - event.atMs;
      const correct = event.answerIndex === question.correctIndex;
      const points = correct ? Math.round((1000 * remainingMs) / totalMs) : 0;
      const scores: Record<string, number> = {
        ...state.scores,
        [event.playerId]: (state.scores[event.playerId] ?? 0) + points,
      };
      const firstCorrectAtMs = correct
        ? {
            ...state.firstCorrectAtMs,
            [event.playerId]: Math.min(
              state.firstCorrectAtMs[event.playerId] ?? Number.POSITIVE_INFINITY,
              event.atMs,
            ),
          }
        : state.firstCorrectAtMs;
      const answers: Record<string, AnswerRecord> = {
        ...state.answers,
        [event.playerId]: {
          answerIndex: event.answerIndex,
          atMs: event.atMs,
          correct,
          points,
        },
      };
      const next: GameState = { ...state, scores, answers, firstCorrectAtMs };
      return { state: next, effects: [{ type: 'broadcastState', state: next }] };
    }

    case 'reveal': {
      if (state.phase !== 'question') return { state, effects: [] };
      const question = state.quiz.questions[state.questionIndex];
      const results: RevealResult[] = state.players.map((p) => {
        const answer = state.answers[p.id];
        return answer
          ? {
              playerId: p.id,
              answerIndex: answer.answerIndex,
              correct: answer.correct,
              points: answer.points,
            }
          : { playerId: p.id, answerIndex: null, correct: false, points: 0 };
      });
      const reveal: Reveal = {
        questionIndex: state.questionIndex,
        correctIndex: question.correctIndex,
        results,
      };
      const next: GameState = { ...state, phase: 'reveal' };
      return {
        state: next,
        effects: [
          { type: 'broadcastReveal', reveal },
          { type: 'broadcastState', state: next },
        ],
      };
    }

    case 'next': {
      if (state.phase === 'reveal') {
        const next: GameState = {
          ...state,
          phase: 'leaderboard',
          timerDeadline: null,
          answers: {},
          leaderboard: buildLeaderboard(state),
        };
        return { state: next, effects: [{ type: 'broadcastState', state: next }] };
      }
      if (state.phase === 'leaderboard') {
        const nextIndex = state.questionIndex + 1;
        if (nextIndex >= state.quiz.questions.length) {
          const next: GameState = {
            ...state,
            phase: 'podium',
            leaderboard: buildLeaderboard(state),
          };
          return {
            state: next,
            effects: [{ type: 'broadcastState', state: next }],
          };
        }
        const question = state.quiz.questions[nextIndex];
        const next: GameState = {
          ...state,
          phase: 'question',
          questionIndex: nextIndex,
          timerDeadline: event.atMs + question.timeSeconds * 1000,
          answers: {},
          leaderboard: [],
        };
        return { state: next, effects: [{ type: 'broadcastState', state: next }] };
      }
      return { state, effects: [] };
    }

    case 'end': {
      if (state.phase === 'lobby') return { state, effects: [] };
      const next: GameState = {
        ...state,
        phase: 'lobby',
        questionIndex: -1,
        timerDeadline: null,
        scores: {},
        answers: {},
        firstCorrectAtMs: {},
        leaderboard: [],
      };
      return { state: next, effects: [{ type: 'broadcastState', state: next }] };
    }
  }
}

/**
 * Leaderboard ordering: score desc, then earliest correct answer in the game
 * (players who never answered correctly sort last), then a stable ascending
 * player-id fallback so equal results are ordered identically every time.
 */
function buildLeaderboard(state: GameState): string[] {
  return [...state.players]
    .sort((a, b) => {
      const scoreA = state.scores[a.id] ?? 0;
      const scoreB = state.scores[b.id] ?? 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
      const correctA = state.firstCorrectAtMs[a.id] ?? Number.POSITIVE_INFINITY;
      const correctB = state.firstCorrectAtMs[b.id] ?? Number.POSITIVE_INFINITY;
      if (correctA !== correctB) return correctA - correctB;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((p) => p.id);
}
