// Sound cues (F18): every state the user cannot see is heard instead. Listening rises,
// thinking ticks while the answer is on its way, done falls after the reply, error drops
// low, link and alert come from the backend. Private is played by the panel alone, when
// focus moves to a field the user must type themselves.

import type { CueName } from '../shared/protocol';
import type { Player } from './player';

export const CUE_NAMES: readonly CueName[] = [
  'listening',
  'thinking',
  'link',
  'error',
  'done',
  'alert',
];
/** The backend's cues, plus the ones only the panel plays. */
export type CueSound = CueName | 'private';
export const CUE_SOUNDS: readonly CueSound[] = [...CUE_NAMES, 'private'];

/** How often the thinking cue repeats while the user waits. */
export const THINKING_EVERY_MS = 2500;

type Loader = (name: CueSound) => Promise<ArrayBuffer>;

const fetchCue: Loader = async (name) => {
  const response = await fetch(chrome.runtime.getURL(`cues/${name}.wav`));
  if (!response.ok) throw new Error(`cue ${name}: ${response.status}`);
  return response.arrayBuffer();
};

export class Cues {
  private readonly buffers = new Map<CueSound, Promise<AudioBuffer>>();
  private thinkingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly player: Pick<Player, 'decode' | 'playClip'>,
    private readonly load: Loader = fetchCue,
  ) {}

  /** Plays a cue now, or after the speech already queued. A cue that fails to load is skipped. */
  async play(name: CueSound, afterSpeech = false): Promise<void> {
    try {
      this.player.playClip(await this.buffer(name), afterSpeech);
    } catch (error) {
      console.warn(`Assista: could not play the ${name} cue`, error);
    }
  }

  /** Ticks now and every few seconds until `stopThinking`, so a long wait is heard. */
  startThinking(): void {
    this.stopThinking();
    void this.play('thinking');
    this.thinkingTimer = setInterval(() => void this.play('thinking'), THINKING_EVERY_MS);
  }

  stopThinking(): void {
    clearInterval(this.thinkingTimer);
    this.thinkingTimer = undefined;
  }

  get thinking(): boolean {
    return this.thinkingTimer !== undefined;
  }

  private buffer(name: CueSound): Promise<AudioBuffer> {
    let buffer = this.buffers.get(name);
    if (!buffer) {
      buffer = this.load(name).then((data) => this.player.decode(data));
      // A failed load is tried again next time.
      buffer.catch(() => this.buffers.delete(name));
      this.buffers.set(name, buffer);
    }
    return buffer;
  }
}
