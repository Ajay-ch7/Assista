import { describe, expect, it } from 'vitest';
import { PcmDecoder } from './pcm';

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

describe('PcmDecoder', () => {
  it('decodes little-endian 16-bit samples', () => {
    const samples = new PcmDecoder().decode(bytes(0x00, 0x00, 0x00, 0x40, 0x00, 0x80));
    expect(Array.from(samples)).toEqual([0, 0.5, -1]);
  });

  it('joins a sample split across two chunks', () => {
    const decoder = new PcmDecoder();
    expect(decoder.decode(bytes(0x00, 0x40, 0x00)).length).toBe(1);
    expect(Array.from(decoder.decode(bytes(0x40)))).toEqual([0.5]);
  });

  it('drops the pending byte on reset', () => {
    const decoder = new PcmDecoder();
    decoder.decode(bytes(0x7f));
    decoder.reset();
    expect(Array.from(decoder.decode(bytes(0x00, 0x40)))).toEqual([0.5]);
  });
});
