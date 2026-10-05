// Content script: runs in every tab. Answers the service worker's requests about the page.

import { isAddressedTo, type SnapshotReply } from '../shared/messages';
import { installKeyListener } from './keys';

declare global {
  interface Window {
    __assistaContentLoaded?: boolean;
  }
}

// The worker injects this file into tabs that were open before the extension loaded, so
// the same page can receive it twice.
if (!window.__assistaContentLoaded) {
  window.__assistaContentLoaded = true;
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isAddressedTo(msg, 'content')) return false;
    if (msg.kind === 'build_snapshot') {
      const reply: SnapshotReply = { ok: false, error: 'snapshot_not_implemented' };
      sendResponse(reply);
    }
    return false;
  });
  installKeyListener();
}
