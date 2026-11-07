// Public projection of GameState sent to all clients.
//
// Host and players both receive this; it exposes only what the UI needs
// (phase, quiz title, roster, scores, leaderboard, and — during the question
// phase — the sanitized current question) and never leaks quiz internals
// (questions, correct answers) or current-round answer records.

import type { GameState, Phase } from './engine.js';
import type { AvatarColor } from './avatar-colors.js';

export interface PlayerView {
  id: string;
  name: string;
  color: AvatarColor;
}

export interface CurrentQuestionView {
  questionIndex: number;
  prompt: string;
  options: string[];
  timeSeconds: number;
  timerDeadline: number;
  /** Answered-progress for the host "Answered X/Y" indicator: how many
   *  accepted answers the live question has and how many players are on the
   *  roster. Counts only — no answer records, no correctIndex leak. */
  answeredCount: number;
  playerCount: number;
}

export interface StateView {
  phase: Phase;
  quizTitle: string;
  players: PlayerView[];
  scores: Record<string, number>;
  /** Player ids score desc / early-correct tiebreak / id asc, from the engine. */
  leaderboard: string[];
  /** Podium click-reveal progress (ranks revealed lowest-first). Meaningful
   *  during the podium phase only; host and players get the SAME value so the
   *  reveal step stays in sync everywhere. No ranks/answers leak — the
   *  ordering itself is only 'how many are shown'. */
  podiumRevealed: number;
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
            answeredCount: Object.keys(state.answers).length,
            playerCount: state.players.length,
          };
        })()
      : null;
  return {
    phase: state.phase,
    quizTitle: state.quiz.title,
    players: state.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    scores: { ...state.scores },
    leaderboard: [...state.leaderboard],
    podiumRevealed: state.podiumRevealed,
    currentQuestion,
  };
}
