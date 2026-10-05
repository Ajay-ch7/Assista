// Voice shell. Lives in the side panel because the service worker has no microphone and
// is shut down when idle. Holds the microphone, the speaker and the backend WebSocket.

import { isAddressedTo, type Ack, type SnapshotReply, type ToWorker } from '../shared/messages';
import type { AudioFormat, ServerMessage } from '../shared/protocol';
import { cancelSay, say } from './localVoice';
import { Mic } from './mic';
import { Player } from './player';
import { BackendSocket } from './socket';

type TurnState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'done' | 'error';

/** Recording continues this long after release, so the last syllable is not cut off. */
const TAIL_MS = 150;

const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
const logEl = document.querySelector<HTMLOListElement>('#log')!;
const formEl = document.querySelector<HTMLFormElement>('#text-form')!;
const inputEl = document.querySelector<HTMLInputElement>('#text-input')!;
const talkButton = document.querySelector<HTMLButtonElement>('#talk-button')!;
const stopButton = document.querySelector<HTMLButtonElement>('#stop-button')!;

// Tests point the panel at their own backend with ?backend=ws://...
const backendUrl = new URLSearchParams(location.search).get('backend') ?? __BACKEND_WS_URL__;

const player = new Player();
const mic = new Mic();
const socket = new BackendSocket(backendUrl, {
  onMessage: onBackendMessage,
  onAudio: onBackendAudio,
  onState: (open) => {
    statusEl.dataset.connection = open ? 'open' : 'closed';
    setStatus(open ? 'Ready.' : 'Not connected to the Assista server.', 'idle');
  },
});

let turnCounter = 0;
/** The turn whose replies are accepted. Replies to any other turn are dropped. */
let activeTurn: string | null = null;
/** The turn the talk key is being held for. */
let listeningTurn: string | null = null;
/** The turn whose microphone audio is being sent. */
let streamingTurn: string | null = null;
/** True while a released turn is recording its tail. */
let closingTurn = false;
/** Format of the audio frames now arriving; null when they must be dropped. */
let incomingAudio: AudioFormat | null = null;
/** True once the user has stopped speech for the active turn. */
let muted = false;

function setStatus(text: string, turn: TurnState): void {
  statusEl.textContent = text;
  statusEl.dataset.turn = turn;
}

function log(role: 'user' | 'assistant' | 'error', text: string): void {
  const item = document.createElement('li');
  item.dataset.role = role;
  item.textContent = text;
  logEl.append(item);
  item.scrollIntoView({ block: 'end' });
}

/** Speaks a failure with the browser's voice, since it cannot come from the backend. */
function fail(text: string): void {
  log('error', text);
  setStatus(text, 'error');
  say(text);
}

function beginTurn(): string {
  stopSpeech();
  muted = false;
  activeTurn = `t${Date.now().toString(36)}-${++turnCounter}`;
  return activeTurn;
}

function stopSpeech(): void {
  player.stop();
  cancelSay();
  incomingAudio = null;
  muted = true;
}

function sendText(text: string): void {
  const turn = beginTurn();
  if (socket.send({ type: 'transcript', turn_id: turn, text })) setStatus('Thinking.', 'thinking');
  else fail('Assista cannot reach its server.');
}

async function startListening(): Promise<void> {
  if (listeningTurn || closingTurn) return;
  if (!socket.isOpen) {
    fail('Assista cannot reach its server.');
    return;
  }
  const turn = beginTurn();
  listeningTurn = turn;

  let format: AudioFormat;
  try {
    format = await mic.start((chunk) => {
      if (streamingTurn === turn) socket.sendAudio(chunk);
    });
  } catch (error) {
    if (listeningTurn === turn) listeningTurn = null;
    microphoneFailed(error);
    return;
  }
  if (listeningTurn !== turn) {
    // The key was released before the microphone was ready.
    mic.stop();
    return;
  }
  socket.send({ type: 'audio_start', turn_id: turn, format });
  streamingTurn = turn;
  player.beep(880, 0.08);
  setStatus('Listening.', 'listening');
}

/** Ends the spoken turn. With `cancel`, the recording is thrown away instead of answered. */
async function stopListening(cancel = false): Promise<void> {
  const turn = listeningTurn;
  if (!turn) return;
  listeningTurn = null;
  if (streamingTurn !== turn) return;

  if (cancel) {
    // The protocol has no cancel message, so the turn is closed and its replies ignored.
    activeTurn = null;
  } else {
    closingTurn = true;
    await new Promise((resolve) => setTimeout(resolve, TAIL_MS));
    closingTurn = false;
  }
  streamingTurn = null;
  mic.stop();
  socket.send({ type: 'audio_end', turn_id: turn });
  if (cancel) {
    setStatus('Ready.', 'idle');
  } else {
    player.beep(660, 0.08);
    setStatus('Thinking.', 'thinking');
  }
}

function microphoneFailed(error: unknown): void {
  activeTurn = null;
  fail('Assista cannot use the microphone. A page is opening to ask for permission.');
  if (error instanceof DOMException && error.name === 'NotAllowedError') openPermissionPage();
}

function openPermissionPage(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
}

function onBackendMessage(msg: ServerMessage): void {
  if (msg.turn_id !== activeTurn) {
    incomingAudio = null;
    return;
  }
  switch (msg.type) {
    case 'transcript_final':
      log('user', msg.text);
      setStatus('Thinking.', 'thinking');
      break;
    case 'request_snapshot':
      void replyWithSnapshot(msg.turn_id);
      break;
    case 'speak_text':
      log('assistant', msg.text);
      player.startSentence();
      incomingAudio = muted ? null : (msg.audio ?? null);
      setStatus('Speaking.', 'speaking');
      break;
    case 'done':
      incomingAudio = null;
      setStatus('Ready.', 'done');
      break;
    case 'error':
      incomingAudio = null;
      fail(msg.message);
      break;
    default:
      console.warn(`Assista: ${msg.type} is not handled yet`);
  }
}

function onBackendAudio(chunk: ArrayBuffer): void {
  if (incomingAudio) player.enqueue(chunk, incomingAudio);
}

async function replyWithSnapshot(turn: string): Promise<void> {
  let reply: SnapshotReply;
  try {
    reply = await chrome.runtime.sendMessage<ToWorker, SnapshotReply>({
      to: 'worker',
      kind: 'get_snapshot',
    });
  } catch (error) {
    reply = { ok: false, error: String(error) };
  }
  if (turn !== activeTurn) return;
  socket.send(
    reply.ok
      ? { type: 'snapshot', turn_id: turn, snapshot: reply.snapshot }
      : { type: 'snapshot', turn_id: turn, snapshot: null, error: reply.error },
  );
}

formEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  sendText(text);
});

talkButton.addEventListener('pointerdown', () => void startListening());
for (const type of ['pointerup', 'pointerleave', 'pointercancel'] as const) {
  talkButton.addEventListener(type, () => void stopListening());
}
stopButton.addEventListener('click', stopSpeech);

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!isAddressedTo(msg, 'panel')) return false;
  const ack: Ack = { ok: true };
  sendResponse(ack);
  return false;
});

async function askForMicrophoneOnce(): Promise<void> {
  const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
  if (status.state === 'prompt') openPermissionPage();
}

socket.connect();
void askForMicrophoneOnce().catch(() => undefined);
