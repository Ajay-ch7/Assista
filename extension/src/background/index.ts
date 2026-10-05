// Service worker: routes messages between the panel and content scripts, and finds the
// tab the user is working in. It holds no state, because Chrome shuts it down when idle.

import {
  isAddressedTo,
  type Ack,
  type SnapshotReply,
  type ToContent,
  type ToPanel,
  type ToWorker,
} from '../shared/messages';
import { pickTargetTab } from './tabs';

const EXTENSION_ORIGIN = chrome.runtime.getURL('');
const CONTENT_SCRIPT = 'content.js';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.warn('Assista: could not set panel behavior', error));

chrome.runtime.onInstalled.addListener(() => {
  void injectIntoOpenTabs();
});

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (!isAddressedTo(msg, 'worker')) return false;
  handle(msg, sender).then(sendResponse, (error) =>
    sendResponse({ ok: false, error: String(error) }),
  );
  return true;
});

async function handle(
  msg: ToWorker,
  sender: chrome.runtime.MessageSender,
): Promise<Ack | SnapshotReply> {
  switch (msg.kind) {
    case 'talk_key':
      return sendToPanel({ to: 'panel', kind: 'talk_key', phase: msg.phase }, sender.tab);
    case 'stop_key':
      return sendToPanel({ to: 'panel', kind: 'stop_key' });
    case 'get_snapshot':
      return snapshotOfTargetTab();
  }
}

/**
 * Forwards a message to the panel. When the panel is closed and the message came from a
 * tab, tries to open the panel there; Chrome allows that only shortly after a user gesture.
 */
export async function sendToPanel(msg: ToPanel, openOnTab?: chrome.tabs.Tab): Promise<Ack> {
  try {
    await chrome.runtime.sendMessage(msg);
    return { ok: true };
  } catch {
    if (openOnTab?.id !== undefined) {
      await chrome.sidePanel.open({ tabId: openOnTab.id }).catch(() => undefined);
    }
    return { ok: false, error: 'panel_closed' };
  }
}

async function snapshotOfTargetTab(): Promise<SnapshotReply> {
  const [focusedActive, all] = await Promise.all([
    chrome.tabs.query({ active: true, lastFocusedWindow: true }),
    chrome.tabs.query({}),
  ]);
  const tab = pickTargetTab(focusedActive, all, EXTENSION_ORIGIN);
  if (tab?.id === undefined) return { ok: false, error: 'no_tab' };

  const request: ToContent = { to: 'content', kind: 'build_snapshot' };
  try {
    return await chrome.tabs.sendMessage<ToContent, SnapshotReply>(tab.id, request);
  } catch {
    // No content script yet: the tab predates the extension, or the page forbids scripts.
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [CONTENT_SCRIPT] });
    return await chrome.tabs.sendMessage<ToContent, SnapshotReply>(tab.id, request);
  } catch {
    return { ok: false, error: 'unreachable_page' };
  }
}

async function injectIntoOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    await chrome.scripting
      .executeScript({ target: { tabId: tab.id }, files: [CONTENT_SCRIPT] })
      .catch(() => undefined);
  }
}
