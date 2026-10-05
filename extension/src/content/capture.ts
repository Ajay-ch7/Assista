// Gets the page ready for a screenshot: brings the element to crop into view and covers
// sensitive fields, so a typed password or card number never reaches a screenshot.

import { isSensitiveField } from '../safety/redaction';
import type { CaptureFrame } from '../shared/messages';
import { resolveLatestRef } from './snapshot';

const MASK_ATTRIBUTE = 'data-assista-mask';
const FIELD_SELECTOR = 'input, textarea, [contenteditable]:not([contenteditable="false"])';

/**
 * Scrolls the element behind `ref` (from the latest snapshot) into view, masks sensitive
 * fields and waits for the page to paint. Returns where the element is in the viewport.
 */
export async function prepareCapture(
  ref?: string,
  doc: Document = document,
): Promise<CaptureFrame> {
  const view = doc.defaultView!;
  let target: Element | null = null;
  if (ref) {
    target = resolveLatestRef(ref);
    target.scrollIntoView({ block: 'center', inline: 'center' });
  }
  maskSensitiveFields(doc);
  await nextPaint(view);

  const viewport = { width: view.innerWidth, height: view.innerHeight };
  if (!target) return { viewport, rect: null };
  const box = target.getBoundingClientRect();
  return { viewport, rect: { x: box.x, y: box.y, width: box.width, height: box.height } };
}

export function endCapture(doc: Document = document): void {
  for (const mask of doc.querySelectorAll(`[${MASK_ATTRIBUTE}]`)) mask.remove();
}

/** Covers every sensitive field that is on screen with an opaque box. Returns how many. */
export function maskSensitiveFields(doc: Document = document): number {
  endCapture(doc);
  const view = doc.defaultView!;
  let masked = 0;
  for (const field of doc.querySelectorAll(FIELD_SELECTOR)) {
    if (!isSensitiveField(field, labelText(field))) continue;
    const box = field.getBoundingClientRect();
    if (box.bottom < 0 || box.right < 0 || box.top > view.innerHeight) continue;
    const mask = doc.createElement('div');
    mask.setAttribute(MASK_ATTRIBUTE, '');
    mask.setAttribute('aria-hidden', 'true');
    Object.assign(mask.style, {
      position: 'fixed',
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${Math.max(box.width, 1)}px`,
      height: `${Math.max(box.height, 1)}px`,
      background: '#000',
      zIndex: '2147483647',
      pointerEvents: 'none',
    });
    doc.documentElement.append(mask);
    masked++;
  }
  return masked;
}

function labelText(field: Element): string {
  const labels = (field as HTMLInputElement).labels;
  return Array.from(labels ?? [], (label) => label.textContent ?? '').join(' ');
}

/** Resolves once the page has painted its current state; bounded, as hidden tabs never paint. */
function nextPaint(view: Window): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 150);
    view.requestAnimationFrame(() =>
      view.requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      }),
    );
  });
}
