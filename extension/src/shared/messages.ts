// Messages between the panel, the service worker and content scripts (chrome.runtime).
// Each message names its recipient in `to`; every listener ignores what is not addressed to it.

import type { PageSnapshot } from './snapshot';

export type TalkPhase = 'down' | 'up' | 'cancel';

export type ToWorker =
  | { to: 'worker'; kind: 'talk_key'; phase: TalkPhase }
  | { to: 'worker'; kind: 'stop_key' }
  | { to: 'worker'; kind: 'get_snapshot' };

export type ToPanel =
  | { to: 'panel'; kind: 'talk_key'; phase: TalkPhase }
  | { to: 'panel'; kind: 'talk_toggle' }
  | { to: 'panel'; kind: 'stop_key' };

export type ToContent = { to: 'content'; kind: 'build_snapshot' };

export type Ack = { ok: true } | { ok: false; error: string };
export type SnapshotReply = { ok: true; snapshot: PageSnapshot } | { ok: false; error: string };

export function isAddressedTo<T extends 'worker' | 'panel' | 'content'>(
  msg: unknown,
  to: T,
): msg is Extract<ToWorker | ToPanel | ToContent, { to: T }> {
  return typeof msg === 'object' && msg !== null && (msg as { to?: unknown }).to === to;
}
