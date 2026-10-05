// Decides whether an element is hidden from a sighted user. Hidden content is left out of
// the snapshot: the user cannot see it, so the assistant must not read it or act on it.
// This is the first defence against pages that plant instructions for the assistant (F21).
//
// The checks read computed style only, never layout, so one element costs one style lookup.

const OFFSCREEN_PX = -1000;
/** Colours closer than this (summed channel difference) cannot be told apart. */
const SAME_COLOUR = 12;

export function isHiddenElement(el: Element): boolean {
  if ((el as HTMLElement).hidden === true) return true;
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(el);

  if (style.display === 'none') return true;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  if (style.getPropertyValue('content-visibility') === 'hidden') return true;
  if (px(style.opacity) === 0) return true;
  if (px(style.fontSize) === 0) return true;
  if (isClippedAway(style)) return true;
  if (isMovedOffscreen(style)) return true;
  if (isCollapsedBox(style)) return true;
  if (hasDirectText(el) && isInvisibleInk(el, style, view)) return true;
  return false;
}

/** Parses "12px", "0" or "0.5"; NaN for "auto", "" and anything else. */
function px(value: string | undefined): number {
  // jsdom leaves the properties it does not know undefined.
  const text = (value ?? '').trim();
  return /^-?[\d.]+(px)?$/.test(text) ? parseFloat(text) : NaN;
}

function isClippedAway(style: CSSStyleDeclaration): boolean {
  const clip = (style.clip ?? '').replace(/\s+/g, '');
  if (/^rect\((0(px)?|1px),?(0(px)?|1px),?(0(px)?|1px),?(0(px)?|1px)\)$/.test(clip)) {
    return true;
  }
  const clipPath = (style.clipPath ?? '').replace(/\s+/g, '');
  return /^inset\((50|100)%\)$/.test(clipPath) || /^circle\(0(px|%)?\)$/.test(clipPath);
}

function isMovedOffscreen(style: CSSStyleDeclaration): boolean {
  if (px(style.textIndent) <= OFFSCREEN_PX) return true;
  if (style.position !== 'absolute' && style.position !== 'fixed') return false;
  return px(style.left) <= OFFSCREEN_PX || px(style.top) <= OFFSCREEN_PX;
}

/** A box squeezed to nothing, with its content cut off. */
function isCollapsedBox(style: CSSStyleDeclaration): boolean {
  const cutsOff = [style.overflow, style.overflowX, style.overflowY].some(
    (value) => value === 'hidden' || value === 'clip',
  );
  if (!cutsOff) return false;
  return [style.width, style.height, style.maxWidth, style.maxHeight].some(
    (value) => px(value) <= 1,
  );
}

type Rgba = [number, number, number, number];

function parseColour(value: string | undefined): Rgba | null {
  const match = /^rgba?\(([^)]+)\)$/.exec((value ?? '').trim());
  if (!match) return null;
  const parts = match[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

/**
 * Text drawn in its own background colour, or fully transparent. Only decided when the
 * background is a plain colour: over an image or a gradient the text may well be visible.
 */
function isInvisibleInk(el: Element, style: CSSStyleDeclaration, view: Window): boolean {
  const ink = parseColour(style.color);
  if (!ink) return false;
  if (ink[3] === 0) return true;

  let node: Element | null = el;
  let nodeStyle: CSSStyleDeclaration = style;
  while (node) {
    if (nodeStyle.backgroundImage && nodeStyle.backgroundImage !== 'none') return false;
    const background = parseColour(nodeStyle.backgroundColor);
    if (background && background[3] > 0) {
      if (background[3] < 1) return false;
      return distance(ink, background) <= SAME_COLOUR;
    }
    // Positioned content can sit on top of anything, so its backdrop is unknown.
    if (nodeStyle.position === 'absolute' || nodeStyle.position === 'fixed') return false;
    node = node.parentElement;
    if (node) nodeStyle = view.getComputedStyle(node);
  }
  // Nothing painted a background: the page shows the browser's white canvas.
  return distance(ink, [255, 255, 255, 1]) <= SAME_COLOUR;
}

function distance(a: Rgba, b: Rgba): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

function hasDirectText(el: Element): boolean {
  for (const child of el.childNodes) {
    if (child.nodeType === 3 && /\S/.test(child.nodeValue ?? '')) return true;
  }
  return false;
}
