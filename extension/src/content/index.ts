// Content script: runs in every tab. Answers the service worker's requests about the page
// and watches for the talk and stop keys.

import { isAddressedTo, type SnapshotReply } from '../shared/messages';
import { installKeyListener } from './keys';
import { buildSnapshot } from './snapshot';

declare global {
  interface Window {
    __assistaContentLoaded?: boolean;
  }
}

function snapshotReply(): SnapshotReply {
  try {
    return { ok: true, snapshot: buildSnapshot() };
  } catch (error) {
    return { ok: false, error: `snapshot_failed: ${String(error)}` };
  }
}

// The worker injects this file into tabs that were open before the extension loaded, so
// the same page can receive it twice.
if (!window.__assistaContentLoaded) {
  window.__assistaContentLoaded = true;
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isAddressedTo(msg, 'content')) return false;
    if (msg.kind === 'build_snapshot') sendResponse(snapshotReply());
    return false;
  });
  installKeyListener();
}
