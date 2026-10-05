import { describe, expect, it } from 'vitest';
import { bytesToBase64, cropFor } from './screenshot';

const viewport = { width: 1000, height: 600 };

describe('cropFor', () => {
  it('uses the whole image for the full view, scaled to the size limit', () => {
    expect(cropFor({ viewport, rect: null }, { width: 2000, height: 1200 })).toEqual({
      sx: 0,
      sy: 0,
      sw: 2000,
      sh: 1200,
      width: 1280,
      height: 768,
    });
  });

  it('maps an element from CSS pixels onto a high-density capture', () => {
    const rect = { x: 100, y: 50, width: 200, height: 100 };
    expect(cropFor({ viewport, rect }, { width: 2000, height: 1200 })).toEqual({
      sx: 200,
      sy: 100,
      sw: 400,
      sh: 200,
      width: 400,
      height: 200,
    });
  });

  it('clips an element that runs off the screen', () => {
    const rect = { x: -50, y: 500, width: 200, height: 300 };
    expect(cropFor({ viewport, rect }, { width: 1000, height: 600 })).toEqual({
      sx: 0,
      sy: 500,
      sw: 150,
      sh: 100,
      width: 150,
      height: 100,
    });
  });

  it('returns null for an element that is not on screen', () => {
    const below = { x: 0, y: 700, width: 100, height: 100 };
    const empty = { x: 10, y: 10, width: 0, height: 0 };
    expect(cropFor({ viewport, rect: below }, { width: 1000, height: 600 })).toBeNull();
    expect(cropFor({ viewport, rect: empty }, { width: 1000, height: 600 })).toBeNull();
  });
});

describe('bytesToBase64', () => {
  it('matches the standard encoding, also for large inputs', () => {
    expect(bytesToBase64(new TextEncoder().encode('Assista'))).toBe('QXNzaXN0YQ==');
    const big = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(bytesToBase64(big)).toBe(Buffer.from(big).toString('base64'));
  });
});
