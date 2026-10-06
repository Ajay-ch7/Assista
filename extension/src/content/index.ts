// Content script: runs in every tab. Answers the service worker's requests about the page,
// acts on it, and watches for the talk and stop keys.

import {
  isAddressedTo,
  type CaptureReply,
  type SnapshotReply,
  type WatchTargetReply,
} from '../shared/messages';
import { watchSavedDetails } from '../store/savedDetails';
import { loadWatches, onWatchesChanged } from '../store/watches';
import { runAction } from './actions';
import { endCapture, prepareCapture } from './capture';
import { startCountdownWarnings } from './countdown';
import { installKeyListener } from './keys';
import { trackUserChoices } from './rules';
import { setSavedDetails } from './saved';
import { StaleRefError, buildSnapshot } from './snapshot';
import { PageWatcher, watchTarget } from './watching';

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

function watchTargetReply(snapshotId: string, ref: string): WatchTargetReply {
  try {
    return { ok: true, ...watchTarget(snapshotId, ref) };
  } catch (error) {
    if (error instanceof StaleRefError) return { ok: false, error: 'stale_ref' };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Tells the service worker; it is gone only when the extension was reloaded. */
function tellWorker(msg: object): void {
  try {
    void chrome.runtime.sendMessage(msg).catch(() => undefined);
  } catch {
    // This copy of the script can no longer reach the extension.
  }
}

// The worker injects this file into tabs that were open before the extension loaded, so
// the same page can receive it twice.
if (!window.__assistaContentLoaded) {
  window.__assistaContentLoaded = true;
  const watcher = new PageWatcher({
    loadWatches,
    report: (id, value) => tellWorker({ to: 'worker', kind: 'watch_value', id, value }),
  });
  void watcher.refresh().catch(() => undefined);
  onWatchesChanged(() => void watcher.refresh().catch(() => undefined));
  watchSavedDetails(setSavedDetails);
  startCountdownWarnings((seconds) => tellWorker({ to: 'worker', kind: 'countdown', seconds }));
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
      case 'run_action':
        sendResponse(runAction(msg.tool));
        return false;
      case 'watch_target':
        sendResponse(watchTargetReply(msg.snapshotId, msg.ref));
        return false;
      case 'check_watches':
        watcher.check();
        sendResponse({ ok: true });
        return false;
    }
  });
  installKeyListener();
  trackUserChoices();
}
