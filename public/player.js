// Player gameplay page: keep the join/resume flow, then render every phase the
// server pushes through StateView — question (tap to answer), reveal (correct/
// wrong + points), leaderboard and podium — plus the answerRejected reasons.

import { makeAvatar, AVATAR_COLORS } from '/avatar.js';

// i18n.js (plain script, loaded before this module) provides the globals.
const { t, set, clear, onChange, applyStatic } = window.I18n;

const ID_KEY = 'offline-kahoot:playerId';
const COLOR_KEY = 'offline-kahoot:avatarColor';
const NAME_KEY = 'offline-kahoot:name';
const PIN_KEY = 'offline-kahoot:pin';
const DEFAULT_COLOR = AVATAR_COLORS[0]; // sensible fallback when storage is corrupt/empty
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
const colorPicker = document.getElementById('color-picker');
const finalName = document.getElementById('final-name');
const waiting = document.getElementById('waiting');
const lobbyCountEl = document.getElementById('lobby-count');
const lobbyPlayersEl = document.getElementById('lobby-players');

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
  set(status, 'player.noServer');
});
socket.on('connect_timeout', () => {
  console.error('[player] connect_timeout');
  set(status, 'player.timeout');
});
socket.on('reconnect_attempt', (attempt) => {
  console.log('[player] reconnect_attempt', attempt);
});
socket.on('reconnect_failed', () => {
  console.error('[player] reconnect_failed');
  set(status, 'player.lostConnection');
});

/** PIN + nickname of the current join attempt; re-emitted on every (re)connect. */
let credentials = null;
// Guards against double-joining across the click handler and reconnects:
// reset on disconnect so every fresh connection sends exactly one join.
let sentThisConnection = false;

// True while a silent auto-rejoin from the stored identity is in flight (page
// refresh): a joinError then means the stored identity is dead and must clear.
let resuming = false;
// Question index the server says we already answered (on resume); renderQuestion
// restores the answer-locked UI for it.
let lockedQuestionIndex = null;

// Gameplay state.
let myId = null; // assigned playerId from `joined`
let phase = 'lobby'; // latest StateView phase
let latestView = null; // last `state` StateView
let shownQuestionIndex = null; // question index currently on screen
let lastQuestion = null; // CurrentQuestionView of the shown question
let submitted = false; // one answer per question
let revealData = null; // last `reveal` payload
let countdownTimer = null;
let myColor = null; // avatar color confirmed by the server

// ---- Avatar color picker (join form) ---------------------------------------

function storedIdentity() {
  const playerId = localStorage.getItem(ID_KEY);
  const name = localStorage.getItem(NAME_KEY);
  const pin = localStorage.getItem(PIN_KEY);
  if (!playerId || !name || !pin) return null;
  return { playerId, name, pin };
}

function clearIdentity() {
  localStorage.removeItem(ID_KEY);
  localStorage.removeItem(COLOR_KEY);
  localStorage.removeItem(NAME_KEY);
  localStorage.removeItem(PIN_KEY);
  selectedColor = DEFAULT_COLOR;
  updateSwatches();
  myId = null;
  credentials = null;
  resuming = false;
  lockedQuestionIndex = null;
  finalName.replaceChildren();
}

function showEntering() {
  entering.hidden = false;
  for (const card of Object.values(cards)) card.hidden = true;
}

function storedColor() {
  const stored = localStorage.getItem(COLOR_KEY);
  return AVATAR_COLORS.includes(stored) ? stored : DEFAULT_COLOR;
}

let selectedColor = storedColor();

for (const color of AVATAR_COLORS) {
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'color-swatch';
  swatch.dataset.color = color;
  swatch.setAttribute('role', 'radio');
  swatch.setAttribute('aria-checked', 'false');
  swatch.title = t(`player.color.${color}`); // tooltip on hover/long-press
  // Attribute hook so a language switch re-translates the tooltip.
  swatch.dataset.i18nAttr = `title:player.color.${color}`;
  swatch.addEventListener('click', () => {
    selectedColor = color;
    localStorage.setItem(COLOR_KEY, color);
    updateSwatches();
  });
  colorPicker.append(swatch);
}

