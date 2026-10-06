// Session-timeout warnings (F17): finds countdowns written on the page and tells the
// service worker when one has two minutes left, and again at thirty seconds.

import { isHiddenElement } from '../safety/hiddenText';
import { countdownSeconds } from './rules';

/** Seconds left at which the user is warned, soonest first. */
export const WARN_AT = [30, 120] as const;
const MAX_COUNTDOWNS = 5;
const MAX_TEXT = 200;
/** The page is searched for new countdowns this often; known ones are read every second. */
const RESCAN_EVERY_TICKS = 10;

/** Decides when a countdown has just crossed a warning threshold. */
export class CountdownWarner<Key> {
  private readonly last = new Map<Key, number>();
  private readonly warned = new Map<Key, Set<number>>();

  /** Returns the threshold `seconds` has just come under, or null. Each warns once. */
  update(key: Key, seconds: number): number | null {
    const previous = this.last.get(key);
    this.last.set(key, seconds);
    // The countdown jumped back up: the session was extended, so warn afresh.
    if (previous !== undefined && seconds > previous + 5) this.warned.delete(key);
    if (seconds <= 0) return null;

    const warned = this.warned.get(key) ?? new Set<number>();
    this.warned.set(key, warned);
    for (const threshold of WARN_AT) {
      if (seconds > threshold) continue;
      if (warned.has(threshold)) return null;
      // A warning for less time left also covers the earlier ones.
      for (const other of WARN_AT) if (other >= threshold) warned.add(other);
      return threshold;
    }
    return null;
  }
}

function textOf(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function secondsIn(el: Element): number | null {
  const text = textOf(el);
  if (!text || text.length > MAX_TEXT) return null;
  const isTimer = el.matches('[role="timer"]') || el.querySelector('[role="timer"]') !== null;
  return countdownSeconds(text, isTimer);
}

/**
 * The elements that show a countdown: the smallest element around each number whose
 * text reads as time running out. "Time left: <span>4:59</span>" is found at the
 * sentence, since the span alone is only a clock reading.
 */
export function findCountdowns(doc: Document = document): Element[] {
  const found: Element[] = [];
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node && found.length < MAX_COUNTDOWNS;) {
    const parent = node.parentElement;
    node = walker.nextNode();
    if (!parent || !/\d/.test(parent.textContent ?? '')) continue;
    const candidates: (Element | null)[] = [parent, parent.parentElement];
    const el = candidates.find((candidate) => candidate !== null && secondsIn(candidate) !== null);
    if (!el || found.some((known) => known === el || known.contains(el) || el.contains(known))) {
      continue;
    }
    if (!isHiddenElement(el)) found.push(el);
  }
  return found;
}

/** Watches the page's countdowns and calls `warn` when one crosses a threshold. */
export function startCountdownWarnings(
  warn: (threshold: number) => void,
  doc: Document = document,
): () => void {
  const warner = new CountdownWarner<Element>();
  let countdowns: Element[] = [];
  let ticks = 0;
  const timer = setInterval(() => {
    if (ticks++ % RESCAN_EVERY_TICKS === 0) countdowns = findCountdowns(doc);
    for (const el of countdowns) {
      const seconds = el.isConnected ? secondsIn(el) : null;
      if (seconds === null) continue;
      const threshold = warner.update(el, seconds);
      if (threshold !== null) warn(threshold);
    }
  }, 1000);
  return () => clearInterval(timer);
}
