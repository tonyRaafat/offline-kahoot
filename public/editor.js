// Quiz editor page: talks to the quiz CRUD endpoints only
// (GET /api/quizzes, POST /api/quizzes, GET/PUT/DELETE /api/quizzes/:id).
// Client-side validation mirrors the server's validateQuiz(storage.ts) —
// the server stays authoritative and its error list is displayed verbatim.
import { newQuestion } from '/question-defaults.js';

const viewPick = document.getElementById('view-pick');
const viewEdit = document.getElementById('view-edit');
const quizSelect = document.getElementById('quiz-select');
const newTitleEl = document.getElementById('new-title');
const createButton = document.getElementById('create');
const pickStatus = document.getElementById('pick-status');
const editTitleEl = document.getElementById('edit-title');
const renameButton = document.getElementById('rename');
const deleteButton = document.getElementById('delete');
const backButton = document.getElementById('back');
const questionsEl = document.getElementById('questions');
const addQuestionButton = document.getElementById('add-question');
const saveButton = document.getElementById('save');
const errorsEl = document.getElementById('errors');
const editStatus = document.getElementById('edit-status');

/** The quiz being edited; null while the picker view is shown. */
let currentId = null;
let currentQuiz = null;

/** fetch + JSON with error messages surfaced like the other pages do. */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error ?? `${method} ${path} returned ${res.status}`);
    error.errors = data.errors;
    throw error;
  }
  return data;
}

function showPick(statusText = '') {
  currentId = null;
  currentQuiz = null;
  viewEdit.hidden = true;
  viewPick.hidden = false;
  pickStatus.textContent = statusText;
  void refreshQuizzes();
}

function showEdit(statusText = '') {
  viewPick.hidden = true;
  viewEdit.hidden = false;
  editStatus.textContent = statusText;
  errorsEl.replaceChildren();
}

async function refreshQuizzes() {
  try {
    const quizzes = await api('/api/quizzes');
    const keep = quizSelect.value;
    quizSelect.replaceChildren(
      ...quizzes.map((quiz) => {
        const option = document.createElement('option');
        option.value = quiz.id;
        option.textContent = `${quiz.title} (${quiz.questionCount} questions)`;
        return option;
      }),
    );
    if (keep && quizzes.some((quiz) => quiz.id === keep)) quizSelect.value = keep;
    else quizSelect.selectedIndex = 0;
  } catch (err) {
    pickStatus.textContent = `Failed to list quizzes: ${err.message}`;
  }
}

async function openQuiz(id) {
  try {
    currentQuiz = await api(`/api/quizzes/${encodeURIComponent(id)}`);
  } catch (err) {
    showPick(`Failed to load quiz: ${err.message}`);
    return;
  }
  currentId = id;
  editTitleEl.value = currentQuiz.title;
  renderQuestions();
  showEdit();
}

// ---- Question cards ---------------------------------------------------------

function renderQuestions() {
  questionsEl.replaceChildren(
    ...currentQuiz.questions.map((question, index) => questionCard(question, index)),
  );
}

