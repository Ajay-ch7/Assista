// Voice shell. Lives in the side panel because the service worker has no microphone and
// is shut down when idle. Holds the microphone, the speaker and the backend WebSocket.

import { DEFAULT_KEYS, HoldKeyMachine, attachHoldKey } from '../shared/holdKey';
import {
  isAddressedTo,
  type Ack,
  type ActionReply,
  type DocumentReply,
  type ScreenshotReply,
  type SnapshotReply,
  type ToWorker,
  type ToolRequest,
} from '../shared/messages';
import { parseConfirmation } from '../shared/confirmation';
import { parseLocalCommand, type LocalCommand } from '../shared/localCommands';
import type { AudioFormat, ServerMessage, ToolCallMessage, Verbosity } from '../shared/protocol';
import {
  DEFAULT_PREFERENCES,
  MAX_SPEED,
  MIN_SPEED,
  SPEED_STEP,
  savePreferences,
  watchPreferences,
  type Preferences,
} from '../store/preferences';
import { describeActions, entryFor, loadActions, logAction } from '../store/actionLog';
import { forgetSavedDetails, saveDetail } from '../store/savedDetails';
import { watchKeySettings } from '../store/settings';
import { Cues, type CueSound } from './cues';
import { cancelSay, say, sayNext } from './localVoice';
import { readLocalPdf } from './localFile';
import { Mic } from './mic';
import { answerOnDevice, onDeviceState, type OnDeviceState } from './onDevice';
import { Player } from './player';
import { ReplyRecorder } from './replies';
import { BackendSocket } from './socket';
import { spellOut, spellTarget } from './spell';

type TurnState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'done' | 'error';

/** Recording continues this long after release, so the last syllable is not cut off. */
const TAIL_MS = 150;
/** Spelling is read a little slower than the user's speed. */
const SPELLING_RATE = 0.8;

const VERBOSITY_CONFIRMATIONS: Record<Verbosity, string> = {
  brief: 'I will keep my answers brief.',
  normal: 'I will give answers of normal length.',
  detailed: 'I will give more detail.',
};

const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
const logEl = document.querySelector<HTMLOListElement>('#log')!;
const formEl = document.querySelector<HTMLFormElement>('#text-form')!;
const inputEl = document.querySelector<HTMLInputElement>('#text-input')!;
const talkButton = document.querySelector<HTMLButtonElement>('#talk-button')!;
const stopButton = document.querySelector<HTMLButtonElement>('#stop-button')!;

// Tests point the panel at their own backend with ?backend=ws://...
const backendUrl = new URLSearchParams(location.search).get('backend') ?? __BACKEND_WS_URL__;

const player = new Player();
const cues = new Cues(player);
const mic = new Mic();
const socket = new BackendSocket(backendUrl, {
  onMessage: onBackendMessage,
  onAudio: onBackendAudio,
  onState: (open) => {
    statusEl.dataset.connection = open ? 'open' : 'closed';
    // A turn cut off by a lost connection is said aloud; otherwise it would just go quiet.
    const waiting = ['listening', 'thinking', 'speaking'].includes(statusEl.dataset.turn ?? '');
    if (!open && waiting) {
      activeTurn = listeningTurn = streamingTurn = null;
      mic.stop();
      fail('I lost the connection to the Assista server. Please try again in a moment.');
      return;
    }
    setStatus(open ? 'Ready.' : 'Not connected to the Assista server.', 'idle');
    if (open) sendSettings();
  },
});
/** The last reply, kept for "repeat" and "spell it". */
const replies = new ReplyRecorder();
let preferences: Preferences = DEFAULT_PREFERENCES;

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
/** True while the audio frames now arriving belong to a reply sentence worth keeping. */
let recordingAudio = false;
/** True when the active turn was a local command, which has its own spoken reply. */
let localTurn = false;
/** The reply sentence last received, to recognise one that is sent again. */
let lastSentence: { turn: string; seq: number } | null = null;

/** An action the confirmation gate is holding until the user says yes. */
interface HeldAction {
  id: string;
  callId: string;
  tool: ToolRequest;
  control: string;
  /** True once the backend has read the action back and asked the user. */
  asked: boolean;
}
let held: HeldAction | null = null;
/** Whether this device has Chrome's built-in model; checked when the panel starts. */
let onDevice: OnDeviceState = 'unavailable';
void onDeviceState().then((state) => {
  onDevice = state;
});
/** The user's latest requests, as heard. An action none of them names is held. */
const heard: string[] = [];
const HEARD_KEPT = 3;

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
  cues.stopThinking();
  void cues.play('error');
  log('error', text);
  setStatus(text, 'error');
  say(text);
}

/** Tells the user something no turn asked for: a watch firing, a session about to end. */
function announce(text: string, cue?: CueSound): void {
  if (cue) void cues.play(cue);
  log('assistant', text);
  say(text, preferences.speed);
}

