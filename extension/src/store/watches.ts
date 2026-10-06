// chrome.storage.local wrapper for the user's watches. They live on the device and work
// only while the browser is open.

import { MAX_WATCHES, type Watch } from '../shared/watch';

const KEY = 'watches';

export async function loadWatches(): Promise<Watch[]> {
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  return Array.isArray(stored) ? (stored as Watch[]) : [];
}

// Changes run one after another, so two that overlap cannot overwrite each other.
let writing: Promise<unknown> = Promise.resolve();

function change(update: (watches: Watch[]) => Watch[]): Promise<Watch[]> {
  const write = writing.then(async () => {
    const next = update(await loadWatches());
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  });
  writing = write.catch(() => undefined);
  return write;
}

/** Adds a watch. A watch on the same element of the same page replaces the old one. */
export function addWatch(watch: Watch): Promise<Watch[]> {
  return change((watches) =>
    [
      ...watches.filter((item) => item.url !== watch.url || item.selector !== watch.selector),
      watch,
    ].slice(-MAX_WATCHES),
  );
}

export function removeWatches(ids: string[]): Promise<Watch[]> {
  return change((watches) => watches.filter((watch) => !ids.includes(watch.id)));
}

/** Records the value last seen for a watch. */
export function updateWatchValue(id: string, lastValue: string): Promise<Watch[]> {
  return change((watches) =>
    watches.map((watch) => (watch.id === id ? { ...watch, lastValue } : watch)),
  );
}

export function onWatchesChanged(listener: () => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) listener();
  });
}