/** One editable card per question; edits write straight into the question. */
function questionCard(question, index) {
  const card = document.createElement('section');
  card.className = 'question-card';

  const heading = document.createElement('h3');
  heading.textContent = `Question ${index + 1}`;
  const removeQuestion = document.createElement('button');
  removeQuestion.className = 'remove-question';
  removeQuestion.textContent = '✕';
  removeQuestion.title = 'Remove this question';
  removeQuestion.addEventListener('click', () => {
    currentQuiz.questions.splice(index, 1);
    renderQuestions();
  });
  heading.append(' ', removeQuestion);
  card.append(heading);

  const promptLabel = document.createElement('label');
  promptLabel.className = 'field-label';
  promptLabel.textContent = 'Prompt';
  const prompt = document.createElement('input');
  prompt.className = 'ed-input';
  prompt.value = question.prompt;
  prompt.addEventListener('input', () => {
    question.prompt = prompt.value;
  });
  promptLabel.append(prompt);
  card.append(promptLabel);

  const settingsRow = document.createElement('p');
  const typeLabel = document.createElement('label');
  typeLabel.className = 'field-label';
  typeLabel.textContent = 'Type';
  const type = document.createElement('select');
  type.className = 'ed-input';
  for (const value of ['multiple-choice', 'true-false']) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === 'true-false' ? 'true-false' : 'multiple-choice';
    option.selected = question.type === value;
    type.append(option);
  }
  type.addEventListener('change', () => {
    // Reset to the fresh default for the newly selected type; keep the
    // prompt + timer the author already typed.
    const fresh = newQuestion(type.value);
    question.type = fresh.type;
    question.options = fresh.options;
    question.correctIndex = fresh.correctIndex;
    renderQuestions();
  });
  typeLabel.append(type);
  settingsRow.append(typeLabel);

  const timerLabel = document.createElement('label');
  timerLabel.className = 'field-label';
  timerLabel.textContent = 'Timer (seconds)';
  const timer = document.createElement('input');
  timer.className = 'ed-input short';
  timer.type = 'number';
  timer.min = '1';
  timer.step = '1';
  timer.value = String(question.timeSeconds);
  timer.addEventListener('input', () => {
    const seconds = Number(timer.value);
    question.timeSeconds = Number.isFinite(seconds) ? seconds : timer.value;
  });
  timerLabel.append(timer);
  settingsRow.append(timerLabel);
  card.append(settingsRow);

  const correctLabel = document.createElement('span');
  correctLabel.className = 'field-label';
  correctLabel.textContent =
    question.type === 'true-false' ? 'Correct answer' : 'Options (first row = correct via radio)';
  card.append(correctLabel);

  question.options.forEach((_, optionIndex) => {
    card.append(optionRow(question, index, optionIndex));
  });

  if (question.type === 'multiple-choice' && question.options.length < 4) {
    const addOption = document.createElement('button');
    addOption.className = 'player-button';
    addOption.textContent = '＋ Add option';
    addOption.addEventListener('click', () => {
      question.options.push('');
      renderQuestions();
    });
    card.append(addOption);
  }
  return card;
}

function optionRow(question, questionIndex, optionIndex) {
  const row = document.createElement('p');
  row.className = 'option-row';

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = `correct-${questionIndex}`;
  radio.checked = question.correctIndex === optionIndex;
  radio.addEventListener('change', () => {
    if (radio.checked) question.correctIndex = optionIndex;
  });
  row.append(radio);

  if (question.type === 'true-false') {
    const optionText = document.createElement('strong');
    optionText.textContent = question.options[optionIndex];
    row.append(optionText);
  } else {
    const optionText = document.createElement('input');
    optionText.className = 'ed-input';
    optionText.value = question.options[optionIndex];
    optionText.placeholder = `Option ${optionIndex + 1}`;
    optionText.addEventListener('input', () => {
      question.options[optionIndex] = optionText.value;
    });
    row.append(optionText);
  }

  if (question.type === 'multiple-choice' && question.options.length > 2) {
    const removeOption = document.createElement('button');
    removeOption.className = 'remove-option';
    removeOption.textContent = '✕';
    removeOption.title = 'Remove this option';
    removeOption.addEventListener('click', () => {
      question.options.splice(optionIndex, 1);
      if (question.correctIndex === optionIndex) question.correctIndex = 0;
      else if (question.correctIndex > optionIndex) question.correctIndex--;
      renderQuestions();
    });
    row.append(removeOption);
  }
  return row;
}

// ---- Build + validate + save ------------------------------------------------

/**
 * Client-side mirror of validateQuiz in src/storage.ts: non-empty prompt,
 * positive timer, 2–4 non-empty options, correct index inside range.
 */
