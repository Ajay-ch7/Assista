// Content script: runs in every tab. Answers the service worker's requests about the page
// and watches for the talk and stop keys.

import { isAddressedTo, type CaptureReply, type SnapshotReply } from '../shared/messages';
import { endCapture, prepareCapture } from './capture';
import { installKeyListener } from './keys';
import { StaleRefError, buildSnapshot } from './snapshot';

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

async function captureReply(ref?: string): Promise<CaptureReply> {
  try {
    return { ok: true, ...(await prepareCapture(ref)) };
  } catch (error) {
    endCapture();
    return { ok: false, error: error instanceof StaleRefError ? 'stale_ref' : String(error) };
  }
}

// The worker injects this file into tabs that were open before the extension loaded, so
// the same page can receive it twice.
if (!window.__assistaContentLoaded) {
  window.__assistaContentLoaded = true;
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isAddressedTo(msg, 'content')) return false;
    switch (msg.kind) {
      case 'build_snapshot':
        sendResponse(snapshotReply());
        return false;
      case 'prepare_capture':
        void captureReply(msg.ref).then(sendResponse);
        return true;
      case 'end_capture':
        endCapture();
        sendResponse({ ok: true });
        return false;
    }
  });
  installKeyListener();
}
