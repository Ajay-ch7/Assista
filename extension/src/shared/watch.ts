// Page watching (F16): what a watch is, and when it fires. A watch is a page address, the
// watched element, its last value and a condition. Everything here is plain logic, shared
// by the service worker and the content script.

export type WatchCondition =
  | { kind: 'changes' }
  | { kind: 'decreases' }
  | { kind: 'increases' }
  | { kind: 'below'; value: number }
  | { kind: 'above'; value: number }
  | { kind: 'contains'; text: string };

export interface Watch {
  id: string;
  /** The page's address, without the part after #. */
  url: string;
  pageTitle: string;
  /** Finds the watched element again after the page reloads. */
  selector: string;
  /** What the user calls it, such as "the price". */
  label: string;
  lastValue: string;
  condition: WatchCondition;
  /** The sentence spoken when the watch fires; {value} and {old} are filled in. */
  alert: string;
  createdAt: number;
}

/** What a watch looks like to the model and in spoken lists. */
export interface WatchSummary {
  id: string;
  label: string;
  page: string;
  condition: string;
  value: string;
}

export const MAX_WATCHES = 20;

/** The address a watch is filed under: the page without its fragment. */
export function pageAddress(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/** The first number in `text`: "Price: 4,499.50 rupees" gives 4499.5. */
export function numberIn(text: string): number | null {
  const match = /-?\d[\d,]*(?:\.\d+)?/.exec(text);
  if (!match) return null;
  const value = Number(match[0].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/** Builds a condition from a tool call's arguments; anything unclear means "changes". */
export function parseCondition(kind: unknown, value: unknown): WatchCondition {
  const amount = typeof value === 'number' ? value : numberIn(String(value ?? ''));
  switch (kind) {
    case 'decreases':
    case 'increases':
      return { kind };
    case 'below':
    case 'above':
      return amount === null ? { kind: 'changes' } : { kind, value: amount };
    case 'contains':
      return typeof value === 'string' && value.trim()
        ? { kind: 'contains', text: value.trim() }
        : { kind: 'changes' };
    default:
      return { kind: 'changes' };
  }
}

export function describeCondition(condition: WatchCondition): string {
  switch (condition.kind) {
    case 'changes':
      return 'changes';
    case 'decreases':
      return 'goes down';
    case 'increases':
      return 'goes up';
    case 'below':
      return `goes below ${condition.value}`;
    case 'above':
      return `goes above ${condition.value}`;
    case 'contains':
      return `says ${condition.text}`;
  }
}

/** True when going from the watch's last value to `value` meets its condition. */
export function watchFires(watch: Watch, value: string): boolean {
  if (value === watch.lastValue) return false;
  const condition = watch.condition;
  const now = numberIn(value);
  const before = numberIn(watch.lastValue);
  switch (condition.kind) {
    case 'changes':
      return true;
    case 'decreases':
      return now !== null && before !== null && now < before;
    case 'increases':
      return now !== null && before !== null && now > before;
    case 'below':
      return now !== null && now < condition.value;
    case 'above':
      return now !== null && now > condition.value;
    case 'contains': {
      const wanted = condition.text.toLowerCase();
      return (
        value.toLowerCase().includes(wanted) && !watch.lastValue.toLowerCase().includes(wanted)
      );
    }
  }
}

/** The sentence to speak when `watch` fires with the new `value`. */
export function alertText(watch: Watch, value: string): string {
  const template = watch.alert.trim() || `${watch.label} changed from {old} to {value}.`;
  const text = template.replaceAll('{value}', value).replaceAll('{old}', watch.lastValue);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function summarize(watch: Watch): WatchSummary {
  return {
    id: watch.id,
    label: watch.label,
    page: watch.pageTitle || watch.url,
    condition: describeCondition(watch.condition),
    value: watch.lastValue,
  };
}

/** Watches whose label or page matches `query`; every watch when `query` is empty. */
export function matchWatches(watches: Watch[], query: unknown): Watch[] {
  const wanted = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!wanted) return watches;
  const words = wanted.split(/\s+/).filter((word) => word.length > 3);
  return watches.filter((watch) => {
    const text = `${watch.label} ${watch.pageTitle} ${watch.url}`.toLowerCase();
    return watch.id === wanted || text.includes(wanted) || words.some((w) => text.includes(w));
  });
}
