// chrome.storage.local wrapper for the user's listening preferences: how much detail the
// answers carry, and how fast speech plays.

import type { Verbosity } from '../shared/protocol';

export interface Preferences {
  verbosity: Verbosity;
  /** Playback rate of speech: 1 is normal. */
  speed: number;
  /** Private mode: no screenshots leave the device, and it answers on the device if it can. */
  privateMode: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  verbosity: 'normal',
  speed: 1,
  privateMode: false,
};
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;
export const SPEED_STEP = 0.25;

const KEY = 'preferences';
const VERBOSITIES: readonly Verbosity[] = ['brief', 'normal', 'detailed'];

/** Fills in defaults and drops anything out of range, so a bad stored value is harmless. */
export function normalizePreferences(stored: unknown): Preferences {
  const value = (typeof stored === 'object' && stored !== null ? stored : {}) as Partial<
    Record<keyof Preferences, unknown>
  >;
  const verbosity = VERBOSITIES.includes(value.verbosity as Verbosity)
    ? (value.verbosity as Verbosity)
    : DEFAULT_PREFERENCES.verbosity;
  const speed =
    typeof value.speed === 'number' && Number.isFinite(value.speed)
      ? clampSpeed(value.speed)
      : DEFAULT_PREFERENCES.speed;
  return { verbosity, speed, privateMode: value.privateMode === true };
}

export function clampSpeed(speed: number): number {
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(speed / SPEED_STEP) * SPEED_STEP));
}

export async function loadPreferences(): Promise<Preferences> {
  const stored = await chrome.storage.local.get(KEY);
  return normalizePreferences(stored[KEY]);
}

/** Saves the given preferences over the stored ones and returns the result. */
export async function savePreferences(change: Partial<Preferences>): Promise<Preferences> {
  const next = normalizePreferences({ ...(await loadPreferences()), ...change });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** Applies the stored preferences now, and again whenever they change. */
export function watchPreferences(apply: (preferences: Preferences) => void): void {
  void loadPreferences().then(apply, () => apply(DEFAULT_PREFERENCES));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) apply(normalizePreferences(changes[KEY].newValue));
  });
}
