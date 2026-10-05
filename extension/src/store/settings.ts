// chrome.storage.local wrapper for the talk and stop keys. Content scripts can read it too.

import { DEFAULT_KEYS, type KeySettings } from '../shared/holdKey';

const KEY = 'keys';

function withDefaults(stored: unknown): KeySettings {
  const value = (
    typeof stored === 'object' && stored !== null ? stored : {}
  ) as Partial<KeySettings>;
  return {
    talkKey:
      typeof value.talkKey === 'string' && value.talkKey ? value.talkKey : DEFAULT_KEYS.talkKey,
    holdMs:
      typeof value.holdMs === 'number' && value.holdMs >= 0 ? value.holdMs : DEFAULT_KEYS.holdMs,
    stopKey:
      typeof value.stopKey === 'string' && value.stopKey ? value.stopKey : DEFAULT_KEYS.stopKey,
  };
}

export async function loadKeySettings(): Promise<KeySettings> {
  const stored = await chrome.storage.local.get(KEY);
  return withDefaults(stored[KEY]);
}

export async function saveKeySettings(settings: KeySettings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}

export function onKeySettingsChanged(listener: (settings: KeySettings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) listener(withDefaults(changes[KEY].newValue));
  });
}

/** Applies the stored keys now, and again whenever they change. */
export function watchKeySettings(apply: (settings: KeySettings) => void): void {
  void loadKeySettings().then(apply, () => undefined);
  onKeySettingsChanged(apply);
}
