// Player join flow: send PIN + nickname, store the assigned playerId in
// localStorage, and re-send it automatically whenever socket.io reconnects,
// so a dropped connection resumes the same player instead of duplicating one.
const ID_KEY = 'offline-kahoot:playerId';
const NAME_MAX_LEN = 20; // must match src/join.ts NAME_MAX_LEN
const PIN_DIGITS = /^\d{6}$/;

const entering = document.getElementById('entering');
const lobby = document.getElementById('lobby');
const status = document.getElementById('status');
const pinInput = document.getElementById('pin');
const nameInput = document.getElementById('name');
const joinButton = document.getElementById('join');
const finalName = document.getElementById('final-name');
const waiting = document.getElementById('waiting');

const socket = io();

/** PIN + nickname of the current join attempt; re-emitted on every (re)connect. */
let credentials = null;
// Guards against double-joining across the click handler and reconnects:
// reset on disconnect so every fresh connection sends exactly one join.
let sentThisConnection = false;

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
  localStorage.setItem(ID_KEY, playerId);
  finalName.textContent = name;
  status.textContent = '';
  entering.hidden = true;
  lobby.hidden = false;
});

socket.on('joinError', ({ reason }) => {
  status.textContent = errorText(reason);
  pinInput.focus();
});

socket.on('state', (view) => {
  if (view.phase !== 'lobby' && view.phase !== 'podium') {
    // Question/reveal screens arrive with a later ticket; keep the confirmed
    // name visible instead of the lobby wait line.
    waiting.textContent = 'Game in progress…';
  }
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
