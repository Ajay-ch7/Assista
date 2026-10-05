import { describe, expect, it } from 'vitest';
import { Player } from './player';

const PCM = { encoding: 'pcm_s16le', sample_rate: 16000, channels: 1 } as const;

/** Records what the player schedules, with time standing still at zero. */
function fakeContext() {
  const started: { at: number; rate: number }[] = [];
  const ctx = {
    currentTime: 0,
    state: 'running',
    destination: {},
    createBuffer: (_channels: number, length: number, rate: number) => ({
      duration: length / rate,
      copyToChannel: () => undefined,
    }),
    createBufferSource: () => {
      const source = {
        buffer: null,
        playbackRate: { value: 1 },
        onended: null,
        connect: () => undefined,
        start: (at: number) => started.push({ at, rate: source.playbackRate.value }),
        stop: () => undefined,
      };
      return source;
    },
  };
  return { ctx: ctx as unknown as AudioContext, started };
}

/** One second of silence at 16 kHz. */
const SECOND = new ArrayBuffer(32000);

describe('Player', () => {
  it('plays chunks back to back at normal speed', () => {
    const { ctx, started } = fakeContext();
    const player = new Player(() => ctx);
    player.enqueue(SECOND, PCM);
    player.enqueue(SECOND, PCM);
    expect(started).toEqual([
      { at: 0.03, rate: 1 },
      { at: 1.03, rate: 1 },
    ]);
  });

  it('plays faster and schedules the next chunk sooner', () => {
    const { ctx, started } = fakeContext();
    const player = new Player(() => ctx);
    player.rate = 2;
    player.enqueue(SECOND, PCM);
    player.enqueue(SECOND, PCM);
    expect(started).toEqual([
      { at: 0.03, rate: 2 },
      { at: 0.53, rate: 2 },
    ]);
  });
});
