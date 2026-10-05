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

  /** Decodes a sound file, such as a cue, for `playClip`. */
  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.context().decodeAudioData(data);
  }

  /**
   * Plays a short sound at normal speed: now, or after the speech already queued. `stop`
   * silences it like speech.
   */
  playClip(buffer: AudioBuffer, afterSpeech = false): void {
    const ctx = this.context();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const now = ctx.currentTime + 0.01;
    source.start(afterSpeech ? Math.max(this.nextTime, now) : now);
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  private context(): AudioContext {
    this.ctx ??= this.createContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }
}
