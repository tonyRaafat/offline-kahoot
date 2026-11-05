// Quiz editor page: talks to the quiz CRUD endpoints only
// (GET /api/quizzes, POST /api/quizzes, GET/PUT/DELETE /api/quizzes/:id).
// Client-side validation mirrors the server's validateQuiz(storage.ts) —
// the server stays authoritative and its error list is displayed verbatim.
import { newQuestion } from '/question-defaults.js';

// i18n.js (plain script, loaded before this module) provides the globals.
const { t, set, clear, onChange } = window.I18n;

const viewPick = document.getElementById('view-pick');
const viewEdit = document.getElementById('view-edit');
const quizSelect = document.getElementById('quiz-select');
const editorEmptyEl = document.getElementById('editor-empty');
const newTitleEl = document.getElementById('new-title');
const createButton = document.getElementById('create');
const pickStatus = document.getElementById('pick-status');
const editTitleEl = document.getElementById('edit-title');
const renameButton = document.getElementById('rename');
const deleteButton = document.getElementById('delete');
const backButton = document.getElementById('back');
const questionsEl = document.getElementById('questions');
// The grid-gap container (issue 01): cards share the list's gap instead of
// carrying their own margins.
questionsEl.classList.add('questions-list');
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

function showPick() {
  currentId = null;
  currentQuiz = null;
  viewEdit.hidden = true;
  viewPick.hidden = false;
  void refreshQuizzes();
}

function showEdit() {
  viewPick.hidden = true;
  viewEdit.hidden = false;
  errorsEl.replaceChildren();
}

async function refreshQuizzes() {
  try {
    const quizzes = await api('/api/quizzes');
    // The picker's empty state was wired up by the paid-review fix: show it
    // when the fetched list is genuinely empty (mirrors the dashboard's).
    editorEmptyEl.hidden = quizzes.length > 0;
    const keep = quizSelect.value;
    quizSelect.replaceChildren(
      ...quizzes.map((quiz) => {
        const option = document.createElement('option');
        option.value = quiz.id;
        option.textContent = t('common.quizCount', { title: quiz.title, count: quiz.questionCount });
        return option;
      }),
    );
    if (keep && quizzes.some((quiz) => quiz.id === keep)) quizSelect.value = keep;
    else quizSelect.selectedIndex = 0;
  } catch (err) {
    set(pickStatus, 'editor.failedList', { detail: err.message });
  }
}

