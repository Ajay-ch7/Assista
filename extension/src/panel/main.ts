// Voice shell. Lives in the side panel because the service worker has no microphone and
// is shut down when idle.

import { isAddressedTo, type Ack } from '../shared/messages';

const status = document.querySelector<HTMLParagraphElement>('#status')!;

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!isAddressedTo(msg, 'panel')) return false;
  status.textContent = `Received ${msg.kind}.`;
  const ack: Ack = { ok: true };
  sendResponse(ack);
  return false;
});

status.textContent = 'Ready.';
