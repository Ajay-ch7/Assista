// WebSocket protocol between the voice shell and the backend (implementation.md section 5.1).
// JSON text frames for control, binary frames for audio. Every message carries turn_id.
// backend/app/protocol.py mirrors this file; change both together.

import type { PageSnapshot } from './snapshot';

/** Binary audio frames are raw PCM in this format, in both directions. */
export interface AudioFormat {
  encoding: 'pcm_s16le';
  sample_rate: number;
  channels: 1;
}

export type Verbosity = 'brief' | 'normal' | 'detailed';
export type CueName = 'listening' | 'thinking' | 'link' | 'error' | 'done' | 'alert';

// Extension to backend

/** Opens a spoken turn. Binary chunks follow until audio_end. */
export interface AudioStartMessage {
  type: 'audio_start';
  turn_id: string;
  format: AudioFormat;
}

export interface AudioEndMessage {
  type: 'audio_end';
  turn_id: string;
}

/** Text-mode turn; skips speech-to-text. */
export interface TranscriptMessage {
  type: 'transcript';
  turn_id: string;
  text: string;
}

/** Reply to request_snapshot. snapshot is null when the page cannot be read. */
export interface SnapshotMessage {
  type: 'snapshot';
  turn_id: string;
  snapshot: PageSnapshot | null;
  error?: string;
}

/** Reply to request_screenshot; the full view, or one element when ref is set. */
export interface ScreenshotMessage {
  type: 'screenshot';
  turn_id: string;
  /** Base64 image data, or null when the capture failed. */
  image: string | null;
  mime?: string;
  ref?: string;
  error?: string;
}

export interface ToolResultMessage {
  type: 'tool_result';
  turn_id: string;
  call_id: string;
  ok: boolean;
  /** True when the confirmation gate held the action. */
  held_by_gate?: boolean;
  result?: unknown;
  error?: string;
}

/** The user's yes or no to a confirm_request. */
export interface ConfirmMessage {
  type: 'confirm';
  turn_id: string;
  confirm_id: string;
  approved: boolean;
}

export interface SettingsMessage {
  type: 'settings';
  turn_id: string;
  verbosity: Verbosity;
  private_mode: boolean;
}

export type ClientMessage =
  | AudioStartMessage
  | AudioEndMessage
  | TranscriptMessage
  | SnapshotMessage
  | ScreenshotMessage
  | ToolResultMessage
  | ConfirmMessage
  | SettingsMessage;

// Backend to extension

/** What the user said. */
export interface TranscriptFinalMessage {
  type: 'transcript_final';
  turn_id: string;
  text: string;
}

export interface RequestSnapshotMessage {
  type: 'request_snapshot';
  turn_id: string;
}

export interface RequestScreenshotMessage {
  type: 'request_screenshot';
  turn_id: string;
  /** Crop to this element; the full view when absent. */
  ref?: string;
}

/** One action on a snapshot reference id. */
export interface ToolCallMessage {
  type: 'tool_call';
  turn_id: string;
  call_id: string;
  name: string;
  snapshot_id: string;
  ref?: string;
  args: Record<string, unknown>;
}

/**
 * One sentence of the reply. When audio is set, the binary frames that follow, up to the
 * next JSON message, are this sentence's audio. In text mode audio is absent.
 */
export interface SpeakTextMessage {
  type: 'speak_text';
  turn_id: string;
  seq: number;
  text: string;
  audio?: AudioFormat | null;
}

export interface CueMessage {
  type: 'cue';
  turn_id: string;
  name: CueName;
}

/** Read-back text for an action held by the gate. */
export interface ConfirmRequestMessage {
  type: 'confirm_request';
  turn_id: string;
  confirm_id: string;
  text: string;
}

export interface DoneMessage {
  type: 'done';
  turn_id: string;
}

export interface ErrorMessage {
  type: 'error';
  turn_id: string;
  code: string;
  /** A sentence that can be spoken to the user. */
  message: string;
}

export type ServerMessage =
  | TranscriptFinalMessage
  | RequestSnapshotMessage
  | RequestScreenshotMessage
  | ToolCallMessage
  | SpeakTextMessage
  | CueMessage
  | ConfirmRequestMessage
  | DoneMessage
  | ErrorMessage;

export const SERVER_MESSAGE_TYPES: readonly ServerMessage['type'][] = [
  'transcript_final',
  'request_snapshot',
  'request_screenshot',
  'tool_call',
  'speak_text',
  'cue',
  'confirm_request',
  'done',
  'error',
];

/** Parses one JSON text frame. Returns null for anything that is not a known backend message. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const { type, turn_id } = data as { type?: unknown; turn_id?: unknown };
  if (typeof turn_id !== 'string') return null;
  if (!(SERVER_MESSAGE_TYPES as readonly unknown[]).includes(type)) return null;
  return data as ServerMessage;
}
