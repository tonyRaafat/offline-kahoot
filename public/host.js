// Host gameplay page: this socket claims the host role once per connection,
// drives the game (hostStart / reveal / next) and renders every phase from the
// pushed StateView plus the `reveal` payloads. The lobby markup keeps serving
// the join URL / PIN / QR / roster flow.

const showStatus = async () => {
  const status = document.getElementById('status');
  const joinUrl = document.getElementById('join-url');
  const pin = document.getElementById('pin');
  const qr = document.getElementById('qr');

  try {
    const res = await fetch('/api/session');
    if (!res.ok) throw new Error(`session API returned ${res.status}`);
    const session = await res.json();

    joinUrl.textContent = session.joinUrl;
    joinUrl.href = session.joinUrl;
    pin.textContent = session.pin;
    qr.src = session.qrDataUrl;
    qr.hidden = false;
    status.textContent = '';
  } catch (err) {
    status.textContent = `host page failed to load session: ${err.message}`;
  }
};

showStatus();

const cards = {
  lobby: document.getElementById('view-lobby'),
  question: document.getElementById('view-question'),
  reveal: document.getElementById('view-reveal'),
  leaderboard: document.getElementById('view-leaderboard'),
  podium: document.getElementById('view-podium'),
};

const rosterEl = document.getElementById('players');
const playerCountEl = document.getElementById('player-count');
const startButton = document.getElementById('start');
const quizTitleEl = document.getElementById('quiz-title');
const questionNumberEl = document.getElementById('question-number');
const questionPromptEl = document.getElementById('question-prompt');
const questionOptionsEl = document.getElementById('question-options');
const countdownEl = document.getElementById('countdown');
const revealButton = document.getElementById('reveal');
const nextButton = document.getElementById('next');
const leaderboardNextButton = document.getElementById('leaderboard-next');
const correctAnswerEl = document.getElementById('correct-answer');
const correctPlayersEl = document.getElementById('correct-players');
const leaderboardEl = document.getElementById('leaderboard');
const podiumEl = document.getElementById('podium');

const socket = io();

let latestView = null; // last `state` StateView
let revealData = null; // last `reveal` payload
let lastQuestion = null; // CurrentQuestionView shown before the reveal
let countdownTimer = null;

function show(phase) {
  for (const [name, card] of Object.entries(cards)) card.hidden = name !== phase;
}

function stopCountdown() {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  countdownEl.textContent = '';
}

