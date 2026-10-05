// Service worker: routes messages between the panel and content scripts, and finds the
// tab the user is working in. It holds no state, because Chrome shuts it down when idle.

import {
  isAddressedTo,
  type Ack,
  type CaptureReply,
  type ScreenshotReply,
  type SnapshotReply,
  type ToContent,
  type ToPanel,
  type ToWorker,
} from '../shared/messages';
import { cropImage } from './screenshot';
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

// chrome.commands reports key down only, so these shortcuts toggle instead of hold. They
// also work on chrome:// pages and the new-tab page, where no content script runs.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'stop-speech') {
    void sendToPanel({ to: 'panel', kind: 'stop_key' });
  } else if (command === 'toggle-talk') {
    void toggleTalk(tab);
  }
});

async function toggleTalk(tab?: chrome.tabs.Tab): Promise<void> {
  // Opening must be the first call, while Chrome still counts the shortcut as a gesture.
  if (tab?.windowId !== undefined) {
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
  }
  const msg: ToPanel = { to: 'panel', kind: 'talk_toggle' };
  for (let attempt = 0; attempt < 5; attempt++) {
    if ((await sendToPanel(msg)).ok) return;
    // The panel was closed and is still loading.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function handle(
  msg: ToWorker,
  sender: chrome.runtime.MessageSender,
): Promise<Ack | SnapshotReply | ScreenshotReply> {
  switch (msg.kind) {
    case 'talk_key':
      return sendToPanel({ to: 'panel', kind: 'talk_key', phase: msg.phase }, sender.tab);
    case 'stop_key':
      return sendToPanel({ to: 'panel', kind: 'stop_key' });
    case 'get_snapshot':
      return snapshotOfTargetTab();
    case 'get_screenshot':
      return screenshotOfTargetTab(msg.ref);
  }
}

/**
 * Forwards a message to the panel. When the panel is closed and the message came from a
 * tab, tries to open the panel there; Chrome allows that only shortly after a user gesture.
 */
async function sendToPanel(msg: ToPanel, openOnTab?: chrome.tabs.Tab): Promise<Ack> {
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

async function targetTab(): Promise<chrome.tabs.Tab | undefined> {
  const [focusedActive, all] = await Promise.all([
    chrome.tabs.query({ active: true, lastFocusedWindow: true }),
    chrome.tabs.query({}),
  ]);
  return pickTargetTab(focusedActive, all, EXTENSION_ORIGIN);
}

/** Sends to the tab's content script, injecting it first if the tab has none yet. */
async function sendToContent<R>(tabId: number, msg: ToContent): Promise<R | null> {
  try {
    return await chrome.tabs.sendMessage<ToContent, R>(tabId, msg);
  } catch {
    // No content script yet: the tab predates the extension, or the page forbids scripts.
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
    return await chrome.tabs.sendMessage<ToContent, R>(tabId, msg);
  } catch {
    return null;
  }
}

async function snapshotOfTargetTab(): Promise<SnapshotReply> {
  const tab = await targetTab();
  if (tab?.id === undefined) return { ok: false, error: 'no_tab' };
  const reply = await sendToContent<SnapshotReply>(tab.id, {
    to: 'content',
    kind: 'build_snapshot',
  });
  return reply ?? { ok: false, error: 'unreachable_page' };
}

/**
 * Captures the target tab, or the element `ref` from its latest snapshot. Chrome can only
 * capture the tab on show in its window, so a tab in the background is refused.
 */
async function screenshotOfTargetTab(ref?: string): Promise<ScreenshotReply> {
  const tab = await targetTab();
  if (tab?.id === undefined || tab.windowId === undefined) return { ok: false, error: 'no_tab' };
  if (!tab.active) return { ok: false, error: 'tab_not_visible' };

  const frame = await sendToContent<CaptureReply>(tab.id, {
    to: 'content',
    kind: 'prepare_capture',
    ref,
  });
  if (!frame) return { ok: false, error: 'unreachable_page' };
  try {
    if (!frame.ok) return { ok: false, error: frame.error };
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return await cropImage(dataUrl, frame);
  } catch (error) {
    return { ok: false, error: `capture_failed: ${String(error)}` };
  } finally {
    await sendToContent<Ack>(tab.id, { to: 'content', kind: 'end_capture' });
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
