// Messages between the panel, the service worker and content scripts (chrome.runtime).
// Each message names its recipient in `to`; every listener ignores what is not addressed to it.

import type { GateHold } from '../safety/gate';
import type { PageSnapshot } from './snapshot';

export type TalkPhase = 'down' | 'up' | 'cancel';

export type ToWorker =
  | { to: 'worker'; kind: 'talk_key'; phase: TalkPhase }
  | { to: 'worker'; kind: 'stop_key' }
  | { to: 'worker'; kind: 'get_snapshot' }
  | { to: 'worker'; kind: 'get_screenshot'; ref?: string }
  | { to: 'worker'; kind: 'run_tool'; tool: ToolRequest };

export type ToPanel =
  | { to: 'panel'; kind: 'talk_key'; phase: TalkPhase }
  | { to: 'panel'; kind: 'talk_toggle' }
  | { to: 'panel'; kind: 'stop_key' };

export type ToContent =
  | { to: 'content'; kind: 'build_snapshot' }
  | { to: 'content'; kind: 'prepare_capture'; ref?: string }
  | { to: 'content'; kind: 'end_capture' }
  | { to: 'content'; kind: 'run_action'; tool: ToolRequest };

export type Ack = { ok: true } | { ok: false; error: string };
export type SnapshotReply = { ok: true; snapshot: PageSnapshot } | { ok: false; error: string };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the element to crop sits in the viewport, in CSS pixels; null for the full view. */
export interface CaptureFrame {
  viewport: { width: number; height: number };
  rect: Rect | null;
}

export type CaptureReply = ({ ok: true } & CaptureFrame) | { ok: false; error: string };

/** A screenshot as base64 image data. */
export type ScreenshotReply =
  { ok: true; image: string; mime: string } | { ok: false; error: string };

/** One action tool to run, as the backend's tool_call asked for it. */
export interface ToolRequest {
  name: string;
  /** The snapshot `ref` belongs to. An action on an older snapshot is refused. */
  snapshotId: string;
  ref?: string;
  args: Record<string, unknown>;
  /**
   * Releases an action the confirmation gate held. Only the panel sets this, and only
   * after the user said yes; it names the control the user heard read back.
   */
  confirmed?: { control: string };
}

/** What an action did, for the model's next step and for the action log. */
export interface ActionDone {
  action: string;
  target?: { role: string; name: string };
  /** The text typed, the option chosen, or where a scroll ended. */
  detail?: string;
}

export type ActionReply =
  | { ok: true; result: ActionDone }
  | {
      ok: false;
      error: string;
      /** The confirmation gate held the action; nothing was done. */
      held?: GateHold;
      /** The field is sensitive: focus was moved to it, and the user must type it. */
      sensitive?: { field: string };
    };

export function isAddressedTo<T extends 'worker' | 'panel' | 'content'>(
  msg: unknown,
  to: T,
): msg is Extract<ToWorker | ToPanel | ToContent, { to: T }> {
  return typeof msg === 'object' && msg !== null && (msg as { to?: unknown }).to === to;
}
