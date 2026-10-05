import { parseServerMessage, type ClientMessage, type ServerMessage } from '../shared/protocol';

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 10_000;
const OPEN = 1;

export interface SocketHandlers {
  onMessage(msg: ServerMessage): void;
  onAudio(chunk: ArrayBuffer): void;
  onState(open: boolean): void;
}

type SocketCtor = new (url: string) => WebSocket;

/** The session's one WebSocket to the backend. Reconnects by itself when the link drops. */
export class BackendSocket {
  private ws: WebSocket | null = null;
  private retryMs = FIRST_RETRY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly handlers: SocketHandlers,
    private readonly Ctor: SocketCtor = WebSocket,
  ) {}

  get isOpen(): boolean {
    return this.ws?.readyState === OPEN;
  }

  connect(): void {
    this.closed = false;
    const ws = new this.Ctor(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.retryMs = FIRST_RETRY_MS;
      this.handlers.onState(true);
    };
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        const msg = parseServerMessage(event.data);
        if (msg) this.handlers.onMessage(msg);
        else console.warn('Assista: ignored an unknown backend message');
      } else if (event.data instanceof ArrayBuffer) {
        this.handlers.onAudio(event.data);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handlers.onState(false);
      if (this.closed) return;
      this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    };
  }

  /** Returns false when the message could not be sent because the socket is not open. */
  send(msg: ClientMessage): boolean {
    if (!this.isOpen) return false;
    this.ws!.send(JSON.stringify(msg));
    return true;
  }

  sendAudio(chunk: ArrayBuffer): boolean {
    if (!this.isOpen) return false;
    this.ws!.send(chunk);
    return true;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}
