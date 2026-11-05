// Host gameplay page: this socket claims the host role once per connection,
// drives the game (hostStart / reveal / next) and renders every phase from the
// pushed StateView plus the `reveal` payloads. The lobby markup serves the
// join URL / PIN / QR / roster flow; quiz selection lives on the dashboard.

import { makeAvatar } from '/avatar.js';

// i18n.js (plain script, loaded before this module) provides the globals.
const { t, set, clear, onChange } = window.I18n;

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
    clear(status);
  } catch (err) {
    set(status, 'host.failedSession', { detail: err.message });
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
const quizNameEl = document.getElementById('quiz-name');
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
const endGameButton = document.getElementById('end-game');

// Same-origin socket: withCredentials sends the HttpOnly admin session
// cookie in the handshake — required to claim the `host` role (issue 03).
const socket = io({ withCredentials: true });

let latestView = null; // last `state` StateView
let revealData = null; // last `reveal` payload
let lastQuestion = null; // CurrentQuestionView shown before the reveal
let countdownTimer = null;
let currentPhase = null; // last phase shown; drives the entrance animation
// Podium "Back to lobby" sets this; the confirming lobby `state` (server endGame
// reset landed) then navigates to the dashboard (issue 04) instead of re-showing
// the local lobby view. Declared up top with the other view state — the
// `socket.on('state')` handler reads it and must see the same binding.
let leaveToDashboard = false;

/** Shows exactly the phase's card; when the card just became visible (a phase
 *  change, not a re-render of the phase we're already on) its wrapper gets
 *  the .phase-enter entrance re-triggered (issue 05). Only the wrapper
 *  animates — the leaderboard/podium rows inside keep their own stable,
 *  playerId-keyed animation contract (ux-04), a new state wins immediately
 *  because show() re-runs the swap synchronously before any repaint. */
function show(phase) {
  for (const [name, card] of Object.entries(cards)) {
    const wasHidden = card.hidden;
    card.hidden = name !== phase;
    if (name === phase && wasHidden && currentPhase !== phase) {
      card.classList.remove('phase-enter');
      void card.offsetWidth; // restart the CSS animation on purpose
      card.classList.add('phase-enter');
    }
  }
  currentPhase = phase;
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

/** Player-id -> PlayerView lookup from the roster within the current StateView. */
function playersById(view) {
  const byId = new Map();
  for (const player of view.players) byId.set(player.id, player);
  return byId;
}

function nameOf(names, playerId, fallback = '?') {
  return names.get(playerId)?.name ?? fallback;
}

/** Renders every phase from a StateView; called on `state` and on a language
 *  switch (which must re-render the current screen). */
function dispatchView(view) {
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
      leaderboardNextButton.disabled = false;
      renderScoredList(leaderboardEl, view, playersById(view));
      break;
    case 'podium':
      stopCountdown();
      show('podium');
      endGameButton.disabled = false;
      renderScoredList(podiumEl, view, playersById(view), 3);
      break;
  }
}

function renderLobby(view) {
  stopCountdown();
  show('lobby');
  // The lobby only displays the loaded quiz; selection lives on the dashboard.
  quizNameEl.textContent = view.quizTitle ?? '—';
  playerCountEl.textContent = view.players.length > 0 ? ` (${view.players.length})` : '';
  document.getElementById('players-empty').hidden = view.players.length > 0;
  rosterEl.replaceChildren(
    ...view.players.map((player) => {
      const li = document.createElement('li');
      // Stable, playerId-derived row key: the issue-04 FLIP animation targets
      // these rows by id/data-player-id instead of rebuilding the list.
      li.id = `roster-${player.id}`;
      li.dataset.playerId = player.id;
      li.append(makeAvatar(player.name, player.color), player.name);
      return li;
    }),
  );
  startButton.disabled = false;
}

function renderQuestion(view) {
  const question = view.currentQuestion;
  if (!question) return;
  lastQuestion = question;
  revealData = null;
  revealButton.disabled = false;
  show('question');
  quizTitleEl.textContent = view.quizTitle;
  questionNumberEl.textContent = String(question.questionIndex + 1);
  questionPromptEl.textContent = question.prompt;
  questionOptionsEl.replaceChildren(
    ...question.options.map((option, answerIndex) => {
      const li = document.createElement('li');
      // Answer tile colors keyed by option index (tokens.css palette).
      li.dataset.answerIndex = String(answerIndex);
      li.textContent = option;
      return li;
    }),
  );
  startCountdown(question.timerDeadline);
}

function renderReveal(view) {
  if (!revealData) return;
  show('reveal');
  nextButton.disabled = false;
  correctAnswerEl.textContent =
    lastQuestion?.options[revealData.correctIndex] ?? t('host.option', { number: revealData.correctIndex + 1 });
  const names = playersById(view);
  correctPlayersEl.replaceChildren(
    ...revealData.results
      .filter((result) => result.correct)
      .map((result) => {
        const player = names.get(result.playerId);
        const li = document.createElement('li');
        li.id = `reveal-${result.playerId}`;
        li.dataset.playerId = result.playerId;
        li.append(
          makeAvatar(player?.name ?? '?', player?.color),
          nameOf(names, result.playerId),
        );
        return li;
      }),
  );
}

/** Rank rows (leaderboard/podium). Rows are keyed by playerId (id +
 *  data-player-id) — issue 04 reorders these DOM nodes via FLIP. */
function renderScoredList(el, view, names, limit = Infinity) {
  el.replaceChildren(
    ...view.leaderboard.slice(0, limit).map((playerId, index) => {
      const player = names.get(playerId);
      const li = document.createElement('li');
      li.id = `lb-${playerId}`;
      li.dataset.playerId = playerId;
      li.className = 'row';
      const rank = document.createElement('span');
      rank.className = 'row-rank';
      rank.textContent = String(index + 1);
      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = nameOf(names, playerId);
      const score = document.createElement('span');
      score.className = 'row-score';
      score.textContent = t('word.points', { points: view.scores[playerId] ?? 0 });
      li.append(rank, makeAvatar(player?.name ?? '?', player?.color), name, score);
      return li;
    }),
  );
}

socket.on('connect', () => {
  socket.emit('host');
  if (latestView?.phase === 'question') {
    revealButton.disabled = false;
  }
});

socket.on('state', (view) => {
  latestView = view;
  // Podium "Back to lobby" leaves the game view: once the server's endGame
  // reset lands (back at the lobby — roster kept, scores cleared, results
  // saved), the browser navigates to the dashboard (issue 04).
  if (leaveToDashboard && view.phase === 'lobby') {
    leaveTo('/');
    return;
  }
  dispatchView(view);
});

socket.on('reveal', (payload) => {
  revealData = payload;
  if (latestView?.phase === 'reveal') renderReveal(latestView);
});

startButton.addEventListener('click', () => {
  startButton.disabled = true;
  socket.emit('hostStart');
  setTimeout(() => {
    if (latestView?.phase === 'lobby') startButton.disabled = false;
  }, 3000);
});

// ---- Host lobby (selection/import/export moved to the dashboard, issue 04) ---

// Language switch: static data-i18n strings are re-applied by i18n.js itself;
// here we re-render what this page generates from JS.
onChange(() => {
  if (latestView) dispatchView(latestView);
});

revealButton.addEventListener('click', () => {
  revealButton.disabled = true;
  socket.emit('reveal');
  setTimeout(() => {
    if (latestView?.phase === 'question') revealButton.disabled = false;
  }, 3000);
});

nextButton.addEventListener('click', () => {
  nextButton.disabled = true;
  socket.emit('next');
  setTimeout(() => {
    if (latestView?.phase === 'reveal') nextButton.disabled = false;
  }, 3000);
});

leaderboardNextButton.addEventListener('click', () => {
  leaderboardNextButton.disabled = true;
  socket.emit('next');
  setTimeout(() => {
    if (latestView?.phase === 'leaderboard') leaderboardNextButton.disabled = false;
  }, 3000);
});

// Back to lobby: keeps the existing endGame reset sequence (server resets to
// lobby, keeps the roster, clears scores, saves the results file) and then
// navigates to the dashboard instead of re-showing this page's lobby view.
// Navigation goes through the shared leave transition (tokens.css: the
// html.leaving fade); reduced motion collapses it to an instant swap.
endGameButton.addEventListener('click', () => {
  endGameButton.disabled = true;
  leaveToDashboard = true;
  socket.emit('endGame');
});

/** Navigates through the page-leave fade (see tokens.css). */
function leaveTo(href) {
  document.documentElement.classList.add('leaving');
  window.setTimeout(() => {
    window.location.href = href;
  }, 120);
}