function updateSwatches() {
  for (const swatch of colorPicker.querySelectorAll('.color-swatch')) {
    const active = swatch.dataset.color === selectedColor;
    swatch.classList.toggle('selected', active);
    swatch.setAttribute('aria-checked', active ? 'true' : 'false');
  }
}

updateSwatches();
applyStatic(); // translate the generated swatch titles now and on every toggle

// Silent auto-resume: if this device previously joined, re-send the stored
// identity on connect so an accidental page refresh continues the game.
const stored = storedIdentity();
if (stored) {
  credentials = { pin: stored.pin, name: stored.name, color: storedColor() };
  resuming = true;
  show('lobby');
  set(waiting, 'player.reconnecting');
}

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
  renderLobbyRoster(latestView);
}

/** Player-side copy of the host lobby roster: avatars + names from StateView.
 *  Rows carry stable playerId keys (id + data-player-id) for issue 04 FLIP. */
function renderLobbyRoster(view) {
  if (!view) return;
  lobbyCountEl.textContent = view.players.length > 0 ? ` (${view.players.length})` : '';
  lobbyPlayersEl.replaceChildren(
    ...view.players.map((player) => {
      const li = document.createElement('li');
      li.id = `player-roster-${player.id}`;
      li.dataset.playerId = player.id;
      li.classList.toggle('me', player.id === myId);
      li.replaceChildren(makeAvatar(player.name, player.color), player.name);
      return li;
    }),
  );
}

function renderQuestion(question, view) {
  lastQuestion = question;
  shownQuestionIndex = question.questionIndex;
  submitted = question.questionIndex === lockedQuestionIndex;
  stopCountdown();
  show('question');
  questionNumberEl.textContent = String(question.questionIndex + 1);
  questionPromptEl.textContent = question.prompt;
  clear(answerStatus);
  optionsEl.replaceChildren(
    ...question.options.map((option, answerIndex) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.className = 'answer';
      button.type = 'button';
      // Answer tile color keyed by option index (tokens.css palette).
      button.dataset.answerIndex = String(answerIndex);
      button.textContent = option;
      button.addEventListener('click', () => submitAnswer(answerIndex, button));
      li.append(button);
      return li;
    }),
  );
  if (submitted) {
    // Refreshed mid-question after answering: restore the locked state.
    for (const button of optionsEl.querySelectorAll('button')) button.disabled = true;
    set(answerStatus, 'player.answerLocked');
  }
  startCountdown(question.timerDeadline);
}

function submitAnswer(answerIndex, button) {
  if (submitted) return;
  submitted = true;
  for (const other of optionsEl.querySelectorAll('button')) other.disabled = true;
  set(answerStatus, 'player.answerLocked');
  socket.emit('answer', { answerIndex });
}

function renderResult() {
  if (!revealData) return;
  stopCountdown();
  show('reveal');
  const mine = revealData.results.find((result) => result.playerId === myId);
  const correct = mine?.correct ?? false;
  set(resultTitle, correct ? 'player.correct' : 'player.incorrect');
  resultTitle.classList.toggle('correct', correct);
  resultTitle.classList.toggle('wrong', !correct);
  set(resultPoints, 'word.points', { points: mine?.points ?? 0 });
  const answer = lastQuestion?.options[revealData.correctIndex];
  if (answer !== undefined) set(correctAnswerEl, 'player.correctAnswer', { answer });
  else clear(correctAnswerEl);
}

function renderStandings(view, name) {
  stopCountdown();
  show(name);
  const rank = view.leaderboard.indexOf(myId);
  if (rank >= 0) {
    set(rankEls[name], 'player.rank', { rank: rank + 1, total: view.leaderboard.length });
  } else {
    set(rankEls[name], 'player.rankWaiting');
  }
  const mine = view.players.find((player) => player.id === myId);
  const score = document.createElement('span');
  score.className = 'score-big';
  score.textContent = t('word.points', { points: view.scores[myId] ?? 0 });
  scoreEls[name].replaceChildren(
    makeAvatar(mine?.name ?? '', mine?.color ?? myColor ?? 'grey'),
    score,
  );
}

