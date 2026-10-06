// Service worker: routes messages between the panel and content scripts, and finds the
// tab the user is working in. It holds no state, because Chrome shuts it down when idle.

import {
  isAddressedTo,
  type Ack,
  type ActionReply,
  type CaptureReply,
  type DocumentReply,
  type ScreenshotReply,
  type SnapshotReply,
  type ToContent,
  type ToPanel,
  type ToWorker,
  type ToolRequest,
} from '../shared/messages';
import { fetchDocument, isLocalFile, isPdfUrl, pdfSnapshot, servesPdf } from './documents';
import { cropImage } from './screenshot';
import { wasRequested } from '../safety/gate';
import { findTab, normalizeUrl, pickTargetTab } from './tabs';
import { WATCH_ALARM, WATCH_TOOLS, createWatchEngine } from './watches';

const EXTENSION_ORIGIN = chrome.runtime.getURL('');
const CONTENT_SCRIPT = 'content.js';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.warn('Assista: could not set panel behavior', error));

chrome.runtime.onInstalled.addListener(() => {
  void injectIntoOpenTabs();
  void watches.ensureAlarm();
});
chrome.runtime.onStartup.addListener(() => void watches.ensureAlarm());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCH_ALARM) void watches.onAlarm();
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
): Promise<Ack | SnapshotReply | ScreenshotReply | DocumentReply | ActionReply> {
  switch (msg.kind) {
    case 'talk_key':
      return sendToPanel({ to: 'panel', kind: 'talk_key', phase: msg.phase }, sender.tab);
    case 'stop_key':
      return sendToPanel({ to: 'panel', kind: 'stop_key' });
    case 'get_snapshot':
      return snapshotOfTargetTab();
    case 'get_screenshot':
      return screenshotOfTargetTab(msg.ref);
    case 'get_document':
      return documentOfTargetTab();
    case 'run_tool':
      return runTool(msg.tool);
    case 'watch_value':
      await watches.onValue(msg.id, msg.value);
      return { ok: true };
    case 'countdown':
      await watches.announce(countdownWarning(msg.seconds, sender.tab?.title));
      return { ok: true };
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

/** What the user hears when a session timer on a page is about to run out (F17). */
function countdownWarning(seconds: number, title?: string): string {
  const where = title ? ` on ${title}` : '';
  return seconds > 60
    ? `Heads up: the timer${where} has about ${Math.round(seconds / 60)} minutes left.`
    : `The timer${where} has ${seconds} seconds left.`;
}

const watches = createWatchEngine({ targetTab, sendToContent, sendToPanel });

async function snapshotOfTargetTab(): Promise<SnapshotReply> {
  const tab = await targetTab();
  if (tab?.id === undefined) return { ok: false, error: 'no_tab' };
  // A PDF has no page to read; the backend asks for the file instead.
  if (isPdfUrl(tab.url)) return { ok: true, snapshot: pdfSnapshot(tab) };
  const reply = await sendToContent<SnapshotReply>(tab.id, {
    to: 'content',
    kind: 'build_snapshot',
  });
  if (reply) return reply;
  if (await servesPdf(tab.url)) return { ok: true, snapshot: pdfSnapshot(tab) };
  return { ok: false, error: 'unreachable_page' };
}

/** Fetches the PDF the target tab shows. Never any other address. */
async function documentOfTargetTab(): Promise<DocumentReply> {
  const tab = await targetTab();
  if (tab?.id === undefined || !tab.url) return { ok: false, error: 'no_tab' };
  if (!isPdfUrl(tab.url) && !(await servesPdf(tab.url))) return { ok: false, error: 'not_pdf' };
  if (isLocalFile(tab.url)) {
    // Chrome lets an extension open files only when the user has allowed it.
    if (!(await chrome.extension.isAllowedFileSchemeAccess())) {
      return { ok: false, error: 'file_access_off' };
    }
    return { ok: false, error: 'local_file', url: tab.url };
  }
  return fetchDocument(tab.url);
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

/**
 * Runs one action tool. Switching tabs and opening addresses happen here; everything else
 * happens in the target tab's page. Returns once the page has settled, so the snapshot
 * that follows shows the result.
 */
async function runTool(tool: ToolRequest): Promise<ActionReply> {
  if (WATCH_TOOLS.has(tool.name)) return watches.runTool(tool);
  if (tool.name === 'switch_tab') return switchTab(tool.args);
  if (tool.name === 'open_url') return openUrl(tool);
  if (tool.name === 'web_search') return webSearch(tool);

  const tab = await targetTab();
  if (tab?.id === undefined) return { ok: false, error: 'no_tab' };
  const reply = await sendToContent<ActionReply>(tab.id, {
    to: 'content',
    kind: 'run_action',
    tool,
  });
  if (!reply) return { ok: false, error: 'unreachable_page' };
  if (reply.ok) await settle(tab.id);
  return reply;
}

async function switchTab(args: Record<string, unknown>): Promise<ActionReply> {
  const tabs = await chrome.tabs.query({});
  const tab = findTab(tabs, args, EXTENSION_ORIGIN);
  if (tab?.id === undefined) {
    const titles = tabs
      .filter((item) => !(item.url ?? '').startsWith(EXTENSION_ORIGIN))
      .map((item) => item.title ?? 'untitled')
      .slice(0, 12);
    return { ok: false, error: `no_such_tab: ${titles.join(' | ')}` };
  }
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  return {
    ok: true,
    result: { action: 'switch_tab', target: { role: 'tab', name: tab.title ?? 'untitled' } },
  };
}

/**
 * Holds an action the user did not ask for by name (F21): `what` is the words that
 * should have been heard, `control` what is read back. A confirmed action goes ahead.
 */
function unrequested(tool: ToolRequest, what: string, control: string): ActionReply | null {
  if (!tool.heard || wasRequested(what, tool.heard)) return null;
  if (tool.confirmed?.control === control) return null;
  return { ok: false, error: 'held_by_gate', held: { control, reason: 'not_requested' } };
}

async function openUrl(tool: ToolRequest, checked = false): Promise<ActionReply> {
  const args = tool.args;
  const url = normalizeUrl(args.url);
  if (!url) return { ok: false, error: 'blocked_url' };
  const host = new URL(url).hostname.replace(/^www\./, '');
  // The site's own name must have been said: "open example.com" names example.
  const siteName = host.split('.').slice(0, -1).join(' ') || host;
  const hold = checked ? null : unrequested(tool, siteName, host);
  if (hold) return hold;
  const current = args.new_tab === true ? undefined : await targetTab();
  const tab =
    current?.id === undefined
      ? await chrome.tabs.create({ url })
      : await chrome.tabs.update(current.id, { url });
  if (tab?.id !== undefined) await settle(tab.id);
  return { ok: true, result: { action: 'open_url', detail: new URL(url).hostname } };
}

/** Opens a search engine's results for the user's words. */
async function webSearch(tool: ToolRequest): Promise<ActionReply> {
  const args = tool.args;
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { ok: false, error: 'missing_text' };
  const hold = unrequested(tool, query, query);
  if (hold) return hold;
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  const reply = await openUrl({ ...tool, args: { url, new_tab: args.new_tab } }, true);
  return reply.ok ? { ok: true, result: { action: 'web_search', detail: query } } : reply;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the tab to finish what an action started: a page load, or a redraw. */
async function settle(tabId: number): Promise<void> {
  await sleep(350);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status === 'complete') return;
    await sleep(150);
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
