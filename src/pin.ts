import { randomInt } from 'node:crypto';

/** Random 6-digit session PIN, digit-padded ("000123" is valid, "0123" is not). */
export function generatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
