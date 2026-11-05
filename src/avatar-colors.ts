// Canonical avatar palette shared by join validation, the engine's Player
// record and the StateView projection. Pure data + a narrow type guard — no
// imports, so the engine stays dependency-free.
//
// The client keeps its own hex/color map in public/avatar.js (no bundler, and
// the browser never imports src/); the wire carries palette KEYS only, which
// keeps server and client coupled by this exact 10-key list.

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
] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];

export function isAvatarColor(value: unknown): value is AvatarColor {
  return (
    typeof value === 'string' && (AVATAR_COLORS as readonly string[]).includes(value)
  );
}
