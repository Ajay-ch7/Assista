import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  clampSpeed,
  loadPreferences,
  normalizePreferences,
  savePreferences,
  watchPreferences,
} from './preferences';

type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

/** A stand-in for chrome.storage.local that keeps values in memory. */
function fakeStorage() {
  const data: Record<string, unknown> = {};
  const listeners: Listener[] = [];
  const storage = {
    local: {
      get: vi.fn(async (key: string) => (key in data ? { [key]: data[key] } : {})),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(data, items);
        const changes = Object.fromEntries(
          Object.entries(items).map(([key, value]) => [key, { newValue: value }]),
        );
        for (const listener of listeners) listener(changes, 'local');
      }),
    },
    onChanged: { addListener: (listener: Listener) => listeners.push(listener) },
  };
  vi.stubGlobal('chrome', { storage });
  return data;
}

describe('normalizePreferences', () => {
  it('fills in defaults', () => {
    expect(normalizePreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences({ verbosity: 'brief' })).toEqual({
      verbosity: 'brief',
      speed: 1,
      privateMode: false,
    });
  });

  it('drops values out of range', () => {
    expect(normalizePreferences({ verbosity: 'chatty', speed: 'fast' })).toEqual(
      DEFAULT_PREFERENCES,
    );
    expect(normalizePreferences({ speed: 9 }).speed).toBe(2);
    expect(normalizePreferences({ speed: 0.1 }).speed).toBe(0.5);
    expect(normalizePreferences({ speed: Number.NaN }).speed).toBe(1);
  });

  it('keeps speed on quarter steps', () => {
    expect(clampSpeed(1.3)).toBe(1.25);
    expect(clampSpeed(1.4)).toBe(1.5);
  });
});

describe('stored preferences', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('load defaults when nothing is stored, and save over what is stored', async () => {
    fakeStorage();
    expect(await loadPreferences()).toEqual(DEFAULT_PREFERENCES);
    expect(await savePreferences({ speed: 1.5 })).toEqual({
      verbosity: 'normal',
      speed: 1.5,
      privateMode: false,
    });
    expect(await savePreferences({ verbosity: 'detailed' })).toEqual({
      verbosity: 'detailed',
      speed: 1.5,
      privateMode: false,
    });
    expect(await loadPreferences()).toEqual({
      verbosity: 'detailed',
      speed: 1.5,
      privateMode: false,
    });
  });

  it('notify watchers now and on every change', async () => {
    fakeStorage();
    const seen: unknown[] = [];
    watchPreferences((preferences) => seen.push(preferences));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await savePreferences({ verbosity: 'brief' });
    expect(seen).toEqual([
      DEFAULT_PREFERENCES,
      { verbosity: 'brief', speed: 1, privateMode: false },
    ]);
  });
});

describe('private mode preference', () => {
  it('is off unless it was stored as on', () => {
    expect(normalizePreferences({}).privateMode).toBe(false);
    expect(normalizePreferences({ privateMode: 'yes' }).privateMode).toBe(false);
    expect(normalizePreferences({ privateMode: true }).privateMode).toBe(true);
  });
});
