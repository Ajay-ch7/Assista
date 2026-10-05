// F09 in a page: watches for the held talk key and the stop key, and tells the service
// worker, which passes them to the panel.

import { DEFAULT_KEYS, HoldKeyMachine, attachHoldKey } from '../shared/holdKey';
import type { Ack, ToWorker } from '../shared/messages';
import { watchKeySettings } from '../store/settings';

const PANEL_CLOSED_HINT = 'Assista is closed. Press Alt, Shift and A to open it.';

async function send(msg: ToWorker): Promise<Ack> {
  try {
    return await chrome.runtime.sendMessage<ToWorker, Ack>(msg);
  } catch {
    // The extension was reloaded; this copy of the script can no longer reach it.
    return { ok: false, error: 'extension_unreachable' };
  }
}

function sayHint(): void {
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(PANEL_CLOSED_HINT));
}

export function installKeyListener(): void {
  const machine = new HoldKeyMachine(DEFAULT_KEYS, {
    onTalkStart: () => {
      void send({ to: 'worker', kind: 'talk_key', phase: 'down' }).then((ack) => {
        if (!ack.ok && ack.error === 'panel_closed') sayHint();
      });
    },
    onTalkEnd: () => void send({ to: 'worker', kind: 'talk_key', phase: 'up' }),
    onTalkCancel: () => void send({ to: 'worker', kind: 'talk_key', phase: 'cancel' }),
    onStop: () => void send({ to: 'worker', kind: 'stop_key' }),
  });
  attachHoldKey(window, machine);
  watchKeySettings((settings) => machine.configure(settings));
}
