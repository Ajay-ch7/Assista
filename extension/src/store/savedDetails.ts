// chrome.storage.local wrapper for saved details (F20): the name, phone number, address
// and the like that the user has dictated once. They stay on the device, and passwords,
// codes, card numbers and PINs are never among them.

import type { DetailKind } from '../shared/fieldKind';

export type SavedDetails = Partial<Record<DetailKind, string>>;

const KEY = 'savedDetails';
const MAX_LENGTH = 200;

export async function loadSavedDetails(): Promise<SavedDetails> {
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  return typeof stored === 'object' && stored !== null ? (stored as SavedDetails) : {};
}

/** Remembers `value` as the user's detail of this kind. Blank values are not kept. */
export async function saveDetail(kind: DetailKind, value: string): Promise<void> {
  const text = value.trim();
  if (!text || text.length > MAX_LENGTH) return;
  await chrome.storage.local.set({ [KEY]: { ...(await loadSavedDetails()), [kind]: text } });
}

export async function forgetSavedDetails(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

/** Applies the saved details now, and again whenever they change. */
export function watchSavedDetails(apply: (details: SavedDetails) => void): void {
  void loadSavedDetails().then(apply, () => apply({}));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    const next = changes[KEY].newValue;
    apply(typeof next === 'object' && next !== null ? (next as SavedDetails) : {});
  });
}
