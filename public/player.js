// Player gameplay page: keep the join/resume flow, then render every phase the
// server pushes through StateView — question (tap to answer), reveal (correct/
// wrong + points), leaderboard and podium — plus the answerRejected reasons.

const ID_KEY = 'offline-kahoot:playerId';
const NAME_MAX_LEN = 20; // must match src/join.ts NAME_MAX_LEN
const PIN_DIGITS = /^\d{6}$/;

const cards = {
  lobby: document.getElementById('lobby'),
  question: document.getElementById('question'),
  reveal: document.getElementById('reveal'),
  leaderboard: document.getElementById('leaderboard'),
  podium: document.getElementById('podium'),
};

const entering = document.getElementById('entering');
const status = document.getElementById('status');
const pinInput = document.getElementById('pin');
const nameInput = document.getElementById('name');
const joinButton = document.getElementById('join');
const finalName = document.getElementById('final-name');
const waiting = document.getElementById('waiting');

const questionNumberEl = document.getElementById('question-number');
const questionPromptEl = document.getElementById('question-prompt');
const optionsEl = document.getElementById('options');
const countdownEl = document.getElementById('countdown');
const answerStatus = document.getElementById('answer-status');
const resultTitle = document.getElementById('result-title');
const resultPoints = document.getElementById('result-points');
const correctAnswerEl = document.getElementById('correct-answer');
const rankEls = {
  leaderboard: document.getElementById('rank-leaderboard'),
  podium: document.getElementById('rank-podium'),
};
const scoreEls = {
  leaderboard: document.getElementById('score-leaderboard'),
  podium: document.getElementById('score-podium'),
};

const socket = io();

// Connection diagnostics: surface socket.io transport problems on screen so a
// phone that can't reach the server shows *why* it's stuck instead of silently
// spinning, and mirror every event to the console for debugging.
socket.on('connect', () => {
  console.log('[player] socket connected', socket.id);
});
socket.on('connect_error', (err) => {
  console.error('[player] connect_error', err?.message ?? err);
  status.textContent =
    'Cannot reach the game server. Are you on the same Wi-Fi as the host?';
});
socket.on('connect_timeout', () => {
  console.error('[player] connect_timeout');
  status.textContent = 'Connection timed out — is the host laptop on and on the same Wi-Fi?';
});
socket.on('reconnect_attempt', (attempt) => {
  console.log('[player] reconnect_attempt', attempt);
});
socket.on('reconnect_failed', () => {
  console.error('[player] reconnect_failed');
  status.textContent = 'Lost connection to the game server.';
});

/** PIN + nickname of the current join attempt; re-emitted on every (re)connect. */
let credentials = null;
// Guards against double-joining across the click handler and reconnects:
// reset on disconnect so every fresh connection sends exactly one join.
let sentThisConnection = false;

// Gameplay state.
let myId = null; // assigned playerId from `joined`
let phase = 'lobby'; // latest StateView phase
let latestView = null; // last `state` StateView
let shownQuestionIndex = null; // question index currently on screen
let lastQuestion = null; // CurrentQuestionView of the shown question
let submitted = false; // one answer per question
let revealData = null; // last `reveal` payload
let countdownTimer = null;

function show(name) {
  entering.hidden = true;
  for (const [key, card] of Object.entries(cards)) card.hidden = key !== name;
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

function showLobby() {
  stopCountdown();
  show('lobby');
}

function renderQuestion(question, view) {
  lastQuestion = question;
  shownQuestionIndex = question.questionIndex;
  submitted = false;
  stopCountdown();
  show('question');
  questionNumberEl.textContent = String(question.questionIndex + 1);
  questionPromptEl.textContent = question.prompt;
  answerStatus.textContent = '';
  optionsEl.replaceChildren(
    ...question.options.map((option, answerIndex) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.className = 'answer';
      button.type = 'button';
      button.textContent = option;
      button.addEventListener('click', () => submitAnswer(answerIndex, button));
      li.append(button);
      return li;
    }),
  );
  startCountdown(question.timerDeadline);
}

function submitAnswer(answerIndex, button) {
  if (submitted) return;
  submitted = true;
  for (const other of optionsEl.querySelectorAll('button')) other.disabled = true;
  answerStatus.textContent = 'Answer locked in!';
  socket.emit('answer', { answerIndex });
}

