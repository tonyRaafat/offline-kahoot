// Pure, dependency-free game engine — the single test seam of the project.
//
// `reduce(state, event) -> { state, effects }` is the only entry point.
// All time enters the reducer explicitly via `atMs` fields on events and the
// `timerDeadline` stored in state; nothing here reads the wall clock or does
// any I/O, so scoring is fully deterministic.
//
// Hidden scoring window: the timer deadline stays the scoring boundary
// (points fall to 0 past it), but answers that arrive after it are ACCEPTED
// with 0 points so the question only closes via the reveal. The reveal is
// then auto-triggered as soon as every joined player in the roster has
// answered (see finishQuestion/maybeAutoReveal); the host's manual `reveal`
// stays as the fallback for players who never answer.

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
  /** Podium click-reveal progress: how many ranks (lowest-first: 3rd -> 2nd
   *  -> 1st) have been revealed, capped at min(3, leaderboard.length). Only
   *  advances via `podiumReveal` during the podium phase; reset whenever the
   *  game (re)enters the podium, on `end`, and on `startQuiz`. */
  podiumRevealed: number;
}

export type Event =
  | { type: 'startQuiz'; atMs: number }
  | { type: 'playerJoin'; playerId: string; name: string; color: AvatarColor; atMs: number }
  | { type: 'playerLeave'; playerId: string }
  | { type: 'playerAnswer'; playerId: string; answerIndex: number; atMs: number }
  | { type: 'reveal' }
  | { type: 'next'; atMs: number }
  /** Host click step for the podium ceremony: reveals the next rank. */
  | { type: 'podiumReveal' }
  | { type: 'end' };

export type AnswerRejectReason =
  | 'unknown-player'
  | 'already-answered'
  // 'late' is kept on the wire contract for back-compat (older clients may
  // still map it) but the engine no longer emits it: past-deadline answers
  // are accepted with 0 points so everyone can lock in during the window.
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

/**
 * Kahoot scoring:
 * - Responses in under 0.5s (< 500ms) bypass speed reduction and get max 1000 pts.
 * - Responses between 0.5s and deadline scale linearly from 1000 down to 500 pts:
 *     round((1 - ((responseTime / questionTimer) / 2)) * 1000)
 * - Responses after deadline (hidden window) get 0 pts.
 * - Incorrect answers get 0 pts.
 */
export function calculatePoints(
  correct: boolean,
  responseTimeMs: number,
  totalMs: number,
  isLate: boolean,
): number {
  if (!correct || isLate) return 0;
  if (responseTimeMs < 500) return 1000;
  const ratio = responseTimeMs / totalMs;
  return Math.max(0, Math.round((1 - ratio / 2) * 1000));
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
    podiumRevealed: 0,
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

    case 'playerLeave': {
      if (state.phase !== 'lobby') return { state, effects: [] };
      if (!state.players.some((p) => p.id === event.playerId)) {
        return { state, effects: [] };
      }
      const scores: Record<string, number> = { ...state.scores };
      delete scores[event.playerId];
      const firstCorrectAtMs: Record<string, number> = { ...state.firstCorrectAtMs };
      delete firstCorrectAtMs[event.playerId];
      const answers: Record<string, AnswerRecord> = { ...state.answers };
      delete answers[event.playerId];
      const next: GameState = {
        ...state,
        players: state.players.filter((p) => p.id !== event.playerId),
        scores,
        firstCorrectAtMs,
        answers,
        leaderboard: state.leaderboard.filter((id) => id !== event.playerId),
      };
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
        podiumRevealed: 0,
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
      // Hidden scoring window: past the deadline points fall to 0, but the
      // answer is still accepted so the question can auto-reveal.
      const totalMs = question.timeSeconds * 1000;
      const deadline = state.timerDeadline ?? event.atMs;
      const isLate = event.atMs > deadline;
      const startTimeMs = deadline - totalMs;
      const responseTimeMs = Math.max(0, event.atMs - startTimeMs);
      const correct = event.answerIndex === question.correctIndex;
      const points = calculatePoints(correct, responseTimeMs, totalMs, isLate);
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
      return maybeAutoReveal({ ...state, scores, answers, firstCorrectAtMs });
    }

    case 'reveal': {
      if (state.phase !== 'question') return { state, effects: [] };
      return finishQuestion(state);
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
            // A fresh podium starts fully blank: the host click-reveals the
            // ranks three -> two -> one from here (client sided sync only).
            podiumRevealed: 0,
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

    case 'podiumReveal': {
      // Podium ceremony step: reveal the next rank (lowest-first). Silently
      // ignored outside the podium phase and once fully revealed (capped at
      // the podium size, min(3, leaderboard.length)) — later clicks are no-ops
      // exactly like the other guarded host events.
      if (state.phase !== 'podium') return { state, effects: [] };
      const cap = Math.min(3, state.leaderboard.length);
      if (state.podiumRevealed >= cap) return { state, effects: [] };
      const next: GameState = { ...state, podiumRevealed: state.podiumRevealed + 1 };
      return { state: next, effects: [{ type: 'broadcastState', state: next }] };
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
        podiumRevealed: 0,
      };
      return { state: next, effects: [{ type: 'broadcastState', state: next }] };
    }
  }
}

/**
 * question -> reveal, the single construction shared by the host's manual
 * `reveal` event AND the auto-reveal: reveal payload per player (join order,
 * unanswered = null), phase swap, broadcastReveal + broadcastState.
 */
function finishQuestion(state: GameState): {
  state: GameState;
  effects: Effect[];
} {
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

/** Auto-reveal: as soon as every joined player in the roster has answered the
 *  live question, transition question -> reveal exactly like the manual
 *  `reveal` event (scoring was already applied per answer). "Joined players"
 *  is the engine's roster per playerJoin/playerLeave semantics — a player who
 *  left/disconnected mid-question is still on it, so an absent player keeps
 *  the question open and the host's manual reveal stays the fallback. Guarded
 *  against 0 players and double-reveal (phase check; one answer slot per
 *  player id covers the consistency of one answer per player).
 */
function maybeAutoReveal(next: GameState): { state: GameState; effects: Effect[] } {
  const allAnswered =
    next.phase === 'question' &&
    next.players.length > 0 &&
    next.players.every((p) => p.id in next.answers);
  if (!allAnswered) {
    return { state: next, effects: [{ type: 'broadcastState', state: next }] };
  }
  // The just-answering state is not broadcast separately: the reveal effect
  // carries the exact same scores/answers, so the phase swap IS the update.
  return finishQuestion(next);
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
