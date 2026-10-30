// In-memory sample quiz for ticket 04: the playable quiz until the
// editor/loading ticket supplies data/quizzes/*.json. True/false questions
// are two-option multiple-choice internally ('True'/'False').
import type { Quiz } from './engine.js';

export const sampleQuiz: Quiz = {
  title: 'Pub Quiz Warm-Up',
  questions: [
    {
      prompt: 'Which planet is known as the Red Planet?',
      type: 'multiple-choice',
      timeSeconds: 20,
      options: ['Venus', 'Mars', 'Jupiter', 'Mercury'],
      correctIndex: 1,
    },
    {
      prompt: 'The Great Wall of China is visible from space with the naked eye.',
      type: 'true-false',
      timeSeconds: 15,
      options: ['True', 'False'],
      correctIndex: 1,
    },
    {
      prompt: 'How many continents are there on Earth?',
      type: 'multiple-choice',
      timeSeconds: 20,
      options: ['5', '6', '7', '8'],
      correctIndex: 2,
    },
    {
      prompt: 'Lightning can be hotter than the surface of the Sun.',
      type: 'true-false',
      timeSeconds: 15,
      options: ['True', 'False'],
      correctIndex: 0,
    },
  ],
};
