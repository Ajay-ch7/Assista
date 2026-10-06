export interface TabLike {
  id?: number;
  url?: string;
  title?: string;
  lastAccessed?: number;
}

/**
 * Picks the tab the user is working in. The focused window's active tab wins; when that
 * is one of Assista's own pages (the panel opened as a tab, or the permission page), the
 * most recently used other tab is taken instead.
 */
export function pickTargetTab<T extends TabLike>(
  focusedActive: T[],
  all: T[],
  extensionOrigin: string,
): T | undefined {
  const usable = (tab: T) => tab.id !== undefined && !(tab.url ?? '').startsWith(extensionOrigin);
  const active = focusedActive.find(usable);
  if (active) return active;
  return all.filter(usable).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}

/**
 * Finds the tab for switch_tab: by `index` (1 is the first tab), or by `query`, which is
 * matched against tab titles first and addresses second. Assista's own pages are skipped.
 */
export function findTab<T extends TabLike>(
  tabs: T[],
  wanted: { query?: unknown; index?: unknown },
  extensionOrigin: string,
): T | undefined {
  const usable = tabs.filter(
    (tab) => tab.id !== undefined && !(tab.url ?? '').startsWith(extensionOrigin),
  );
  if (typeof wanted.index === 'number') return usable[wanted.index - 1];
  const query = typeof wanted.query === 'string' ? wanted.query.trim().toLowerCase() : '';
  if (!query) return undefined;
  return (
    usable.find((tab) => (tab.title ?? '').toLowerCase().includes(query)) ??
    usable.find((tab) => (tab.url ?? '').toLowerCase().includes(query))
  );
}

/** The address to open for open_url, or null when it is not a web address. */
export function normalizeUrl(input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim()) return null;
  const text = input.trim();
  // "example.com" means https://example.com; anything with another scheme is refused.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url.href;
  } catch {
    return null;
  }
}