function beginTurn(): string {
  stopSpeech();
  muted = false;
  localTurn = false;
  activeTurn = `t${Date.now().toString(36)}-${++turnCounter}`;
  return activeTurn;
}

function stopSpeech(): void {
  cues.stopThinking();
  player.stop();
  cancelSay();
  incomingAudio = null;
  muted = true;
}

function sendSettings(): void {
  socket.send({
    type: 'settings',
    turn_id: 'settings',
    verbosity: preferences.verbosity,
    private_mode: preferences.privateMode,
  });
}

/** True when private mode is on and this device can answer by itself. */
function answersOnDevice(): boolean {
  return preferences.privateMode && onDevice === 'available';
}

/**
 * Private mode with the on-device model: the page is read and the question answered
 * here, and neither is sent anywhere. `typed` requests have not been logged yet.
 */
async function answerPrivately(text: string, typed: boolean): Promise<void> {
  if (typed) {
    stopSpeech();
    log('user', text);
  }
  setStatus('Thinking.', 'thinking');
  cues.startThinking();
  try {
    const reply = await chrome.runtime.sendMessage<ToWorker, SnapshotReply>({
      to: 'worker',
      kind: 'get_snapshot',
    });
    if (!reply.ok) throw new Error(reply.error);
    const answer = await answerOnDevice(text, reply.snapshot);
    cues.stopThinking();
    answerLocally(answer || 'I have no answer for that.');
  } catch {
    fail('I could not answer on this device. Say private mode off to use the online model.');
  }
}

const PRIVATE_ON_DEVICE =
  'Private mode is on. I will answer from this device, so the page stays here. I can ' +
  'only read in private mode, and your voice is still sent for speech recognition.';
const PRIVATE_ONLINE =
  'Private mode is on. This device has no built-in model, so I will keep using the ' +
  'online one, with private fields hidden and without sending pictures of your screen.';

async function setPrivateMode(on: boolean): Promise<void> {
  preferences = await savePreferences({ privateMode: on });
  sendSettings();
  if (!on) answerLocally('Private mode is off.');
  else answerLocally(onDevice === 'available' ? PRIVATE_ON_DEVICE : PRIVATE_ONLINE);
}

/** Says something that is not part of a backend reply, at the user's speed. */
function answerLocally(text: string, rate = preferences.speed): void {
  log('assistant', text);
  setStatus(text, 'done');
  say(text, rate);
}

/** Handles stop, repeat, speed, detail and spelling in the panel; they never reach the model. */
function runLocalCommand(command: LocalCommand): void {
  stopSpeech();
  switch (command.kind) {
    case 'stop':
      setStatus('Stopped.', 'done');
      break;
    case 'repeat':
      repeatLastReply();
      break;
    case 'slower':
    case 'faster':
      void changeSpeed(command.kind === 'faster' ? SPEED_STEP : -SPEED_STEP);
      break;
    case 'verbosity':
      void savePreferences({ verbosity: command.level });
      answerLocally(VERBOSITY_CONFIRMATIONS[command.level]);
      break;
    case 'actions':
      // Read from the device; the log never leaves it.
      void loadActions().then(
        (entries) => answerLocally(describeActions(entries)),
        () => answerLocally('I could not read my action log.'),
      );
      break;
    case 'private_on':
    case 'private_off':
      void setPrivateMode(command.kind === 'private_on');
      break;
    case 'forget':
      void forgetSavedDetails().then(
        () => answerLocally('I have forgotten your saved details.'),
        () => answerLocally('I could not clear your saved details.'),
      );
      break;
    case 'spell': {
      const target = command.text ?? spellTarget(replies.text);
      if (target) answerLocally(spellOut(target), preferences.speed * SPELLING_RATE);
      else answerLocally('There is nothing to spell yet.');
      break;
    }
  }
}

function repeatLastReply(): void {
  if (!replies.last.length) {
    answerLocally('I have not said anything yet.');
    return;
  }
  setStatus('Repeating.', 'done');
  if (!replies.hasAudio) {
    say(replies.text, preferences.speed);
    return;
  }
  for (const sentence of replies.last) {
    player.startSentence();
    for (const chunk of sentence.chunks) player.enqueue(chunk, sentence.format!);
  }
}

async function changeSpeed(step: number): Promise<void> {
  const speed = preferences.speed + step;
  if (speed > MAX_SPEED || speed < MIN_SPEED) {
    answerLocally(
      step > 0 ? 'This is the fastest I can speak.' : 'This is the slowest I can speak.',
    );
    return;
  }
  setStatus('Changing speed.', 'thinking');
  preferences = await savePreferences({ speed });
  player.rate = preferences.speed;
  answerLocally(step > 0 ? 'Faster.' : 'Slower.');
}