function startCountdown(timerDeadline) {
  stopCountdown();
  const tick = () => {
    countdownEl.textContent = String(
      Math.max(0, Math.ceil((timerDeadline - Date.now()) / 1000)),
    );
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

/** Player-id -> name lookup from the roster within the current StateView. */
function playerNames(view) {
  const names = new Map();
  for (const player of view.players) names.set(player.id, player.name);
  return names;
}

function nameOf(names, playerId, fallback = '?') {
  return names.get(playerId) ?? fallback;
}

function renderLobby(view) {
  stopCountdown();
  show('lobby');
  playerCountEl.textContent = view.players.length > 0 ? ` (${view.players.length})` : '';
  rosterEl.replaceChildren(
    ...view.players.map((player) => {
      const li = document.createElement('li');
      li.textContent = player.name;
      return li;
    }),
  );
  startButton.disabled = false;
}

function renderQuestion(view) {
  const question = view.currentQuestion;
  if (!question) return;
  lastQuestion = question;
  show('question');
  quizTitleEl.textContent = view.quizTitle;
  questionNumberEl.textContent = String(question.questionIndex + 1);
  questionPromptEl.textContent = question.prompt;
  questionOptionsEl.replaceChildren(
    ...question.options.map((option) => {
      const li = document.createElement('li');
      li.textContent = option;
      return li;
    }),
  );
  startCountdown(question.timerDeadline);
}

function renderReveal(view) {
  if (!revealData) return;
  show('reveal');
  correctAnswerEl.textContent =
    lastQuestion?.options[revealData.correctIndex] ?? `Option ${revealData.correctIndex + 1}`;
  const names = playerNames(view);
  correctPlayersEl.replaceChildren(
    ...revealData.results
      .filter((result) => result.correct)
      .map((result) => {
        const li = document.createElement('li');
        li.textContent = nameOf(names, result.playerId);
        return li;
      }),
  );
}

function renderScoredList(el, view, names, limit = Infinity) {
  el.replaceChildren(
    ...view.leaderboard.slice(0, limit).map((playerId) => {
      const li = document.createElement('li');
      li.textContent = `${nameOf(names, playerId)} — ${view.scores[playerId] ?? 0} pts`;
      return li;
    }),
  );
}

socket.on('connect', () => {
  socket.emit('host');
});

socket.on('state', (view) => {
  latestView = view;
  switch (view.phase) {
    case 'lobby':
      renderLobby(view);
      break;
    case 'question':
      renderQuestion(view);
      break;
    case 'reveal':
      stopCountdown();
      renderReveal(view);
      break;
    case 'leaderboard':
      stopCountdown();
      show('leaderboard');
      renderScoredList(leaderboardEl, view, playerNames(view));
      break;
    case 'podium':
      stopCountdown();
      show('podium');
      renderScoredList(podiumEl, view, playerNames(view), 3);
      break;
  }
});

socket.on('reveal', (payload) => {
  revealData = payload;
  if (latestView?.phase === 'reveal') renderReveal(latestView);
});

startButton.addEventListener('click', () => {
  startButton.disabled = true;
  socket.emit('hostStart');
});

// ---- Host quiz picker: list / select / import / export ---------------------

const quizSelect = document.getElementById('quiz-select');
const quizExportLink = document.getElementById('quiz-export');
const quizImportInput = document.getElementById('quiz-import');
const quizStatus = document.getElementById('quiz-status');

let quizzes = [];

async function refreshQuizzes() {
  try {
    const res = await fetch('/api/quizzes');
    if (!res.ok) throw new Error(`quizzes API returned ${res.status}`);
    quizzes = await res.json();
    quizSelect.replaceChildren(
      ...quizzes.map((quiz) => {
        const option = document.createElement('option');
        option.value = quiz.id;
        option.textContent = `${quiz.title} (${quiz.questionCount} questions)`;
        return option;
      }),
    );
    quizSelect.selectedIndex = 0;
  } catch (err) {
    quizStatus.textContent = `Failed to list quizzes: ${err.message}`;
  }
}

const selectedQuiz = () => quizzes.find((quiz) => quiz.id === quizSelect.value);

// Selecting a quiz loads it into the live lobby; already-joined players are
// kept by the server, and the next "state" broadcast reflects the new quiz.
quizSelect.addEventListener('change', async () => {
  const quiz = selectedQuiz();
  if (!quiz) return;
  quizExportLink.hidden = true;
  try {
    const res = await fetch('/api/game/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quizId: quiz.id }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `quiz API returned ${res.status}`);
    quizStatus.textContent = `Loaded quiz: ${body.title} (${body.questionCount} questions)`;
    if (selectedQuiz()) {
      quizExportLink.href = `/api/quizzes/${encodeURIComponent(quiz.id)}/export`;
      quizExportLink.textContent = `Export "${quiz.title}"`;
      quizExportLink.hidden = false;
    }
  } catch (err) {
    quizStatus.textContent = `Failed to load quiz: ${err.message}`;
  }
});

quizImportInput.addEventListener('change', async () => {
  const file = quizImportInput.files?.[0];
  quizImportInput.value = '';
  if (!file) return;
  try {
    const res = await fetch('/api/quizzes/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await file.text(),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.errors?.join('; ') ?? body.error ?? `import API returned ${res.status}`);
    }
    quizStatus.textContent = `Imported quiz: ${body.title}`;
    await refreshQuizzes();
  } catch (err) {
    quizStatus.textContent = `Import failed: ${err.message}`;
  }
});

refreshQuizzes();

revealButton.addEventListener('click', () => {
  revealButton.disabled = true;
  socket.emit('reveal');
});

nextButton.addEventListener('click', () => {
  socket.emit('next');
});

leaderboardNextButton.addEventListener('click', () => {
  socket.emit('next');
});
