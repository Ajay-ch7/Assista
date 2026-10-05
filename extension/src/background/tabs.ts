export interface TabLike {
  id?: number;
  url?: string;
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