function sendText(text: string): void {
  const command = parseLocalCommand(text);
  if (command) {
    log('user', text);
    runLocalCommand(command);
    return;
  }
  if (answersOnDevice()) {
    void answerPrivately(text, true);
    return;
  }
  const turn = beginTurn();
  if (socket.send({ type: 'transcript', turn_id: turn, text })) {
    setStatus('Thinking.', 'thinking');
    cues.startThinking();
  } else {
    fail('Assista cannot reach its server.');
  }
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
  void cues.play('listening');
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
    cues.startThinking();
    setStatus('Thinking.', 'thinking');
  }
}

function microphoneFailed(error: unknown): void {
  activeTurn = null;
  fail('Assista cannot use the microphone. A page is opening to ask for permission.');
  if (error instanceof DOMException && error.name === 'NotAllowedError') openPermissionPage();
}

function openFileAccessSettings(): void {
  void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
}

function openPermissionPage(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
}

function onBackendMessage(msg: ServerMessage): void {
  if (msg.turn_id !== activeTurn) {
    incomingAudio = null;
    recordingAudio = false;
    return;
  }
  switch (msg.type) {
    case 'transcript_final': {
      log('user', msg.text);
      // A spoken local command: the backend ends the turn without answering.
      const command = parseLocalCommand(msg.text);
      if (command) {
        localTurn = true;
        runLocalCommand(command);
        break;
      }
      if (answersOnDevice()) {
        // The words came from the online recogniser; from here on the turn stays on
        // the device, and whatever else the backend sends for it is ignored.
        activeTurn = null;
        void answerPrivately(msg.text, false);
        break;
      }
      setStatus('Thinking.', 'thinking');
      heard.push(msg.text);
      heard.splice(0, heard.length - HEARD_KEPT);
      // Anything but a local command settles a held action: a clear yes runs it, a clear
      // no or any other request drops it.
      const waiting = held;
      held = null;
      if (waiting?.asked) {
        const answer = parseConfirmation(msg.text);
        if (answer !== null) void answerConfirmation(msg.turn_id, waiting, answer);
      }
      break;
    }
    case 'request_snapshot':
      void replyWithSnapshot(msg.turn_id);
      break;
    case 'request_screenshot':
      void replyWithScreenshot(msg.turn_id, msg.ref);
      break;
    case 'request_document':
      void replyWithDocument(msg.turn_id);
      break;
    case 'speak_text': {
      cues.stopThinking();
      // The same sentence sent again without audio: the backend's voice failed on it.
      const again = lastSentence?.turn === msg.turn_id && lastSentence.seq === msg.seq;
      lastSentence = { turn: msg.turn_id, seq: msg.seq };
      if (!again) {
        log('assistant', msg.text);
        replies.sentence(msg.turn_id, msg.text, msg.audio ?? null);
      }
      recordingAudio = Boolean(msg.audio);
      player.startSentence();
      incomingAudio = muted ? null : (msg.audio ?? null);
      // Every reply is heard: a sentence without audio is spoken by the browser's voice.
      if (!msg.audio && !muted) sayNext(msg.text, preferences.speed);
      setStatus('Speaking.', 'speaking');
      break;
    }
    case 'done':
      cues.stopThinking();
      if (!localTurn) void cues.play('done', true);
      incomingAudio = null;
      recordingAudio = false;
      if (statusEl.dataset.turn !== 'done') setStatus('Ready.', 'done');
      break;
    case 'error':
      incomingAudio = null;
      recordingAudio = false;
      fail(msg.message);
      break;
    case 'cue':
      void cues.play(msg.name);
      break;
    case 'tool_call':
      void runToolCall(msg);
      break;
    case 'confirm_request':
      if (held && msg.confirm_id === held.id) held.asked = true;
      break;
  }
}

