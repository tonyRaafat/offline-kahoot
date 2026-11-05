// login.js — POST /api/login with the admin password; on success the session
// cookie is set and we navigate to "/" (no ?next= by spec: pages that were
// redirected here always land on the dashboard route, which issue 04 owns —
// today that is the host page, and it will change automatically).
// Errors surface in the card's error slot using the i18n idioms.

const form = document.getElementById('login-form');
const passwordEl = document.getElementById('password');
const submitEl = document.getElementById('submit');
const errorsEl = document.getElementById('errors');

/** Error slots stay translated on a language switch: each message is
 *  registered with I18n.set (key + no params) instead of snapshotting text,
 *  so setLang() re-renders them like every other dynamic string. */
function showErrors(errorKeys) {
  errorsEl.replaceChildren(
    ...errorKeys.map((key) => {
      const li = document.createElement('li');
      I18n.set(li, key);
      return li;
    }),
  );
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitEl.disabled) return; // degrade double-clicks while pending
  submitEl.disabled = true;
  I18n.set(submitEl, 'login.submitting');
  errorsEl.replaceChildren();
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: passwordEl.value }),
    });
    if (res.status === 204) {
      // Issue 05: the login → dashboard entrance goes through the page-leave
      // fade (tokens.css); reduced motion makes it an instant swap.
      document.documentElement.classList.add('leaving');
      window.setTimeout(() => {
        window.location.href = '/';
      }, 120);
      return;
    }
    showErrors(['login.err.wrongPassword']);
  } catch (err) {
    showErrors(['login.err.network']);
  } finally {
    if (document.contains(submitEl)) {
      submitEl.disabled = false;
      I18n.set(submitEl, 'login.submit');
    }
  }
});
