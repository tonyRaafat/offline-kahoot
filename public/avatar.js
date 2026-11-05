// Shared avatar rendering for host.js and player.js (plain ES module, no
// bundler — imported directly by both pages).
//
// The wire carries palette KEYS ('red', 'blue', ...), never hex values; this
// file owns the key -> hex mapping so server and visual styles stay decoupled.
// Keys MUST match src/avatar-colors.ts on the server.

export const AVATAR_COLORS = [
  'red',
  'orange',
  'blue',
  'green',
  'pink',
  'white',
  'yellow',
  'brown',
  'black',
  'grey',
];

const AVATAR_COLOR_HEX = {
  red: '#e21b3c',
  orange: '#ff9c0e',
  blue: '#1368ce',
  green: '#26890c',
  pink: '#f0568f',
  white: '#ffffff',
  yellow: '#ffd400',
  brown: '#8a5a2b',
  black: '#1c1c1c',
  grey: '#6e7580',
};

/**
 * Picks the letter color by perceived luminance (sRGB linearization): white /
 * yellow get a dark letter, everything else a white one.
 */
export function avatarLetterColor(colorKey) {
  const hex = AVATAR_COLOR_HEX[colorKey] ?? AVATAR_COLOR_HEX.grey;
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.5 ? 'dark' : 'light';
}

/**
 * Builds the avatar element: a circle in the player's color with their first
 * letter, auto white or dark. Unknown colors degrade to grey.
 */
export function makeAvatar(name, colorKey) {
  const key = AVATAR_COLORS.includes(colorKey) ? colorKey : 'grey';
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.dataset.color = key;
  avatar.style.backgroundColor = AVATAR_COLOR_HEX[key];
  avatar.classList.add(`avatar-letter-${avatarLetterColor(key)}`);
  const letter = (name ?? '?').trim().charAt(0).toUpperCase() || '?';
  avatar.textContent = letter;
  return avatar;
}
