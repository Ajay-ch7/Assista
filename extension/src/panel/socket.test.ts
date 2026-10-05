import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '../shared/protocol';
import { BackendSocket } from './socket';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  binaryType = '';
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
}

function setup() {
  const messages: ServerMessage[] = [];
  const audio: ArrayBuffer[] = [];
  const states: boolean[] = [];
  const socket = new BackendSocket(
    'ws://test/ws',
    {
      onMessage: (msg) => messages.push(msg),
      onAudio: (chunk) => audio.push(chunk),
      onState: (open) => states.push(open),
    },
    FakeWebSocket as unknown as new (url: string) => WebSocket,
  );
  socket.connect();
  return { socket, messages, audio, states, ws: () => FakeWebSocket.instances.at(-1)! };
}

describe('BackendSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    FakeWebSocket.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refuses to send until the socket is open', () => {
    const { socket, ws } = setup();
    expect(socket.send({ type: 'transcript', turn_id: 't1', text: 'hi' })).toBe(false);
    ws().open();
    expect(socket.send({ type: 'transcript', turn_id: 't1', text: 'hi' })).toBe(true);
    expect(JSON.parse(ws().sent[0] as string)).toEqual({
      type: 'transcript',
      turn_id: 't1',
      text: 'hi',
    });
  });

  it('separates JSON messages from audio and drops unknown messages', () => {
    const { messages, audio, ws } = setup();
    ws().open();
    expect(ws().binaryType).toBe('arraybuffer');
    ws().onmessage?.({ data: '{"type":"done","turn_id":"t1"}' });
    ws().onmessage?.({ data: '{"type":"mystery","turn_id":"t1"}' });
    ws().onmessage?.({ data: new ArrayBuffer(4) });
    expect(messages).toEqual([{ type: 'done', turn_id: 't1' }]);
    expect(audio).toHaveLength(1);
  });

  it('reconnects after the link drops, but not after close()', () => {
    const { socket, states, ws } = setup();
    ws().open();
    ws().close();
    expect(states).toEqual([true, false]);
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    ws().open();
    socket.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
