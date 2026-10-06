// Page watching in the service worker (F16): keeps the watches, decides when one fires,
// re-checks pages on a Chrome alarm, and raises the alert.

import type {
  ActionReply,
  ToContent,
  ToPanel,
  ToolRequest,
  WatchTargetReply,
} from '../shared/messages';
import {
  alertText,
  matchWatches,
  pageAddress,
  parseCondition,
  summarize,
  watchFires,
  type Watch,
} from '../shared/watch';
import { addWatch, loadWatches, removeWatches, updateWatchValue } from '../store/watches';

export const WATCH_ALARM = 'assista-watches';
export const WATCH_TOOLS = new Set(['set_watch', 'list_watches', 'cancel_watch']);
/** A published extension may fire an alarm at most every 30 seconds. */
const CHECK_EVERY_MINUTES = 0.5;

interface Deps {
  targetTab(): Promise<chrome.tabs.Tab | undefined>;
  sendToContent<R>(tabId: number, msg: ToContent): Promise<R | null>;
  sendToPanel(msg: ToPanel): Promise<unknown>;
}

export function createWatchEngine(deps: Deps) {
  async function setWatch(tool: ToolRequest): Promise<ActionReply> {
    if (!tool.ref) return { ok: false, error: 'missing_ref' };
    const tab = await deps.targetTab();
    if (tab?.id === undefined) return { ok: false, error: 'no_tab' };
    const target = await deps.sendToContent<WatchTargetReply>(tab.id, {
      to: 'content',
      kind: 'watch_target',
      snapshotId: tool.snapshotId,
      ref: tool.ref,
    });
    if (!target) return { ok: false, error: 'unreachable_page' };
    if (!target.ok) return { ok: false, error: target.error };

    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    const watch: Watch = {
      id: `w${Date.now().toString(36)}`,
      url: target.url,
      pageTitle: target.pageTitle,
      selector: target.selector,
      label: text(tool.args.label) || target.name || 'that part of the page',
      lastValue: target.value,
      condition: parseCondition(tool.args.condition, tool.args.value),
      alert: text(tool.args.alert),
      createdAt: Date.now(),
    };
    await addWatch(watch);
    await ensureAlarm();
    return {
      ok: true,
      result: {
        action: 'set_watch',
        target: { role: 'watch', name: watch.label },
        detail: watch.lastValue,
        watches: [summarize(watch)],
      },
    };
  }

  async function listWatches(): Promise<ActionReply> {
    const watches = await loadWatches();
    return { ok: true, result: { action: 'list_watches', watches: watches.map(summarize) } };
  }

  async function cancelWatch(tool: ToolRequest): Promise<ActionReply> {
    const all = await loadWatches();
    const gone = matchWatches(all, tool.args.id ?? tool.args.query);
    if (gone.length === 0) return { ok: false, error: 'no_such_watch' };
    await removeWatches(gone.map((watch) => watch.id));
    return {
      ok: true,
      result: {
        action: 'cancel_watch',
        detail: gone.map((watch) => watch.label).join(', '),
        watches: gone.map(summarize),
      },
    };
  }

  /** A page reports a watched value that is now different. */
  async function onValue(id: string, value: string): Promise<void> {
    const watch = (await loadWatches()).find((item) => item.id === id);
    if (!watch || value === watch.lastValue) return;
    const fired = watchFires(watch, value);
    const text = alertText(watch, value);
    await updateWatchValue(id, value);
    if (fired) await announce(text);
  }

  /** An alert is a sound cue, a spoken sentence and a Chrome notification. */
  async function announce(text: string): Promise<void> {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon.png'),
      title: 'Assista',
      message: text,
    });
    await deps.sendToPanel({ to: 'panel', kind: 'announce', text, cue: 'alert' });
  }

  /**
   * Re-checks every watched page that is open. A tab on show notices its own changes, so
   * it is only asked to look again; a tab in the background is reloaded, because pages
   * often stop updating there, and it reports its values when it has loaded.
   */
  async function onAlarm(): Promise<void> {
    const watched = new Set((await loadWatches()).map((watch) => watch.url));
    if (watched.size === 0) {
      await chrome.alarms.clear(WATCH_ALARM);
      return;
    }
    for (const tab of await chrome.tabs.query({})) {
      if (tab.id === undefined || !tab.url || !watched.has(pageAddress(tab.url))) continue;
      if (tab.active) {
        await deps.sendToContent(tab.id, { to: 'content', kind: 'check_watches' });
      } else {
        await chrome.tabs.reload(tab.id).catch(() => undefined);
      }
    }
  }

  async function ensureAlarm(): Promise<void> {
    if ((await loadWatches()).length === 0) return;
    if (await chrome.alarms.get(WATCH_ALARM)) return;
    await chrome.alarms.create(WATCH_ALARM, { periodInMinutes: CHECK_EVERY_MINUTES });
  }

  function runTool(tool: ToolRequest): Promise<ActionReply> {
    if (tool.name === 'set_watch') return setWatch(tool);
    if (tool.name === 'list_watches') return listWatches();
    return cancelWatch(tool);
  }

  return { runTool, onValue, onAlarm, ensureAlarm, announce };
}
