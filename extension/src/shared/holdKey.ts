// F09: press and hold a key to talk, release to send; a separate key stops speech.
// Used by the content script (focus in a page) and by the panel (focus in the panel).

export interface KeySettings {
  /** KeyboardEvent.key of the key held to talk. */
  talkKey: string;
  /** How long the talk key must be held, alone, before listening starts. */
  holdMs: number;
  /** KeyboardEvent.key of the key that stops speech. */
  stopKey: string;
}

export const DEFAULT_KEYS: KeySettings = { talkKey: 'Control', holdMs: 400, stopKey: 'Escape' };

export interface HoldKeyCallbacks {
  onTalkStart(): void;
  onTalkEnd(): void;
  /** Another key joined the hold after listening began: discard the recording. */
  onTalkCancel(): void;
  onStop(): void;
}

interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * idle: the talk key is up.
 * pending: the talk key is down but has not been held long enough.
 * talking: listening has started.
 * spoiled: another key or the mouse joined the hold, so this press is a shortcut such as
 *   Ctrl+C, not a request to talk. Nothing happens until the talk key is released.
 */
type State = 'idle' | 'pending' | 'talking' | 'spoiled';

export class HoldKeyMachine {
  private state: State = 'idle';
  private timer: unknown;

  constructor(
    private settings: KeySettings,
    private readonly callbacks: HoldKeyCallbacks,
    private readonly timers: Timers = realTimers,
  ) {}

  configure(settings: KeySettings): void {
    this.reset();
    this.settings = settings;
  }

  keyDown(key: string, repeat = false): void {
    if (key === this.settings.talkKey) {
      if (repeat || this.state !== 'idle') return;
      this.state = 'pending';
      this.timer = this.timers.set(() => {
        this.state = 'talking';
        this.callbacks.onTalkStart();
      }, this.settings.holdMs);
      return;
    }
    if (key === this.settings.stopKey && !repeat) this.callbacks.onStop();
    this.interrupt();
  }

  keyUp(key: string): void {
    if (key !== this.settings.talkKey) return;
    const was = this.state;
    this.timers.clear(this.timer);
    this.state = 'idle';
    if (was === 'talking') this.callbacks.onTalkEnd();
  }

  /** Another key, a mouse button or the wheel was used while the talk key is down. */
  interrupt(): void {
    if (this.state === 'pending') {
      this.timers.clear(this.timer);
      this.state = 'spoiled';
    } else if (this.state === 'talking') {
      this.state = 'spoiled';
      this.callbacks.onTalkCancel();
    }
  }

  /** The window lost focus, so the key-up event will never arrive. */
  reset(): void {
    const was = this.state;
    this.timers.clear(this.timer);
    this.state = 'idle';
    if (was === 'talking') this.callbacks.onTalkCancel();
  }
}

/** Feeds a window's keyboard and mouse events into the machine. */
export function attachHoldKey(target: Window, machine: HoldKeyMachine): void {
  const options = { capture: true, passive: true } as const;
  target.addEventListener('keydown', (event) => machine.keyDown(event.key, event.repeat), options);
  target.addEventListener('keyup', (event) => machine.keyUp(event.key), options);
  target.addEventListener('mousedown', () => machine.interrupt(), options);
  target.addEventListener('wheel', () => machine.interrupt(), options);
  target.addEventListener('blur', () => machine.reset());
}