function validationErrors(quiz) {
  const errors = [];
  if (typeof quiz.title !== 'string' || quiz.title.trim() === '') {
    errors.push('title: must be a non-empty string');
  }
  quiz.questions.forEach((question, index) => {
    const n = index + 1;
    if (question.prompt.trim() === '') {
      errors.push(`Question ${n}: prompt must be non-empty`);
    }
    if (typeof question.timeSeconds !== 'number' || !(question.timeSeconds > 0)) {
      errors.push(`Question ${n}: timer must be a positive number of seconds`);
    }
    const nonEmpty = question.options.filter((option) => option.trim() !== '');
    if (question.options.length < 2 || question.options.length > 4 || nonEmpty.length !== question.options.length) {
      errors.push(`Question ${n}: needs 2–4 non-empty options`);
    }
    if (
      !(question.correctIndex >= 0 && question.correctIndex < question.options.length)
    ) {
      errors.push(`Question ${n}: needs a selected correct answer`);
    }
  });
  return errors;
}

function showErrors(messages) {
  errorsEl.replaceChildren(
    ...messages.map((message) => {
      const li = document.createElement('li');
      li.textContent = message;
      return li;
    }),
  );
}

async function saveQuiz() {
  const quiz = { title: editTitleEl.value, questions: currentQuiz.questions };
  const clientErrors = validationErrors(quiz);
  if (clientErrors.length > 0) {
    showErrors(clientErrors);
    editStatus.textContent = '';
    return;
  }
  saveButton.disabled = true;
  try {
    await api(`/api/quizzes/${encodeURIComponent(currentId)}`, { method: 'PUT', body: quiz });
    currentQuiz.title = quiz.title;
    showErrors([]);
    editStatus.textContent = 'Saved. The host page picks this up on its next reload.';
    await refreshQuizzes();
  } catch (err) {
    showErrors(err.errors ?? [err.message]);
    editStatus.textContent = '';
  } finally {
    saveButton.disabled = false;
  }
}

renameButton.addEventListener('click', async () => {
  const title = editTitleEl.value;
  if (title.trim() === '') {
    showErrors(['title: must be a non-empty string']);
    editStatus.textContent = '';
    return;
  }
  try {
    await api(`/api/quizzes/${encodeURIComponent(currentId)}`, {
      method: 'PUT',
      body: { title, questions: currentQuiz.questions },
    });
    editStatus.textContent = `Renamed to "${title}"`;
    editTitleEl.value = title;
    await refreshQuizzes();
  } catch (err) {
    showErrors(err.errors ?? [err.message]);
    editStatus.textContent = '';
  }
});

deleteButton.addEventListener('click', async () => {
  if (!confirm(`Delete quiz "${currentQuiz.title}"? This cannot be undone.`)) return;
  try {
    await api(`/api/quizzes/${encodeURIComponent(currentId)}`, { method: 'DELETE' });
    showPick(`Deleted quiz "${currentQuiz.title}"`);
  } catch (err) {
    showErrors([err.message]);
    editStatus.textContent = '';
  }
});

backButton.addEventListener('click', () => showPick());

createButton.addEventListener('click', async () => {
  const title = newTitleEl.value;
  if (title.trim() === '') {
    pickStatus.textContent = 'Give the new quiz a title first.';
    return;
  }
  createButton.disabled = true;
  try {
    const created = await api('/api/quizzes', { method: 'POST', body: { title } });
    newTitleEl.value = '';
    await refreshQuizzes();
    quizSelect.value = created.id;
    await openQuiz(created.id);
  } catch (err) {
    pickStatus.textContent = `Create failed: ${err.message}`;
  } finally {
    createButton.disabled = false;
  }
});

quizSelect.addEventListener('change', () => {
  if (quizSelect.value) void openQuiz(quizSelect.value);
});

addQuestionButton.addEventListener('click', () => {
  currentQuiz.questions.push(newQuestion('multiple-choice'));
  renderQuestions();
});

saveButton.addEventListener('click', saveQuiz);

showPick();
