// Dashboard page (admin-dashboard issue 04): quiz card grid on the existing
// quiz CRUD + POST /api/game/quiz, the live-session banner (/api/session) and
// the logout control. Dashboard "Start" loads the quiz into the live session
// and navigates to /host, where the lobby's Start button takes it live — the
// wire contract is unchanged (no new routes or socket events).

// i18n.js (plain script, loaded before this module) provides the globals.
const { t, set, clear, onChange } = window.I18n;

// Inline SVG icons for the card's secondary actions (edit / delete) — they
// render as compact icon buttons, so no visible text rides on them; meaning
// is carried entirely by aria-label/title (localized at render time).
const editIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
  ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>' +
  '<path d="m15 5 4 4"/></svg>';
const deleteIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
  ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
  '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
  '<line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

const quizCardsEl = document.getElementById('quiz-cards');
const quizzesEmptyEl = document.getElementById('quizzes-empty');
const statusEl = document.getElementById('dashboard-status');
const liveBannerEl = document.getElementById('live-banner');
const liveBannerTextEl = document.getElementById('live-banner-text');
const newTitleEl = document.getElementById('new-title');
const createButton = document.getElementById('create');
// Import/export UI temporarily hidden (dashboard.js + dashboard.html).
// const importButton = document.getElementById('import');
// const importFileEl = document.getElementById('import-file');
const logoutButton = document.getElementById('logout');

let quizzes = [];
let quizzesLoaded = false; // distinguishes "list empty" from "list not fetched yet"

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

// ---- Quiz cards -------------------------------------------------------------

/** (Re)builds the card grid from the fetched list; shows the empty state once
 *  the list has actually been fetched and is empty. */
function renderQuizCards() {
  if (quizzesLoaded && quizzes.length === 0) {
    quizCardsEl.replaceChildren();
    quizzesEmptyEl.hidden = false;
    return;
  }
  quizzesEmptyEl.hidden = true;
  quizCardsEl.replaceChildren(...quizzes.map(renderQuizCard));
}

function renderQuizCard(quiz) {
  const card = document.createElement('li');
  card.className = 'quiz-card';
  card.dataset.quizId = quiz.id;

  const title = document.createElement('h2');
  title.className = 'quiz-card-title';
  title.textContent = quiz.title;
  title.title = quiz.title; // full title as tooltip (issue 01: 2-line clamp)

  const count = document.createElement('p');
  count.className = 'quiz-card-count';
  set(count, 'dashboard.questionCount', { count: quiz.questionCount });

  // One action row: Start keeps its text label (primary action); Edit and
  // Delete are icon buttons — quieter UI, same behaviors as before.
  const actions = document.createElement('div');
  actions.className = 'quiz-card-actions';

  // Start: loads the quiz into the live session, then leaves for /host.
  const start = document.createElement('button');
  start.className = 'player-button';
  start.type = 'button';
  set(start, 'dashboard.start');
  start.addEventListener('click', () => startQuiz(quiz, start));

  // Edit: icon link into the editor; the localized label rides along as
  // tooltip + accessible name (no visible text).
  const edit = document.createElement('a');
  edit.className = 'icon-btn';
  edit.href = `/editor?id=${encodeURIComponent(quiz.id)}`;
  edit.title = t('dashboard.edit');
  edit.setAttribute('aria-label', t('dashboard.edit'));
  edit.innerHTML = editIcon;

  // Delete: icon button with confirm (same flow as before).
  const removeButton = document.createElement('button');
  removeButton.className = 'icon-btn danger';
  removeButton.type = 'button';
  removeButton.title = t('dashboard.delete');
  removeButton.setAttribute('aria-label', t('dashboard.delete'));
  removeButton.innerHTML = deleteIcon;
  removeButton.addEventListener('click', () => deleteQuiz(quiz));

  actions.append(start, edit, removeButton);
  card.append(title, count, actions);
  return card;
}

async function refreshQuizzes() {
  try {
    quizzes = await api('/api/quizzes');
    quizzesLoaded = true;
    renderQuizCards();
  } catch (err) {
    set(statusEl, 'dashboard.failedList', { detail: err.message });
  }
}

// Start navigates through the shared leave fade (see the link interceptor +
// tokens.css' html.leaving fade): replaced location.href with leaveTo.
async function startQuiz(quiz, button) {
  button.disabled = true;
  clear(statusEl);
  try {
    await api('/api/game/quiz', { method: 'POST', body: { quizId: quiz.id } });
    set(statusEl, 'dashboard.starting', { title: quiz.title });
    leaveTo('/host');
  } catch (err) {
    set(statusEl, 'dashboard.failedStart', { detail: err.message });
    button.disabled = false;
  }
}

