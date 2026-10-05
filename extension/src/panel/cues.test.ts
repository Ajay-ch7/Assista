import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CueName } from '../shared/protocol';
import { CUE_NAMES, Cues, THINKING_EVERY_MS } from './cues';

function fakePlayer() {
  const played: { buffer: unknown; afterSpeech: boolean }[] = [];
  return {
    played,
    decode: vi.fn(async (data: ArrayBuffer) => ({ decoded: new TextDecoder().decode(data) })),
    playClip: (buffer: unknown, afterSpeech = false) => played.push({ buffer, afterSpeech }),
  };
}

const load = vi.fn(async (name: CueName) => new TextEncoder().encode(name).buffer as ArrayBuffer);

afterEach(() => {
  vi.useRealTimers();
  load.mockClear();
});

describe('Cues', () => {
  it('has a sound file for every cue', () => {
    const files = readdirSync(resolve(import.meta.dirname, '../../public/cues'));
    expect(files.sort()).toEqual(CUE_NAMES.map((name) => `${name}.wav`).sort());
  });

  it('loads each cue once and plays it now or after the speech', async () => {
    const player = fakePlayer();
    const cues = new Cues(player as never, load);
    await cues.play('done', true);
    await cues.play('done');
    expect(load).toHaveBeenCalledTimes(1);
    expect(player.played).toEqual([
      { buffer: { decoded: 'done' }, afterSpeech: true },
      { buffer: { decoded: 'done' }, afterSpeech: false },
    ]);
  });

  it('skips a cue that will not load, and tries again next time', async () => {
    const player = fakePlayer();
    const failing = vi.fn().mockRejectedValueOnce(new Error('404')).mockImplementation(load);
    const cues = new Cues(player as never, failing);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await cues.play('alert');
    await cues.play('alert');
    expect(player.played).toHaveLength(1);
  });

  it('ticks while thinking, until stopped', async () => {
    vi.useFakeTimers();
    const player = fakePlayer();
    const cues = new Cues(player as never, load);
    cues.startThinking();
    expect(cues.thinking).toBe(true);
    await vi.advanceTimersByTimeAsync(THINKING_EVERY_MS * 2 + 10);
    expect(player.played).toHaveLength(3);
    cues.stopThinking();
    await vi.advanceTimersByTimeAsync(THINKING_EVERY_MS * 3);
    expect(player.played).toHaveLength(3);
    expect(cues.thinking).toBe(false);
  });
});
