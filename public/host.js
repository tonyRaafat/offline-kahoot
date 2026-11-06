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
// Bright-reskin meters (transform-only, fed from the render paths below).
const timerBarEl = document.getElementById('timer-bar');
const answeredBarEl = document.getElementById('answered-bar');
const answeredCountEl = document.getElementById('answered-count');
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

function startCountdown(timerDeadline, timeSeconds = 0) {
  stopCountdown();
  const totalMs = timeSeconds > 0 ? timeSeconds * 1000 : 0;
  const tick = () => {
    const remainingMs = Math.max(0, timerDeadline - Date.now());
    countdownEl.textContent = String(Math.ceil(remainingMs / 1000));
    // Timer progress bar drains with the question window (scaleX only).
    if (timerBarEl !== null) {
      timerBarEl.style.transform = `scaleX(${totalMs > 0 ? remainingMs / totalMs : 0})`;
    }
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
  // ux-04: in-flight animations cancel (never queue) when the game moves on.
  // A new phase replaces any leaderboard count-up/FLIP or podium suspense
  // before its own render, so host controls are never blocked by animation.
  if (view.phase !== 'leaderboard') cancelLeaderboardAnim();
  if (view.phase !== 'podium') cancelPodiumAnim();
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
    case 'leaderboard': {
      stopCountdown();
      // `entering` is the same guard currentPhase drives in show(): only a
      // genuine phase swap plays the animation suite — a same-phase re-render
      // (language switch, resent state) refreshes quietly with no replay.
      const entering = currentPhase !== 'leaderboard';
      show('leaderboard');
      leaderboardNextButton.disabled = false;
      renderLeaderboard(view, playersById(view), entering);
      break;
    }
    case 'podium': {
      stopCountdown();
      const enteringPodium = currentPhase !== 'podium';
      show('podium');
      endGameButton.disabled = false;
      renderPodium(view, playersById(view), enteringPodium);
      break;
    }
  }
}

function renderLobby(view) {
  stopCountdown();
  // Back at the lobby = between games: score-count replay state resets so a
  // fresh game counts up from 0 again (ux-04).
  resetScoreboardAnim();
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
  startCountdown(question.timerDeadline, question.timeSeconds);
}

