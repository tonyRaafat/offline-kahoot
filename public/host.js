async function showSession() {
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
}

showSession();