function onBackendAudio(chunk: ArrayBuffer): void {
  if (recordingAudio) replies.audio(chunk);
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

async function replyWithScreenshot(turn: string, ref?: string): Promise<void> {
  let reply: ScreenshotReply;
  try {
    reply = await chrome.runtime.sendMessage<ToWorker, ScreenshotReply>({
      to: 'worker',
      kind: 'get_screenshot',
      ref,
    });
  } catch (error) {
    reply = { ok: false, error: String(error) };
  }
  if (turn !== activeTurn) return;
  socket.send(
    reply.ok
      ? { type: 'screenshot', turn_id: turn, image: reply.image, mime: reply.mime, ref }
      : { type: 'screenshot', turn_id: turn, image: null, ref, error: reply.error },
  );
}

async function replyWithDocument(turn: string): Promise<void> {
  let reply: DocumentReply;
  try {
    reply = await chrome.runtime.sendMessage<ToWorker, DocumentReply>({
      to: 'worker',
      kind: 'get_document',
    });
  } catch (error) {
    reply = { ok: false, error: String(error) };
  }
  // A PDF on the computer: the worker has checked it may be opened; the panel reads it.
  if (!reply.ok && reply.error === 'local_file' && reply.url) reply = await readLocalPdf(reply.url);
  // Not allowed yet: open Assista's details page, where the switch is. The backend tells
  // the user so.
  if (!reply.ok && reply.error === 'file_access_off') openFileAccessSettings();
  if (turn !== activeTurn) return;
  socket.send(
    reply.ok
      ? { type: 'document', turn_id: turn, url: reply.url, data: reply.data, mime: reply.mime }
      : { type: 'document', turn_id: turn, data: null, error: reply.error },
  );
}

/** Asks the service worker to run one action tool. */
async function runTool(tool: ToolRequest): Promise<ActionReply> {
  try {
    return await chrome.runtime.sendMessage<ToWorker, ActionReply>({
      to: 'worker',
      kind: 'run_tool',
      tool,
    });
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function runToolCall(call: ToolCallMessage): Promise<void> {
  // Only these fields of the backend's message are used; nothing else it sends can
  // change how the action runs.
  const tool: ToolRequest = {
    name: call.name,
    snapshotId: call.snapshot_id,
    ref: call.ref,
    args: call.args ?? {},
    heard: [...heard],
  };
  held = null;
  const reply = await runTool(tool);
  if (!reply.ok && reply.held) {
    held = {
      id: `h${Date.now().toString(36)}-${call.call_id}`,
      callId: call.call_id,
      tool,
      control: reply.held.control,
      asked: false,
    };
  }
  sendToolResult(call.turn_id, call.call_id, tool, reply);
}

/** Tells the backend the user's answer; on yes, runs the held action and reports it. */
async function answerConfirmation(
  turn: string,
  action: HeldAction,
  approved: boolean,
): Promise<void> {
  socket.send({ type: 'confirm', turn_id: turn, confirm_id: action.id, approved });
  if (!approved) {
    void logAction({
      at: Date.now(),
      tool: action.tool.name,
      target: action.control,
      outcome: 'declined',
    });
    return;
  }
  const tool: ToolRequest = { ...action.tool, confirmed: { control: action.control } };
  sendToolResult(turn, action.callId, tool, await runTool(tool));
}

function sendToolResult(turn: string, callId: string, tool: ToolRequest, reply: ActionReply): void {
  if (reply.ok && tool.name === 'click' && reply.result.target?.role === 'link') {
    void cues.play('link');
  }
  void logAction(entryFor(tool, reply, Date.now(), Boolean(tool.confirmed)));
  // A personal detail the user just gave is remembered on this device for other forms.
  if (reply.ok && reply.result.kind && reply.result.detail && !reply.result.fromSaved) {
    void saveDetail(reply.result.kind, reply.result.detail);
  }
  // Private mode: focus is now on a field the user must type themselves.
  if (!reply.ok && reply.sensitive) void cues.play('private');
  if (turn !== activeTurn) return;
  const base = { type: 'tool_result', turn_id: turn, call_id: callId } as const;
  if (reply.ok) {
    socket.send({ ...base, ok: true, result: reply.result });
  } else if (reply.held && held?.callId === callId) {
    socket.send({
      ...base,
      ok: false,
      held_by_gate: true,
      error: reply.error,
      result: { confirm_id: held.id, ...reply.held },
    });
  } else {
    socket.send({ ...base, ok: false, error: reply.error, result: reply.sensitive });
  }
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
  switch (msg.kind) {
    case 'talk_key':
      if (msg.phase === 'down') void startListening();
      else void stopListening(msg.phase === 'cancel');
      break;
    case 'talk_toggle':
      if (listeningTurn) void stopListening();
      else void startListening();
      break;
    case 'stop_key':
      stopSpeech();
      break;
    case 'announce':
      announce(msg.text, msg.cue);
      break;
  }
  const ack: Ack = { ok: true };
  sendResponse(ack);
  return false;
});

// The same keys work while focus is in the panel itself.
const holdKey = new HoldKeyMachine(DEFAULT_KEYS, {
  onTalkStart: () => void startListening(),
  onTalkEnd: () => void stopListening(),
  onTalkCancel: () => void stopListening(true),
  onStop: stopSpeech,
});
attachHoldKey(window, holdKey);
watchKeySettings((settings) => holdKey.configure(settings));
watchPreferences((next) => {
  const changed =
    next.verbosity !== preferences.verbosity || next.privateMode !== preferences.privateMode;
  preferences = next;
  player.rate = next.speed;
  if (changed) sendSettings();
});

async function askForMicrophoneOnce(): Promise<void> {
  const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
  if (status.state === 'prompt') openPermissionPage();
}

socket.connect();
void askForMicrophoneOnce().catch(() => undefined);