function renderReveal(view) {
  if (!revealData) return;
  show('reveal');
  nextButton.disabled = false;
  // The correct answer becomes the big colored tile in its option color
  // (bright-Kahoot reveal card); the attribute falls off gracefully when
  // the last question view is unavailable (e.g. a resume into a reveal).
  if (lastQuestion) {
    correctAnswerEl.dataset.answerIndex = String(revealData.correctIndex);
  } else {
    correctAnswerEl.removeAttribute('data-answer-index');
  }
  correctAnswerEl.textContent =
    lastQuestion?.options[revealData.correctIndex] ?? t('host.option', { number: revealData.correctIndex + 1 });
  // Answered meter (client-only, decision A): the reveal payload lists every
  // joined player; entries with a real answerIndex are the ones who answered.
  if (answeredBarEl !== null && answeredCountEl !== null) {
    const total = Math.max(view.players.length, 1);
    const answered = revealData.results.filter((result) => result.answerIndex !== null).length;
    answeredBarEl.style.transform = `scaleX(${answered / total})`;
    answeredCountEl.textContent = `${answered} / ${view.players.length}`;
  }
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

// ---- Animated scoreboard (ux-04): leaderboard FLIP/count-up + podium ----
// Rows keep stable, playerId-keyed DOM identity and every animation targets
// data-player-id, never index order: the engine's leaderboard array stays the
// single source of truth (it is consumed as-is; the client animates BETWEEN
// renders, it does not re-sort).
// DOM identity contract: id="lb-<playerId>" on the leaderboard (unchanged);
// "podium-<playerId>" on the podium — the two lists coexist in the DOM (one
// card is merely hidden), so both must not share ids.

const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const reducedMotion = () => reducedMotionQuery.matches;

/** Reads a motion-duration token (e.g. '--motion-slow') in ms. Under
 *  prefers-reduced-motion tokens.css zeroes the motion tokens, so JS pacing
 *  keyed off them collapses to instant; the explicit reducedMotion() checks
 *  gate the rAF paths and the podium timers on top of that (a CSS-only zero
 *  is not enough — ux-04). */
function motionMs(token) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const ms = Number.parseFloat(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

const PODIUM_STEP_MS = 1200;    // suspense pace: one rank revealed per step
const LB_ENTER_STAGGER_MS = 70; // first-visit row stagger
const LB_DELTA_MS = 2400;       // rank-change chip stays lit this long

const formatScore = (points) => t('word.points', { points });

/** Skeleton record for one score row: fixed slots so fills never rebuild the
 *  <li> itself (the stable node is what gets FLIP-moved / count-up'd). */
function makeScoredRow(prefix, playerId) {
  const li = document.createElement('li');
  li.id = `${prefix}${playerId}`;
  li.dataset.playerId = playerId;
  li.className = 'row';
  const rankEl = document.createElement('span');
  rankEl.className = 'row-rank';
  const avatarEl = document.createElement('span');
  avatarEl.className = 'row-avatar-slot';
  const nameEl = document.createElement('span');
  nameEl.className = 'row-name';
  const scoreEl = document.createElement('span');
  scoreEl.className = 'row-score';
  const deltaEl = document.createElement('span');
  deltaEl.className = 'row-delta';
  deltaEl.hidden = true; // rank-change chip, filled per render when it applies
  li.append(rankEl, avatarEl, nameEl, scoreEl, deltaEl);
  return { li, rankEl, avatarEl, nameEl, scoreEl, deltaEl };
}

function rowRecord(li) {
  return {
    li,
    rankEl: li.querySelector('.row-rank'),
    avatarEl: li.querySelector('.row-avatar-slot'),
    nameEl: li.querySelector('.row-name'),
    scoreEl: li.querySelector('.row-score'),
    deltaEl: li.querySelector('.row-delta'),
  };
}

/** Reconciles `el`'s row DOM to `rows` WITHOUT dropping nodes: existing
 *  playerId rows are moved into place, missing ones created, departed
 *  players' rows removed (roster changes stay graceful). Returns record
 *  objects parallel to `rows`. */
function reconcileScoredRows(el, prefix, rows) {
  const existing = new Map();
  for (const li of el.children) {
    if (li.dataset.playerId) existing.set(li.dataset.playerId, li);
  }
  const fragment = document.createDocumentFragment();
  const records = [];
  for (const { playerId } of rows) {
    let li = existing.get(playerId) ?? null;
    if (li !== null) existing.delete(playerId);
    else li = makeScoredRow(prefix, playerId).li;
    records.push(rowRecord(li));
    fragment.append(li);
  }
  for (const li of existing.values()) li.remove();
  el.replaceChildren(fragment);
  return records;
}

/** Writes rank / avatar / name / score into a row record. `scoreText` seeds
 *  the score slot (count-up start value); rank gets a medal class top-3. */
function fillScoredRow(record, names, playerId, rank, score, scoreText) {
  const medal = rank > 0 && rank <= 3 ? `row-rank medal-${rank}` : 'row-rank';
  record.rankEl.className = medal;
  record.rankEl.textContent = String(rank);
  const player = names.get(playerId);
  record.avatarEl.replaceChildren(makeAvatar(player?.name ?? '?', player?.color));
  record.nameEl.textContent = nameOf(names, playerId);
  record.scoreEl.textContent = scoreText ?? formatScore(score);
}

/** Rank-change chip: ▲/▼ with places moved, colored by direction, then fades.
 *  Vertical direction does not mirror under dir="rtl" — the list stacks the
 *  same way; the chip's POSITION flips automatically (flex + margins use
 *  logical properties, matching the issue's intent). */
function showRankDelta(record, oldRank, newRank) {
  const delta = oldRank - newRank;
  if (delta === 0) {
    record.deltaEl.hidden = true;
    return;
  }
  record.deltaEl.hidden = false;
  record.deltaEl.dataset.dir = delta > 0 ? 'up' : 'down';
  record.deltaEl.textContent = `${delta > 0 ? '▲' : '▼'}${Math.abs(delta)}`;
  // Restart the chip's pop/fade if one was already cycling on this row.
  record.deltaEl.classList.remove('row-delta-live');
  void record.deltaEl.offsetWidth;
  record.deltaEl.classList.add('row-delta-live');
}

// ---- Leaderboard: FLIP rank moves + score count-up ----

let lbAnim = null; // in-flight animation handle: { cancel() } — cancel, never queue
let lbLastSig = null; // order+scores signature of the last rendered board
let lbOrder = []; // playerIds of the previous board (rank-delta source)
const lbShown = new Map(); // playerId -> score currently on screen

function cancelLeaderboardAnim() {
  if (lbAnim === null) return;
  const { cancel } = lbAnim;
  lbAnim = null;
  cancel();
}

/** Resets the count-up memory between games (renderLobby). */
function resetScoreboardAnim() {
  cancelLeaderboardAnim();
  cancelPodiumAnim();
  lbShown.clear();
  lbOrder = [];
  lbLastSig = null;
}

/** Score count-up from `from` to `to` (exact server value always lands).
 *  lbShown tracks the displayed value every frame, so cancelling mid-flight
 *  leaves the truth on screen and the NEXT count-up continues from it. */
function countUpScore(record, playerId, from, to, durationMs) {
  const snap = () => {
    lbShown.set(playerId, to);
    record.scoreEl.textContent = formatScore(to);
  };
  if (reducedMotion() || durationMs <= 0 || from === to) {
    snap();
    return { cancel() {} };
  }
  const startedAt = performance.now();
  let raf = 0;
  const frame = (now) => {
    const p = Math.min(1, (now - startedAt) / durationMs);
    const value = Math.round(from + (to - from) * (1 - (1 - p) ** 3));
    lbShown.set(playerId, value);
    record.scoreEl.textContent = formatScore(value);
    if (p < 1) raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return { cancel: () => cancelAnimationFrame(raf) };
}

/** Renders the mid-game leaderboard. `entering` is a phase swap; same-phase
 *  re-renders with an unchanged order+scores signature (i18n change, resent
 *  state) must NOT replay animations (ux-04) and take the quiet path. */
function renderLeaderboard(view, names, entering) {
  cancelLeaderboardAnim();
  const rows = view.leaderboard.map((playerId, index) => ({
    playerId,
    rank: index + 1,
    score: view.scores[playerId] ?? 0,
  }));
  const sig = JSON.stringify(rows.map((row) => [row.playerId, row.rank, row.score]));
  if (!entering && sig === lbLastSig) {
    lbOrder = rows.map((row) => row.playerId);
    // Quiet refresh: reconcile nodes, write exact texts, touch no animation.
    const records = reconcileScoredRows(leaderboardEl, 'lb-', rows);
    rows.forEach((row, i) => {
      fillScoredRow(records[i], names, row.playerId, row.rank, row.score);
      lbShown.set(row.playerId, row.score);
    });
    return;
  }
  lbLastSig = sig;

  // FLIP "First": tops of the current rows BEFORE any reorder. Only read
  // when not entering — on a phase swap the card just unhidden, and the
  // first visit animates with the stagger path instead of FLIP anyway.
  const oldTopByPid = new Map();
  if (!entering) {
    for (const li of leaderboardEl.children) {
      if (li.dataset.playerId) {
        oldTopByPid.set(li.dataset.playerId, li.getBoundingClientRect().top);
      }
    }
  }
  const oldRankByPid = new Map();
  lbOrder.forEach((playerId, i) => oldRankByPid.set(playerId, i + 1));

  const records = reconcileScoredRows(leaderboardEl, 'lb-', rows);
  // Seed score slots with each count-up's start value (no final-value flash).
  const startByRow = rows.map((row) => (lbShown.has(row.playerId) ? lbShown.get(row.playerId) : 0));
  rows.forEach((row, i) => {
    fillScoredRow(records[i], names, row.playerId, row.rank, row.score, formatScore(startByRow[i]));
  });

  const moveMs = motionMs('--motion-slow');
  if (reducedMotion()) {
    rows.forEach((row, i) => countUpScore(records[i], row.playerId, startByRow[i], row.score, 0));
    lbOrder = rows.map((row) => row.playerId);
    return; // no FLIP, no stagger, exact values — done synchronously
  }

  const moves = [];
  const entered = [];
  let enterIndex = 0;
  rows.forEach((row, i) => {
    const record = records[i];
    if (entering || !oldTopByPid.has(row.playerId)) {
      // New row (first visit, or a player appearing mid-game): stagger in.
      entered.push(record);
      record.li.classList.add('row-enter');
      if (enterIndex > 0) record.li.style.animationDelay = `${enterIndex * LB_ENTER_STAGGER_MS}ms`;
      enterIndex += 1;
    } else {
      const newTop = record.li.getBoundingClientRect().top;
      const dy = oldTopByPid.get(row.playerId) - newTop;
      if (Math.abs(dy) > 1) moves.push([record, dy]);
    }
    const oldRank = oldRankByPid.get(row.playerId);
    if (oldRank !== undefined) showRankDelta(record, oldRank, row.rank);
  });

  // FLIP Update→Invert→Play: pin every mover at its OLD position, flip the
  // layout, then let the transition (--motion-slow, spring per ux-04 juice)
  // carry it to the new slot.
  for (const [record, dy] of moves) {
    record.li.style.transition = 'none';
    record.li.style.transform = `translateY(${dy}px)`;
  }
  void leaderboardEl.offsetWidth; // flush the inverted layout once
  for (const [record] of moves) {
    record.li.style.transition = `transform ${moveMs}ms var(--ease-spring)`;
    record.li.style.transform = '';
  }

  const timers = [];
  const countUps = rows.map((row, i) =>
    countUpScore(records[i], row.playerId, startByRow[i], row.score, moveMs),
  );
  const settleDelay = Math.max(
    moveMs + 60,
    motionMs('--motion-base') + Math.max(entered.length - 1, 0) * LB_ENTER_STAGGER_MS + 60,
  );
  const handle = { cancel };
  lbAnim = handle;
  function cancel() {
    if (lbAnim === handle) lbAnim = null;
    for (const id of timers) clearTimeout(id);
    for (const countUp of countUps) countUp.cancel();
    for (const record of records) {
      record.li.style.transition = '';
      record.li.style.transform = '';
      record.li.style.animationDelay = '';
      record.li.classList.remove('row-enter');
      record.deltaEl.hidden = true;
    }
  }
  timers.push(
    setTimeout(() => {
      if (lbAnim === handle) lbAnim = null;
      for (const record of records) {
        record.li.style.transition = '';
        record.li.style.transform = '';
        record.li.style.animationDelay = '';
        record.li.classList.remove('row-enter');
      }
    }, settleDelay),
  );
  // Rank chips outlive the FLIP: hide them once their hold/fade is done.
  timers.push(
    setTimeout(() => {
      if (lbAnim === handle) lbAnim = null;
      for (const record of records) record.deltaEl.hidden = true;
    }, settleDelay + LB_DELTA_MS + 120),
  );
  lbOrder = rows.map((row) => row.playerId);
}

// ---- Podium: reverse-suspense reveal of the top 3 ----

let podiumAnim = null; // in-flight suspense handle: { cancel() }

function cancelPodiumAnim() {
  if (podiumAnim === null) return;
  const { cancel } = podiumAnim;
  podiumAnim = null;
  cancel();
}

/** Renders the podium (top 3). During a genuine phase entry it plays the
 *  reverse suspense: 3rd → 2nd → 1st, 1st revealed last with the winner
 *  celebration. Re-renders (language switch) and reduced motion jump
 *  straight to the final podium. */
function renderPodium(view, names, entering) {
  cancelPodiumAnim();
  const rows = view.leaderboard.slice(0, 3).map((playerId, index) => ({
    playerId,
    rank: index + 1,
    score: view.scores[playerId] ?? 0,
  }));
  const records = reconcileScoredRows(podiumEl, 'podium-', rows);
  if (entering) {
    // Fresh suspense on a phase entry: strip any ceremony leftover from a
    // previous game's podium render, then mask every rank. Unrevealed ranks
    // are hidden by .podium-slot (dashed skeleton, visibility-masked
    // children) and their content is written at reveal time — either way the
    // row skeleton never changes, so reveals are + pops, never re-layout.
    for (const record of records) {
      record.li.classList.remove('podium-reveal', 'podium-winner');
      record.li.classList.add('podium-slot');
    }
  }
  const reveal = (i, celebrate) => {
    const record = records[i];
    if (!record) return;
    record.li.classList.remove('podium-slot');
    if (!record.li.classList.contains('podium-reveal')) record.li.classList.add('podium-reveal');
    if (celebrate && !record.li.classList.contains('podium-winner')) {
      record.li.classList.add('podium-winner');
    }
    const row = rows[i];
    fillScoredRow(record, names, row.playerId, row.rank, row.score);
    lbShown.set(row.playerId, row.score);
  };
  const finishAll = () => rows.forEach((_, i) => reveal(i, i === 0));
  if (!entering || reducedMotion()) {
    finishAll();
    return;
  }
  reveal(rows.length - 1, false); // 3rd place, immediately
  const timers = [];
  const handle = { cancel };
  function cancel() {
    if (podiumAnim === handle) podiumAnim = null;
    for (const id of timers) clearTimeout(id);
    finishAll(); // skip = land on the final podium (any in-flight step aborts)
  }
  podiumAnim = handle;
  if (rows.length > 1) {
    timers.push(setTimeout(() => reveal(rows.length - 2, false), PODIUM_STEP_MS));
  }
  timers.push(setTimeout(() => reveal(0, true), PODIUM_STEP_MS * 2)); // 1st + celebration
  timers.push(
    setTimeout(() => {
      if (podiumAnim === handle) podiumAnim = null;
    }, PODIUM_STEP_MS * 2 + 300),
  );
}

// Clicking anywhere on the podium card skips the suspense to the final
// reveal (ux-04). The Back-to-dashboard button share this listener; cancel
// finalizes the podium first, then the button's own handler runs.
document.getElementById('view-podium').addEventListener('click', () => {
  cancelPodiumAnim();
});

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
  // ux-04: abort the podium suspense cleanly on the way out (the confirming
  // lobby `state` would also cancel it via dispatchView — this is the belt).
  cancelPodiumAnim();
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
