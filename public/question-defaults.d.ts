// Ambient types for public/question-defaults.js (browser module, plain JS).
// Kept next to the implementation so src/ tests can import it under NodeNext
// resolution and tsc --noEmit stays clean.
import type { Question } from '../src/engine.js';

export declare const DEFAULT_TIME_SECONDS: number;
export declare function newQuestion(type: Question['type']): Question;