// Join-error reason keys come straight from the server (src/join.ts);
// answer-reject reasons straight from the engine. Both map to localized
// strings here — the raw keys never reach the user.
const JOIN_ERROR_KEYS = {
  'bad-pin': 'player.err.bad-pin',
  'bad-name': 'player.err.bad-name',
  nameTaken: 'player.err.nameTaken',
  colorRejected: 'player.err.colorRejected',
  'game-started': 'player.err.game-started',
};

/** i18n key for a server joinError reason (localized via set()/t()). */
function joinErrorKey(reason) {
  return JOIN_ERROR_KEYS[reason] ?? 'player.err.default';
}

const ANSWER_REJECT_KEYS = {
  late: 'player.rej.late',
  'already-answered': 'player.rej.already-answered',
  'unknown-player': 'player.rej.unknown-player',
  'invalid-answer': 'player.rej.invalid-answer',
};

/** i18n key for a server answerRejected reason. */
function rejectKey(reason) {
  return ANSWER_REJECT_KEYS[reason] ?? 'player.rej.default';
}

function currentPayload() {
  return {
    pin: credentials.pin,
    name: credentials.name,
    color: credentials.color,
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
  set(waiting, 'player.reconnecting');
});

socket.on('joined', ({ playerId, name, color }) => {
  myId = playerId;
  myColor = color;
  resuming = false;
  localStorage.setItem(ID_KEY, playerId);
  localStorage.setItem(COLOR_KEY, color);
  localStorage.setItem(NAME_KEY, name);
  if (credentials) localStorage.setItem(PIN_KEY, credentials.pin);
  finalName.replaceChildren(makeAvatar(name, color), name);
  clear(status);
  set(waiting, 'player.waiting');
  showLobby();
});

// Mid-question resume status: the server tells us whether we already answered
// the live question so renderQuestion can restore the locked state.
socket.on('resumeAnswerStatus', ({ questionIndex, alreadyAnswered }) => {
  lockedQuestionIndex = alreadyAnswered ? questionIndex : null;
});

socket.on('joinError', ({ reason }) => {
  if (resuming) {
    // The silent auto-rejoin was rejected (stale PIN / roster change / etc.):
    // tear down the stored identity and show the blank join form again.
    const key = joinErrorKey(reason);
    clearIdentity();
    pinInput.value = '';
    nameInput.value = '';
    showEntering();
    set(status, key);
    pinInput.focus();
    return;
  }
  set(status, joinErrorKey(reason));
  pinInput.focus();
});

// Language switch: static data-i18n strings are re-applied by i18n.js itself
// (including the swatch title attributes via applyStatic); dynamic phase
// screens are rebuilt here.
onChange(() => {
  if (!myId || !latestView) return;
  switch (phase) {
    case 'lobby':
      renderLobbyRoster(latestView);
      break;
    case 'reveal':
      renderResult();
      break;
    case 'leaderboard':
      renderStandings(latestView, 'leaderboard');
      break;
    case 'podium':
      renderStandings(latestView, 'podium');
      break;
    // 'question': its label/number spans are static + tracked already.
  }
});

socket.on('state', (view) => {
  latestView = view;
  phase = view.phase;
  if (!myId) {
    // Join confirmation not yet in; keep the waiting copy updated.
    if (view.phase !== 'lobby') set(waiting, 'player.inProgress');
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
  set(answerStatus, rejectKey(reason));
});

joinButton.addEventListener('click', () => {
  const pin = pinInput.value.trim();
  const name = nameInput.value.trim();
  if (!PIN_DIGITS.test(pin)) {
    set(status, 'player.enterPin');
    return;
  }
  if (name.length === 0 || name.length > NAME_MAX_LEN) {
    set(status, 'player.nameLength');
    return;
  }
  credentials = { pin, name, color: selectedColor };
  set(status, 'player.joining');
  if (socket.connected) {
    sentThisConnection = true;
    socket.emit('join', currentPayload());
  }
  // Disconnected: socket.io buffers nothing here by contract — the next
  // `connect` fires the emit via the handler above.
});

const leaveButton = document.getElementById('leave');
leaveButton.addEventListener('click', () => {
  // Voluntary leave: drop the seat on the server (lobby phase only — the
  // server ignores `leave` once the quiz has started) and forget this device.
  socket.emit('leave');
  clearIdentity();
  pinInput.value = '';
  nameInput.value = '';
  clear(status);
  showEntering();
  pinInput.focus();
});
