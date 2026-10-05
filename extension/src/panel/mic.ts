import type { AudioFormat } from '../shared/protocol';

const SAMPLE_RATE = 16000;
/** The microphone is released after this long without a spoken turn. */
const RELEASE_AFTER_MS = 30_000;

type ChunkSink = (chunk: ArrayBuffer) => void;

interface Capture {
  stream: MediaStream;
  ctx: AudioContext;
}

/**
 * Microphone capture as 16-bit PCM chunks. The stream stays open between turns for a
 * short while, so the next press of the talk key starts recording without delay.
 */
export class Mic {
  private capture: Promise<Capture> | null = null;
  private sink: ChunkSink | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;

  /** Starts sending chunks to `sink`. Rejects when the microphone is unavailable. */
  async start(sink: ChunkSink): Promise<AudioFormat> {
    clearTimeout(this.releaseTimer);
    this.capture ??= this.open();
    let capture: Capture;
    try {
      capture = await this.capture;
    } catch (error) {
      this.capture = null;
      throw error;
    }
    if (capture.ctx.state === 'suspended') await capture.ctx.resume();
    this.sink = sink;
    return { encoding: 'pcm_s16le', sample_rate: capture.ctx.sampleRate, channels: 1 };
  }

  stop(): void {
    this.sink = null;
    clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => void this.release(), RELEASE_AFTER_MS);
  }

  private async open(): Promise<Capture> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    // Chrome resamples the microphone to the context's rate.
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
    const worklet = new AudioWorkletNode(ctx, 'pcm-capture');
    worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => this.sink?.(event.data);

    // The worklet only runs while it leads to the output, so route it there in silence.
    const silence = ctx.createGain();
    silence.gain.value = 0;
    ctx.createMediaStreamSource(stream).connect(worklet).connect(silence).connect(ctx.destination);
    return { stream, ctx };
  }

  private async release(): Promise<void> {
    const pending = this.capture;
    this.capture = null;
    if (!pending) return;
    const capture = await pending.catch(() => null);
    capture?.stream.getTracks().forEach((track) => track.stop());
    await capture?.ctx.close();
  }
}