function renderResult() {
  if (!revealData) return;
  stopCountdown();
  show('reveal');
  const mine = revealData.results.find((result) => result.playerId === myId);
  const correct = mine?.correct ?? false;
  resultTitle.textContent = correct ? 'Correct!' : 'Incorrect';
  resultTitle.classList.toggle('correct', correct);
  resultTitle.classList.toggle('wrong', !correct);
  resultPoints.textContent = `${mine?.points ?? 0} pts`;
  correctAnswerEl.textContent =
    lastQuestion?.options[revealData.correctIndex] !== undefined
      ? `Correct answer: ${lastQuestion.options[revealData.correctIndex]}`
      : '';
}

function renderStandings(view, name) {
  stopCountdown();
  show(name);
  const rank = view.leaderboard.indexOf(myId);
  rankEls[name].textContent =
    rank >= 0 ? `You're #${rank + 1} of ${view.leaderboard.length}` : 'Waiting for standings…';
  scoreEls[name].textContent = `${view.scores[myId] ?? 0} pts`;
}

function rejectText(reason) {
  switch (reason) {
    case 'late':
      return 'Too late — answers for this question are closed';
    case 'already-answered':
      return 'Already answered for this question';
    case 'unknown-player':
      return 'Cannot submit — connection lost your seat';
    case 'invalid-answer':
      return 'That answer was not valid';
    default:
      return 'Answer rejected';
  }
}

function errorText(reason) {
  switch (reason) {
    case 'bad-pin':
      return 'Wrong game PIN — check the host screen';
    case 'bad-name':
      return 'Nickname must be 1–20 characters';
    case 'game-started':
      return 'The game already started — joining closed';
    default:
      return 'Could not join — check the PIN and try again';
  }
}

function currentPayload() {
  return {
    pin: credentials.pin,
    name: credentials.name,
    playerId: localStorage.getItem(ID_KEY) ?? undefined,
  };
}

socket.on('connect', () => {
  if (!credentials || sentThisConnection) return;
  sentThisConnection = true;
  socket.emit('join', currentPayload());
});

socket.on('disconnect', () => {
  // socket.io reconnects on its own; the next `connect` re-sends the join
  // with the stored playerId so the server resumes this player.
  sentThisConnection = false;
  waiting.textContent = 'Reconnecting…';
});

socket.on('joined', ({ playerId, name }) => {
  myId = playerId;
  localStorage.setItem(ID_KEY, playerId);
  finalName.textContent = name;
  status.textContent = '';
  waiting.textContent = 'Waiting for the host to start…';
  showLobby();
});

socket.on('joinError', ({ reason }) => {
  status.textContent = errorText(reason);
  pinInput.focus();
});

socket.on('state', (view) => {
  latestView = view;
  phase = view.phase;
  if (!myId) {
    // Join confirmation not yet in; keep the waiting copy updated.
    if (view.phase !== 'lobby') waiting.textContent = 'Game in progress…';
    return;
  }
  switch (view.phase) {
    case 'lobby':
      showLobby();
      break;
    case 'question': {
      const question = view.currentQuestion;
      if (!question) return;
      if (question.questionIndex !== shownQuestionIndex) renderQuestion(question, view);
      else if (!submitted) startCountdown(question.timerDeadline);
      break;
    }
    case 'reveal':
      renderResult();
      break;
    case 'leaderboard':
      renderStandings(view, 'leaderboard');
      break;
    case 'podium':
      renderStandings(view, 'podium');
      break;
  }
});

socket.on('reveal', (payload) => {
  revealData = payload;
  if (phase === 'reveal' && myId) renderResult();
});

socket.on('answerRejected', ({ reason }) => {
  answerStatus.textContent = rejectText(reason);
});

joinButton.addEventListener('click', () => {
  const pin = pinInput.value.trim();
  const name = nameInput.value.trim();
  if (!PIN_DIGITS.test(pin)) {
    status.textContent = 'Enter the 6-digit game PIN';
    return;
  }
  if (name.length === 0 || name.length > NAME_MAX_LEN) {
    status.textContent = 'Nickname must be 1–20 characters';
    return;
  }
  credentials = { pin, name };
  status.textContent = 'Joining…';
  if (socket.connected) {
    sentThisConnection = true;
    socket.emit('join', currentPayload());
  }
  // Disconnected: socket.io buffers nothing here by contract — the next
  // `connect` fires the emit via the handler above.
});