async function openQuiz(id) {
  try {
    currentQuiz = await api(`/api/quizzes/${encodeURIComponent(id)}`);
  } catch (err) {
    showPick();
    set(pickStatus, 'editor.failedLoad', { detail: err.message });
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
  heading.textContent = t('editor.question', { number: index + 1 });
  const removeQuestion = document.createElement('button');
  removeQuestion.className = 'remove-question';
  removeQuestion.textContent = '✕';
  removeQuestion.title = t('editor.removeQuestion');
  removeQuestion.addEventListener('click', () => {
    currentQuiz.questions.splice(index, 1);
    renderQuestions();
  });
  heading.append(' ', removeQuestion);
  card.append(heading);

  const promptLabel = document.createElement('label');
  promptLabel.className = 'field-label';
  promptLabel.textContent = t('editor.prompt');
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
  typeLabel.textContent = t('editor.type');
  const type = document.createElement('select');
  type.className = 'ed-input';
  for (const value of ['multiple-choice', 'true-false']) {
    const option = document.createElement('option');
    option.value = value;
    // The <option> text is localized chrome; the stored value keeps the
    // English type identifier (quiz content stays untranslated).
    option.textContent = value === 'true-false' ? t('editor.typeTrueFalse') : t('editor.typeMultiple');
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
  timerLabel.textContent = t('editor.timer');
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
    question.type === 'true-false' ? t('editor.correctAnswer') : t('editor.optionsCorrect');
  card.append(correctLabel);

  question.options.forEach((_, optionIndex) => {
    card.append(optionRow(question, index, optionIndex));
  });

  if (question.type === 'multiple-choice' && question.options.length < 4) {
    const addOption = document.createElement('button');
    addOption.className = 'player-button';
    addOption.textContent = t('editor.addOption');
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
    optionText.placeholder = t('editor.option', { number: optionIndex + 1 });
    optionText.addEventListener('input', () => {
      question.options[optionIndex] = optionText.value;
    });
    row.append(optionText);
  }

  if (question.type === 'multiple-choice' && question.options.length > 2) {
    const removeOption = document.createElement('button');
    removeOption.className = 'remove-option';
    removeOption.textContent = '✕';
    removeOption.title = t('editor.removeOption');
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
    errors.push(t('editor.err.title'));
  }
  quiz.questions.forEach((question, index) => {
    const n = index + 1;
    if (question.prompt.trim() === '') {
      errors.push(t('editor.err.prompt', { number: n }));
    }
    if (typeof question.timeSeconds !== 'number' || !(question.timeSeconds > 0)) {
      errors.push(t('editor.err.timer', { number: n }));
    }
    const nonEmpty = question.options.filter((option) => option.trim() !== '');
    if (question.options.length < 2 || question.options.length > 4 || nonEmpty.length !== question.options.length) {
      errors.push(t('editor.err.options', { number: n }));
    }
    if (
      !(question.correctIndex >= 0 && question.correctIndex < question.options.length)
    ) {
      errors.push(t('editor.err.correct', { number: n }));
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
    clear(editStatus);
    return;
  }
  saveButton.disabled = true;
  try {
    await api(`/api/quizzes/${encodeURIComponent(currentId)}`, { method: 'PUT', body: quiz });
    currentQuiz.title = quiz.title;
    showErrors([]);
    set(editStatus, 'editor.saved');
    await refreshQuizzes();
  } catch (err) {
    showErrors(err.errors ?? [err.message]);
    clear(editStatus);
  } finally {
    saveButton.disabled = false;
  }
}

renameButton.addEventListener('click', async () => {
  const title = editTitleEl.value;
  if (title.trim() === '') {
    showErrors([t('editor.err.title')]);
    clear(editStatus);
    return;
  }
  try {
    await api(`/api/quizzes/${encodeURIComponent(currentId)}`, {
      method: 'PUT',
      body: { title, questions: currentQuiz.questions },
    });
    set(editStatus, 'editor.renamed', { title });
    editTitleEl.value = title;
    await refreshQuizzes();
  } catch (err) {
    showErrors(err.errors ?? [err.message]);
    clear(editStatus);
  }
});

deleteButton.addEventListener('click', async () => {
  if (!confirm(t('editor.deleteConfirm', { title: currentQuiz.title }))) return;
  try {
    await api(`/api/quizzes/${encodeURIComponent(currentId)}`, { method: 'DELETE' });
    showPick();
    set(pickStatus, 'editor.deleted', { title: currentQuiz.title });
  } catch (err) {
    showErrors([err.message]);
    clear(editStatus);
  }
});

backButton.addEventListener('click', () => showPick());

createButton.addEventListener('click', async () => {
  const title = newTitleEl.value;
  if (title.trim() === '') {
    set(pickStatus, 'editor.giveTitle');
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
    set(pickStatus, 'editor.createFailed', { detail: err.message });
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

// Language switch: static data-i18n strings are re-applied by i18n.js itself;
// re-render what this page generates from JS (question cards, quiz options).
onChange(() => {
  if (currentQuiz) renderQuestions();
  void refreshQuizzes();
});

showPick();

// Honor the dashboard's deep link (admin-dashboard issue 04): /editor?id=<quiz>
// opens straight into that quiz instead of the picker view.
const requestedId = new URLSearchParams(window.location.search).get('id');
if (requestedId) void openQuiz(requestedId);
