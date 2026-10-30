import { describe, expect, it } from 'vitest';
import { generatePin } from './pin.js';

describe('generatePin', () => {
  it('returns exactly 6 digits', () => {
    for (let i = 0; i < 100; i++) {
      expect(generatePin()).toMatch(/^\d{6}$/);
    }
  });

  it('is numeric and within the 6-digit range', () => {
    for (let i = 0; i < 100; i++) {
      const pin = Number(generatePin());
      expect(pin).toBeGreaterThanOrEqual(0);
      expect(pin).toBeLessThan(1_000_000);
    }
  });

  it('varies across calls (random source is used)', () => {
    const pins = new Set(Array.from({ length: 50 }, () => generatePin()));
    expect(pins.size).toBeGreaterThan(1);
  });
});
