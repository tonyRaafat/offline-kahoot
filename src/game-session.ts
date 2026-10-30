// The single authoritative GameState for this server process.
//
// Everything mutates through reduce() so the engine stays the one pure seam
// and every Effect the engine derives is surfaced to the socket layer.

import { createInitialGame, reduce, type Effect, type Event, type GameState, type Quiz } from './engine.js';

export class GameSession {
  private state: GameState;

  constructor(quiz: Quiz) {
    this.state = createInitialGame(quiz);
  }

  get current(): GameState {
    return this.state;
  }

  /** Applies an event with reduce() and returns the effects to broadcast. */
  dispatch(event: Event): Effect[] {
    const { state, effects } = reduce(this.state, event);
    this.state = state;
    return effects;
  }
}
