// Public projection of GameState sent to all clients.
//
// Host and players both receive this; it exposes only what the UI needs
// (phase, quiz title, roster, scores, leaderboard, and — during the question
// phase — the sanitized current question) and never leaks quiz internals
// (questions, correct answers) or current-round answer records.

import type { GameState, Phase } from './engine.js';

export interface PlayerView {
  id: string;
  name: string;
}

export interface CurrentQuestionView {
  questionIndex: number;
  prompt: string;
  options: string[];
  timeSeconds: number;
  timerDeadline: number;
}

export interface StateView {
  phase: Phase;
  quizTitle: string;
  players: PlayerView[];
  scores: Record<string, number>;
  /** Player ids score desc / early-correct tiebreak / id asc, from the engine. */
  leaderboard: string[];
  /** Server-sanitized snapshot of the live question; null in every other phase. */
  currentQuestion: CurrentQuestionView | null;
}

export function stateView(state: GameState): StateView {
  const currentQuestion: CurrentQuestionView | null =
    state.phase === 'question' && state.timerDeadline !== null
      ? (() => {
          // The raw QuizQuestion carries correctIndex; the view must not.
          const q = state.quiz.questions[state.questionIndex];
          return {
            questionIndex: state.questionIndex,
            prompt: q.prompt,
            options: [...q.options],
            timeSeconds: q.timeSeconds,
            timerDeadline: state.timerDeadline,
          };
        })()
      : null;
  return {
    phase: state.phase,
    quizTitle: state.quiz.title,
    players: state.players.map((p) => ({ id: p.id, name: p.name })),
    scores: { ...state.scores },
    leaderboard: [...state.leaderboard],
    currentQuestion,
  };
}
