// Decides whether a snapshot is too thin to describe the page on its own (flags.thin). When
// it is, the backend looks at a screenshot as well.

import type { SnapshotImage, SnapshotNode } from '../shared/snapshot';

/** Canvases, charts and labelled drawings carry meaning the snapshot cannot hold. */
const CHART_SELECTOR = [
  'canvas',
  'svg[role="img"]',
  'svg[aria-label]',
  '[role="graphics-document"]',
  '[class*="chart" i]',
  '[id*="chart" i]',
].join(', ');
/** Content that can fill a screen without any text. */
const VISUAL_SELECTOR = 'canvas, svg, video, iframe, picture, [style*="background-image"]';
const CONTROL_ROLES = new Set(['button', 'link']);
/** Below this many characters of text, a page with pictures on it says too little. */
const LITTLE_TEXT = 200;
const UNLABELED_SHARE = 0.25;

export interface ThinCounts {
  /** Images that carry no alt attribute or label at all. alt="" marks decoration and is fine. */
  imagesWithoutAlt: number;
}

export function isThin(
  doc: Document,
  nodes: SnapshotNode[],
  images: SnapshotImage[],
  counts: ThinCounts,
): boolean {
  // Images lack alt text: at least half of them, so one stray icon does not count.
  if (counts.imagesWithoutAlt > 0 && counts.imagesWithoutAlt * 2 >= images.length) return true;

  if (doc.querySelector(CHART_SELECTOR)) return true;

  const controls = nodes.filter((node) => CONTROL_ROLES.has(node.role));
  const unlabeled = controls.filter((node) => !node.name).length;
  if (unlabeled >= 2 || (unlabeled > 0 && unlabeled >= controls.length * UNLABELED_SHARE)) {
    return true;
  }

  const textLength = nodes.reduce((sum, node) => sum + node.text.length + node.name.length, 0);
  const visual = images.length > 0 || doc.querySelector(VISUAL_SELECTOR) !== null;
  return textLength < LITTLE_TEXT && visual;
}