async function deleteQuiz(quiz) {
  if (!window.confirm(t('editor.deleteConfirm', { title: quiz.title }))) return;
  try {
    await api(`/api/quizzes/${encodeURIComponent(quiz.id)}`, { method: 'DELETE' });
    set(statusEl, 'editor.deleted', { title: quiz.title });
    await refreshQuizzes();
  } catch (err) {
    set(statusEl, 'dashboard.failedDelete', { detail: err.message });
  }
}

// ---- Create + Import ---------------------------------------------------------

createButton.addEventListener('click', async () => {
  const title = newTitleEl.value;
  if (title.trim() === '') {
    set(statusEl, 'editor.giveTitle');
    return;
  }
  createButton.disabled = true;
  try {
    const created = await api('/api/quizzes', { method: 'POST', body: { title } });
    newTitleEl.value = '';
    await refreshQuizzes();
    set(statusEl, 'dashboard.created', { title: created.title });
  } catch (err) {
    set(statusEl, 'dashboard.failedCreate', { detail: err.message });
  } finally {
    createButton.disabled = false;
  }
});

// Import/export UI temporarily hidden: handler block below kept as reference
// for restoring the feature (elements + i18n keys still exist).
/*
// Import (spec 4.1: moved here with export from the old host lobby). The
// endpoint body IS one quiz JSON (POST /api/quizzes/import), i.e. exactly
// what the card Export link downloads, so export files re-import as-is;
// a JSON array of quiz objects is imported one by one. On success the card
// grid refreshes and a localized status line reports what landed.
let importing = false;
importButton.addEventListener('click', () => {
  if (!importing) importFileEl.click();
});

importFileEl.addEventListener('change', async () => {
  const file = importFileEl.files?.[0];
  importFileEl.value = ''; // lets the same file be picked again
  if (!file || importing) return;
  importing = true;
  importButton.disabled = true;
  clear(statusEl);
  try {
    const parsed = JSON.parse(await file.text());
    const payloads = Array.isArray(parsed) ? parsed : [parsed];
    let last = null;
    for (const payload of payloads) {
      last = await api('/api/quizzes/import', { method: 'POST', body: payload });
    }
    await refreshQuizzes();
    if (payloads.length === 1 && last) {
      set(statusEl, 'dashboard.imported', { title: last.title });
    } else {
      set(statusEl, 'dashboard.importedMany', { count: payloads.length });
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      set(statusEl, 'dashboard.importNotJson');
    } else {
      const detail =
        Array.isArray(err.errors) && err.errors.length > 0
          ? err.errors.join('; ')
          : err.message;
      set(statusEl, 'dashboard.importFailed', { detail });
    }
  } finally {
    importing = false;
    importButton.disabled = false;
  }
});
*/

// ---- Live-game indicator -------------------------------------------------------

/** Shows the banner ONLY while a game is actually running: /api/session now
 *  carries `live` (engine phase past the lobby — the paid-review fix from
 *  issue 04: "the banner shows whenever a PIN exists" was wrong), so a
 *  loaded-but-not-started lobby keeps the dashboard clean. */
async function refreshLiveBanner() {
  liveBannerEl.hidden = true;
  try {
    const session = await api('/api/session');
    if (!session?.pin || !session.live) {
      // Drop the tracked "live with PIN …" text too, so a game that ended
      // never resurfaces when the language is toggled later.
      clear(liveBannerTextEl);
      return;
    }
    set(liveBannerTextEl, 'dashboard.live', { pin: session.pin });
    liveBannerEl.hidden = false;
  } catch {
    clear(liveBannerTextEl);
    // No banner without a session handle; the host page reports its own errors.
  }
}

// ---- Logout ----------------------------------------------------------------------

logoutButton.addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
    leaveTo('/login');
  } catch (err) {
    set(statusEl, 'dashboard.logoutFailed', { detail: err.message });
  }
});

// ---- Page-leave transition (issue 05: dashboard ⇄ host, → editor/login) -------

/** Navigates through the token-paced leave fade (CSS in tokens.css). */
function leaveTo(href) {
  document.documentElement.classList.add('leaving');
  window.setTimeout(() => {
    window.location.href = href;
  }, 120);
}

/** Same-page anchor clicks (Edit cards, Export link, live banner → /host)
 *  go through leaveTo so the cross-fade covers them — including the card
 *  anchors rebuilt on every refresh (delegated on document, so dynamic
 *  cards are covered). Modifier clicks / middle-click keep native behavior;
 *  Export is a download (download attr) and is skipped. */
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!link || link.hasAttribute('download') || link.getAttribute('href')?.startsWith('#')) {
    return;
  }
  event.preventDefault();
  leaveTo(link.href);
});

// Language switch: static data-i18n strings are re-applied by i18n.js itself;
// here we re-render what this page generates from JS.
onChange(() => {
  renderQuizCards();
  refreshLiveBanner();
});

refreshQuizzes();
refreshLiveBanner();
