// Public projection of GameState sent to all clients.
//
// Host and players both receive this; it exposes only what the UI needs
// (phase, quiz title, roster, scores) and never leaks quiz internals
// (questions, correct answers) or current-round answer records.

import type { GameState, Phase } from './engine.js';

export interface PlayerView {
  id: string;
  name: string;
}

export interface StateView {
  phase: Phase;
  quizTitle: string;
  players: PlayerView[];
  scores: Record<string, number>;
}

export function stateView(state: GameState): StateView {
  return {
    phase: state.phase,
    quizTitle: state.quiz.title,
    players: state.players.map((p) => ({ id: p.id, name: p.name })),
    scores: { ...state.scores },
  };
}
