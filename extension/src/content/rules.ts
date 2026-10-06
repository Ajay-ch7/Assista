// Page rules (implementation.md section 5.2): boxes that were ticked before the user
// touched them, and countdowns written in the page's text. The Advisor reports the first
// as a possible trick; the Watcher warns before a countdown runs out.

const TICKABLE_ROLES = new Set(['checkbox', 'switch']);

/** Boxes the user has ticked or unticked with their own hands. */
const touched = new WeakSet<Element>();
/** Whether a custom box was ticked when Assista first saw it. Native boxes say so themselves. */
const firstSeenTicked = new WeakMap<Element, boolean>();

/** Records that the user changed `target`, so its state is their choice, not the page's. */
export function noteUserChoice(target: EventTarget | null): void {
  if (!(target instanceof Element)) return;
  const box = target.closest('input, [role="checkbox"], [role="switch"]');
  if (box) touched.add(box);
}

/** Watches for the user's own clicks and key presses on boxes. Page scripts cannot fake them. */
export function trackUserChoices(doc: Document = document): void {
  const onEvent = (event: Event) => {
    if (event.isTrusted) noteUserChoice(event.target);
  };
  doc.addEventListener('change', onEvent, true);
  doc.addEventListener('click', onEvent, true);
  doc.addEventListener(
    'keydown',
    (event) => {
      if (event.key === ' ' || event.key === 'Enter') onEvent(event);
    },
    true,
  );
}

/** True for a box that is ticked because the page ticked it, not the user. */
export function isPreticked(el: Element, role: string): boolean {
  if (!TICKABLE_ROLES.has(role)) return false;
  if (touched.has(el)) return false;
  if (el.localName === 'input' && (el as HTMLInputElement).type === 'checkbox') {
    // defaultChecked is the checked attribute in the page's own markup.
    const box = el as HTMLInputElement;
    return box.checked && box.defaultChecked;
  }
  const ticked = el.getAttribute('aria-checked') === 'true';
  if (!firstSeenTicked.has(el)) firstSeenTicked.set(el, ticked);
  return ticked && firstSeenTicked.get(el) === true;
}

// Countdowns

const MAX_SECONDS = 24 * 60 * 60;

/** Words that make a clock reading a countdown rather than a time of day. */
const COUNTDOWN_WORDS =
  /\b(time left|left|remaining|expires?|expiring|expiry|session|times? out|timeout|holding|held|reserved|ends? in|countdown|count down)\b/i;
/** 4:59 or 1:04:59, but not 7:30 pm. */
const CLOCK = /(?<![\d:])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?![\d:])(?!\s*[ap]\.?m\b)/i;

const UNIT = String.raw`(\d+)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)`;
const DURATION = String.raw`${UNIT}(?:\s*(?:and\s+)?${UNIT})*`;
/** "4 minutes left", "expires in 2 minutes", "time remaining: 3 minutes 10 seconds". */
const WORDED = [
  new RegExp(String.raw`(${DURATION})\s+(?:left|remaining)\b`, 'i'),
  new RegExp(
    String.raw`\b(?:expires?|expiring|ends?|times? out|closes?|runs? out)\s+in\s+(${DURATION})`,
    'i',
  ),
  new RegExp(String.raw`\btime (?:left|remaining)\W+(${DURATION})`, 'i'),
];

/**
 * Seconds left on a countdown written in `text`, or null when it holds none. `isTimer` is
 * true when the page marks the text as a timer, so a bare clock reading counts.
 */
export function countdownSeconds(text: string, isTimer = false): number | null {
  const clock = CLOCK.exec(text);
  if (clock && (isTimer || COUNTDOWN_WORDS.test(text))) {
    const [, hours, minutes, seconds] = clock;
    const total = Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
    if (Number(seconds) < 60 && total <= MAX_SECONDS) return total;
  }
  for (const pattern of WORDED) {
    const match = pattern.exec(text);
    if (match) {
      const total = durationSeconds(match[1]);
      if (total > 0 && total <= MAX_SECONDS) return total;
    }
  }
  return null;
}

function durationSeconds(text: string): number {
  let total = 0;
  for (const [, amount, unit] of text.matchAll(new RegExp(UNIT, 'gi'))) {
    const scale = /^h/i.test(unit) ? 3600 : /^m/i.test(unit) ? 60 : 1;
    total += Number(amount) * scale;
  }
  return total;
}
