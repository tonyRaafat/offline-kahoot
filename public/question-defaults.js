// Default shape for a NEW question in the quiz editor.
// Pure and dependency-free so it can load both in the browser (editor.js
// imports it as an ES module) and in node (Vitest imports it directly).

/** Per-question timer default the editor starts every question with. */
export const DEFAULT_TIME_SECONDS = 20;

/**
 * Builds a fresh question of the given type. True/false is stored as a
 * 2-option question with fixed options ["True","False"] (CONTEXT.md); the
 * correct index starts on the first option.
 */
export function newQuestion(type) {
  if (type === 'true-false') {
    return {
      prompt: '',
      type: 'true-false',
      timeSeconds: DEFAULT_TIME_SECONDS,
      options: ['True', 'False'],
      correctIndex: 0,
    };
  }
  return {
    prompt: '',
    type: 'multiple-choice',
    timeSeconds: DEFAULT_TIME_SECONDS,
    options: ['', ''],
    correctIndex: 0,
  };
}
