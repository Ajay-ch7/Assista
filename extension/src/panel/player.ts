import type { AudioFormat } from '../shared/protocol';
import { PcmDecoder } from './pcm';

/** Plays streamed PCM speech as it arrives, chunk after chunk without gaps. */
export class Player {
  private ctx: AudioContext | null = null;
  private nextTime = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly decoder = new PcmDecoder();
  /** Playback rate of speech; 1 is normal. Applies to audio queued from now on. */
  rate = 1;

  constructor(private readonly createContext: () => AudioContext = () => new AudioContext()) {}

  get playing(): boolean {
    return this.sources.size > 0;
  }

  /** Call when a new sentence's audio is about to arrive. */
  startSentence(): void {
    this.decoder.reset();
  }

  enqueue(chunk: ArrayBuffer, format: AudioFormat): void {
    const samples = this.decoder.decode(chunk);
    if (samples.length === 0) return;
    const ctx = this.context();
    const buffer = ctx.createBuffer(1, samples.length, format.sample_rate);
    buffer.copyToChannel(samples, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = this.rate;
    source.connect(ctx.destination);
    const startAt = Math.max(this.nextTime, ctx.currentTime + 0.03);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration / this.rate;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  /** Silences everything queued or playing. */
  stop(): void {
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
    }
    this.sources.clear();
    this.nextTime = 0;
    this.decoder.reset();
  }

  /** A short tone. Stands in for the sound cues until P2.8 adds the cue files. */
  beep(frequency: number, seconds: number): void {
    const ctx = this.context();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.value = 0.15;
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + seconds);
  }

  private context(): AudioContext {
    this.ctx ??= this.createContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }
}
