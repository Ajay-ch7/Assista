// Page watching in the page (F16): names the element to watch in a way that survives a
// reload, and reports its value to the service worker whenever the page changes.

import { isSensitiveField } from '../safety/redaction';
import type { WatchTarget } from '../shared/messages';
import { pageAddress, type Watch } from '../shared/watch';
import { describeElement, resolveRef } from './snapshot';

const MAX_VALUE = 200;
/** Page changes are checked this long after the last one, so a burst counts once. */
const SETTLE_MS = 400;

/** What to store for a watch on the element behind `ref`. Refuses sensitive fields. */
export function watchTarget(
  snapshotId: string,
  ref: string,
  doc: Document = document,
): WatchTarget {
  const el = resolveRef(snapshotId, ref);
  const { name } = describeElement(el);
  if (isSensitiveField(el, name)) throw new Error('sensitive_field');
  return {
    url: pageAddress(doc.location.href),
    pageTitle: doc.title,
    selector: selectorFor(el),
    value: valueOf(el),
    name,
  };
}

/** The text a watch compares: a field's value, or the element's text. */
export function valueOf(el: Element): string {
  const raw =
    el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select'
      ? (el as HTMLInputElement).value
      : (el.textContent ?? '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE);
}

/** The watched element's value now, or null when it is not on the page. */
export function readWatched(selector: string, doc: Document = document): string | null {
  try {
    const el = doc.querySelector(selector);
    if (!el || isSensitiveField(el, describeElement(el).name)) return null;
    return valueOf(el);
  } catch {
    // The page changed so much that the selector no longer parses or matches.
    return null;
  }
}

function escapeId(id: string): string {
  return id.replace(/[^\w-]/g, (char) => `\\${char}`).replace(/^(\d)/, '\\3$1 ');
}

/** A CSS selector that finds `el` again: its id when it has a unique one, else its path. */
export function selectorFor(el: Element): string {
  const doc = el.ownerDocument;
  const parts: string[] = [];
  for (let node: Element | null = el; node && node !== doc.documentElement;) {
    if (node.id && doc.querySelectorAll(`#${escapeId(node.id)}`).length === 1) {
      parts.unshift(`#${escapeId(node.id)}`);
      return parts.join(' > ');
    }
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    const tag = node.localName;
    const twins = Array.from(parent.children).filter((child) => child.localName === tag);
    parts.unshift(twins.length > 1 ? `${tag}:nth-of-type(${twins.indexOf(node) + 1})` : tag);
    node = parent;
  }
  return parts.join(' > ');
}

interface Deps {
  loadWatches(): Promise<Watch[]>;
  /** Tells the service worker a watched value is now different. */
  report(id: string, value: string): void;
}

/**
 * Checks this page's watches when the page loads and whenever it changes. The service
 * worker decides whether a new value fires the watch.
 */
export class PageWatcher {
  private watches: Watch[] = [];
  /** The value last reported for each watch, so each change is reported once. */
  private readonly reported = new Map<string, string>();
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly deps: Deps,
    private readonly doc: Document = document,
  ) {}

  /** Loads this page's watches, checks them, and watches the page while there are any. */
  async refresh(): Promise<void> {
    const here = pageAddress(this.doc.location.href);
    this.watches = (await this.deps.loadWatches()).filter((watch) => watch.url === here);
    for (const watch of this.watches) {
      if (!this.reported.has(watch.id)) this.reported.set(watch.id, watch.lastValue);
    }
    this.check();
    if (this.watches.length > 0) this.observe();
    else this.stop();
  }

  check(): void {
    for (const watch of this.watches) {
      const value = readWatched(watch.selector, this.doc);
      if (value === null || value === this.reported.get(watch.id)) continue;
      this.reported.set(watch.id, value);
      this.deps.report(watch.id, value);
    }
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    clearTimeout(this.timer);
  }

  private observe(): void {
    if (this.observer) return;
    const view = this.doc.defaultView!;
    this.observer = new view.MutationObserver(() => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.check(), SETTLE_MS);
    });
    this.observer.observe(this.doc.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }
}
