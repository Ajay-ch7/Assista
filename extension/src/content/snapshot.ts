// Page snapshot v1 (implementation.md section 5.2): roles, names, visible text and form
// fields in document order, each with a short reference id.

import { isHiddenElement } from '../safety/hiddenText';
import { NavigationMemory, clutterKind } from './clutter';
import { countdownSeconds, isPreticked } from './rules';
import { savedValueFor } from './saved';
import { isThin } from './thin';
import { isSensitiveField } from '../safety/redaction';
import type {
  NodeState,
  PageSnapshot,
  SnapshotImage,
  SnapshotNode,
  SnapshotRules,
  SnapshotTable,
} from '../shared/snapshot';

const MAX_NODES = 800;
const MAX_TEXT = 800;
const MAX_TOTAL_TEXT = 40_000;
const MAX_NAME = 160;
const MAX_VALUE = 200;
const MAX_TABLES = 10;
const MAX_TABLE_ROWS = 40;
const MAX_CELL = 120;
const MAX_IMAGES = 60;

/** Elements with nothing to read or act on in v1. */
const SKIPPED_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'head',
  'iframe',
  'frame',
  'object',
  'embed',
  'svg',
  'canvas',
  'audio',
  'video',
  'datalist',
  'br',
  'hr',
  'wbr',
]);

/** Elements whose text does not belong to the text around them. */
const NOT_TEXT_TAGS = new Set([...SKIPPED_TAGS, 'select', 'textarea', 'input']);

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'td',
  'th',
  'tr',
  'ul',
]);

const CONTROL_ROLES = new Set([
  'link',
  'button',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'slider',
  'spinbutton',
]);

/** Controls that hold a value the user typed or chose. */
const FIELD_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'slider',
  'spinbutton',
]);
const CHECKABLE_ROLES = new Set([
  'checkbox',
  'radio',
  'switch',
  'menuitemcheckbox',
  'menuitemradio',
]);

const LANDMARK_ROLES = new Set([
  'banner',
  'navigation',
  'main',
  'complementary',
  'contentinfo',
  'search',
  'form',
  'region',
  'dialog',
  'alertdialog',
]);

const LANDMARK_TAGS: Record<string, string> = {
  nav: 'navigation',
  main: 'main',
  aside: 'complementary',
  search: 'search',
  form: 'form',
  dialog: 'dialog',
};

const TEXT_ROLES: Record<string, string> = {
  p: 'paragraph',
  li: 'listitem',
  blockquote: 'blockquote',
  figcaption: 'caption',
  legend: 'legend',
  dt: 'term',
  dd: 'definition',
  pre: 'code',
};

const INPUT_ROLES: Record<string, string> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  file: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
};

interface Build {
  nodes: SnapshotNode[];
  tables: SnapshotTable[];
  images: SnapshotImage[];
  elements: Map<string, Element>;
  nextId: { e: number; t: number; i: number };
  textBudget: number;
  hiddenRemoved: number;
  clutterRemoved: number;
  imagesWithoutAlt: number;
  preticked: string[];
  navigation: NavigationMemory;
  hiddenCache: WeakMap<Element, boolean>;
}

// Reference ids are valid only for the snapshot they came from.
let current: { id: string; elements: Map<string, Element> } | null = null;

export class StaleRefError extends Error {}

/** Finds the element behind a reference id. Throws for any snapshot but the latest. */
export function resolveRef(snapshotId: string, ref: string): Element {
  if (!current || current.id !== snapshotId) {
    throw new StaleRefError(`Snapshot ${snapshotId} is no longer current`);
  }
  const el = current.elements.get(ref);
  if (!el || !el.isConnected) throw new StaleRefError(`${ref} is not on the page`);
  return el;
}

/** Finds the element behind a reference id from the latest snapshot. */
export function resolveLatestRef(ref: string): Element {
  if (!current) throw new StaleRefError('There is no snapshot yet');
  return resolveRef(current.id, ref);
}

/** The role and name the snapshot gives `el`. */
export function describeElement(el: Element): { role: string; name: string } {
  // Naming only needs the cache of which elements are hidden.
  const build = { hiddenCache: new WeakMap<Element, boolean>() } as Build;
  return { role: roleOf(el) ?? 'element', name: clip(accessibleName(el, build), MAX_NAME) };
}

export function buildSnapshot(doc: Document = document): PageSnapshot {
  const build: Build = {
    nodes: [],
    tables: [],
    images: [],
    elements: new Map(),
    nextId: { e: 0, t: 0, i: 0 },
    textBudget: MAX_TOTAL_TEXT,
    hiddenRemoved: 0,
    clutterRemoved: 0,
    imagesWithoutAlt: 0,
    preticked: [],
    navigation: new NavigationMemory(),
    hiddenCache: new WeakMap(),
  };
  if (doc.body) walkChildren(doc.body, false, build);

  const snapshotId = newSnapshotId();
  current = { id: snapshotId, elements: build.elements };
  return {
    url: doc.location?.href ?? '',
    title: doc.title,
    snapshot_id: snapshotId,
    nodes: build.nodes,
    tables: build.tables,
    images: build.images,
    rules: rulesOf(build),
    flags: {
      has_canvas: doc.querySelector('canvas') !== null,
      thin: isThin(doc, build.nodes, build.images, build),
      clutter_removed: build.clutterRemoved,
      hidden_text_removed: build.hiddenRemoved,
      // Chrome's PDF viewer page, when a content script runs in it.
      ...(doc.contentType === 'application/pdf' ? { pdf: true } : {}),
    },
  };
}

function newSnapshotId(): string {
  // crypto.randomUUID is missing on plain http pages; getRandomValues is not.
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return 's' + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Walk

function walkChildren(el: Element, inText: boolean, build: Build): void {
  for (const child of el.children) visit(child, inText, build);
  if (el.shadowRoot) {
    for (const child of el.shadowRoot.children) visit(child, inText, build);
  }
}

/** `inText` is true when an ancestor's node already carries this element's text. */
function visit(el: Element, inText: boolean, build: Build): void {
  const tag = el.localName;
  if (SKIPPED_TAGS.has(tag)) return;
  if (el.getAttribute('aria-hidden') === 'true') return;
  if (tag === 'input' && (el as HTMLInputElement).type === 'hidden') return;
  if (isInClosedDetails(el)) return;
  if (isHidden(el, build) && !isDrawnByPage(el, build)) {
    if (/\S/.test(el.textContent ?? '')) build.hiddenRemoved++;
    return;
  }

  const role = roleOf(el);
  if (clutterKind(el, role, build.navigation)) {
    build.clutterRemoved++;
    return;
  }
  if (role === 'img') {
    addImage(el, build);
    return;
  }
  if (role === 'table') {
    addTable(el as HTMLTableElement, build);
    // The table carries the cell text; controls and images inside are still listed.
    walkChildren(el, true, build);
    return;
  }
  if (role === 'heading') {
    addNode(el, build, {
      role,
      name: clip(visibleText(el, build), MAX_NAME),
      text: '',
      state: { level: headingLevel(el) },
    });
    walkChildren(el, true, build);
    return;
  }
  if (role && CONTROL_ROLES.has(role)) {
    // A custom listbox is a container: its options are the controls.
    if (role !== 'listbox' || tag === 'select') {
      addControl(el, role, build);
      return;
    }
  }
  if (role && LANDMARK_ROLES.has(role)) {
    addNode(el, build, { role, name: clip(labelOf(el, build), MAX_NAME), text: '' });
  }

  if (!inText) {
    if (tag === 'label' && (el as HTMLLabelElement).control) {
      // The label's text is the name of its field.
      inText = true;
    } else if (hasDirectText(el)) {
      const textRole = TEXT_ROLES[tag] ?? 'text';
      if (hasBlockChild(el)) {
        addText(el, textRole, directText(el), build);
      } else {
        addText(el, textRole, visibleText(el, build), build);
        inText = true;
      }
    }
  }
  walkChildren(el, inText, build);
}

function isHidden(el: Element, build: Build): boolean {
  let hidden = build.hiddenCache.get(el);
  if (hidden === undefined) {
    hidden = isHiddenElement(el);
    build.hiddenCache.set(el, hidden);
  }
  return hidden;
}

/**
 * A native checkbox or radio button that the page hides in order to draw its own in its
 * place. The user sees and clicks its label, so the box is kept, named by that label. A
 * box whose labels are all hidden too is not.
 */
function isDrawnByPage(el: Element, build: Build): boolean {
  if (el.localName !== 'input') return false;
  const input = el as HTMLInputElement;
  if (input.type !== 'checkbox' && input.type !== 'radio') return false;
  return Array.from(input.labels ?? []).some(
    (label) => isShown(label, build) && visibleText(label, build) !== '',
  );
}

/** True when neither `el` nor any of its ancestors is hidden. */
function isShown(el: Element, build: Build): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (isHidden(node, build) || node.getAttribute('aria-hidden') === 'true') return false;
  }
  return true;
}

function isInClosedDetails(el: Element): boolean {
  const parent = el.parentElement;
  return (
    parent?.localName === 'details' &&
    !(parent as HTMLDetailsElement).open &&
    el.localName !== 'summary'
  );
}

// Roles

function roleOf(el: Element): string | null {
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0]?.toLowerCase();
  if (explicit === 'presentation' || explicit === 'none') return null;
  if (
    explicit &&
    (CONTROL_ROLES.has(explicit) ||
      LANDMARK_ROLES.has(explicit) ||
      explicit === 'heading' ||
      explicit === 'img')
  ) {
    return explicit;
  }

  const tag = el.localName;
  switch (tag) {
    case 'a':
    case 'area':
      return el.hasAttribute('href') ? 'link' : null;
    case 'button':
    case 'summary':
      return 'button';
    case 'select':
      return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
    case 'textarea':
      return 'textbox';
    case 'input': {
      const input = el as HTMLInputElement;
      return INPUT_ROLES[input.type] ?? (input.hasAttribute('list') ? 'combobox' : 'textbox');
    }
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'img':
      return 'img';
    case 'table':
      return isDataTable(el as HTMLTableElement) ? 'table' : null;
    case 'header':
      return el.closest('article, aside, main, nav, section') ? null : 'banner';
    case 'footer':
      return el.closest('article, aside, main, nav, section') ? null : 'contentinfo';
    case 'section':
      return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null;
  }
  if (LANDMARK_TAGS[tag]) return LANDMARK_TAGS[tag];
  const editable = el.getAttribute('contenteditable');
  if (editable === '' || editable === 'true' || editable === 'plaintext-only') return 'textbox';
  return null;
}

function headingLevel(el: Element): number {
  const aria = Number(el.getAttribute('aria-level'));
  if (aria >= 1) return aria;
  const match = /^h([1-6])$/.exec(el.localName);
  return match ? Number(match[1]) : 2;
}

/** Layout tables are read as ordinary content. */
function isDataTable(table: HTMLTableElement): boolean {
  if (table.querySelector('th, caption')) return true;
  return table.rows.length >= 2 && table.rows[0].cells.length >= 2;
}

// Nodes

/** Returns the new node's ref, or null when the snapshot is full. */
function addNode(el: Element, build: Build, node: Omit<SnapshotNode, 'ref'>): string | null {
  if (build.nodes.length >= MAX_NODES) return null;
  const ref = `e${++build.nextId.e}`;
  build.elements.set(ref, el);
  build.nodes.push({ ref, ...node });
  return ref;
}

function addText(el: Element, role: string, raw: string, build: Build): void {
  const text = clip(raw, MAX_TEXT);
  if (!text || build.textBudget <= 0) return;
  build.textBudget -= text.length;
  addNode(el, build, { role, name: '', text });
}

function addControl(el: Element, role: string, build: Build): void {
  const name = clip(accessibleName(el, build), MAX_NAME);
  const node: Omit<SnapshotNode, 'ref'> = { role, name, text: '', state: stateOf(el, role) };
  if (FIELD_ROLES.has(role)) {
    // Secrets stay on the device: a sensitive field's value is never read.
    if (isSensitiveField(el, name)) {
      node.sensitive = true;
      node.value = null;
      node.state = { ...node.state, filled: fieldValue(el, build) !== '' };
    } else {
      node.value = clip(fieldValue(el, build), MAX_VALUE);
      // An empty field that a saved detail fits: the assistant may offer to fill it.
      if (node.value === '' && savedValueFor(el, name) !== null) {
        node.state = { ...node.state, saved: true };
      }
    }
  }
  const ref = addNode(el, build, node);
  if (ref && isPreticked(el, role)) build.preticked.push(ref);
}

function stateOf(el: Element, role: string): NodeState {
  const state: NodeState = {
    disabled:
      (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
  };
  if (CHECKABLE_ROLES.has(role)) {
    const native = (el as HTMLInputElement).checked;
    state.checked =
      typeof native === 'boolean' ? native : el.getAttribute('aria-checked') === 'true';
  }
  const expanded = el.getAttribute('aria-expanded');
  if (expanded !== null) state.expanded = expanded === 'true';
  else if (el.localName === 'summary' && el.parentElement?.localName === 'details') {
    state.expanded = (el.parentElement as HTMLDetailsElement).open;
  }
  if ((el as HTMLInputElement).required === true || el.getAttribute('aria-required') === 'true') {
    state.required = true;
  }
  return state;
}

function fieldValue(el: Element, build: Build): string {
  if (el.localName === 'select') {
    return Array.from((el as HTMLSelectElement).selectedOptions, (option) => option.text).join(
      ', ',
    );
  }
  if (el.localName === 'input' || el.localName === 'textarea') {
    return (el as HTMLInputElement).value;
  }
  return visibleText(el, build);
}

function addImage(el: Element, build: Build): void {
  if (build.images.length >= MAX_IMAGES) return;
  const img = el as HTMLImageElement;
  const width = img.naturalWidth || img.width || 0;
  const height = img.naturalHeight || img.height || 0;
  // Tracking pixels and spacers.
  if (width > 0 && height > 0 && width <= 2 && height <= 2) return;
  const ref = `i${++build.nextId.i}`;
  build.elements.set(ref, el);
  const alt = el.getAttribute('alt') ?? labelOf(el, build);
  if (el.getAttribute('alt') === null && !alt) build.imagesWithoutAlt++;
  build.images.push({ ref, alt: clip(alt, MAX_NAME), width, height });
}

function addTable(table: HTMLTableElement, build: Build): void {
  if (build.tables.length >= MAX_TABLES) return;
  const ref = `t${++build.nextId.t}`;
  build.elements.set(ref, table);
  const caption = table.caption
    ? visibleText(table.caption, build)
    : (table.getAttribute('aria-label') ?? '');
  const rows = Array.from(table.rows)
    .filter((row) => !isHidden(row, build))
    .slice(0, MAX_TABLE_ROWS)
    .map((row) => Array.from(row.cells, (cell) => clip(visibleText(cell, build), MAX_CELL)));
  build.tables.push({ ref, caption: clip(caption, MAX_NAME), rows });
}

// Rules

/** Pre-ticked boxes were found during the walk; countdowns are found in the text read. */
function rulesOf(build: Build): SnapshotRules {
  const countdowns: SnapshotRules['countdowns'] = [];
  for (const node of build.nodes) {
    const text = node.text || (node.role === 'heading' ? node.name : '');
    if (!text) continue;
    const el = build.elements.get(node.ref);
    const isTimer = Boolean(el?.matches('[role="timer"]') || el?.querySelector('[role="timer"]'));
    const seconds = countdownSeconds(text, isTimer);
    if (seconds !== null) countdowns.push({ ref: node.ref, seconds_left: seconds });
  }
  return { preticked: build.preticked, countdowns };
}

// Names and text

function accessibleName(el: Element, build: Build): string {
  const label = labelOf(el, build);
  if (label) return label;

  const tag = el.localName;
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const input = el as HTMLInputElement;
    const labels = Array.from(input.labels ?? [], (item) => visibleText(item, build));
    const fromLabels = collapse(labels.join(' '));
    if (fromLabels) return fromLabels;
    if (tag === 'input' && ['button', 'submit', 'reset'].includes(input.type)) {
      return input.value || input.type;
    }
    return (
      el.getAttribute('placeholder') ||
      el.getAttribute('alt') ||
      el.getAttribute('title') ||
      el.getAttribute('name') ||
      ''
    );
  }

  const visible = visibleText(el, build);
  if (visible) return visible;
  const title = el.getAttribute('title');
  if (title) return title;
  // A control whose only label is visually hidden, for example an icon button.
  return textOf(el, build, true).slice(0, 80);
}

/** aria-labelledby, then aria-label. */
function labelOf(el: Element, build: Build): string {
  const ids = el.getAttribute('aria-labelledby');
  if (ids) {
    const text = ids
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id))
      .filter((target): target is HTMLElement => target !== null)
      .map((target) => visibleText(target, build))
      .join(' ');
    if (collapse(text)) return collapse(text);
  }
  return collapse(el.getAttribute('aria-label') ?? '');
}

/** The text a sighted user sees inside `el`, with whitespace collapsed. */
function visibleText(el: Element, build: Build): string {
  return textOf(el, build, false);
}

/** With `withHidden`, visually hidden text is read too; aria-hidden text never is. */
function textOf(el: Element, build: Build, withHidden: boolean): string {
  const parts: string[] = [];
  collectText(el, build, parts, withHidden);
  return collapse(parts.join(''));
}

function collectText(node: Node, build: Build, parts: string[], withHidden: boolean): void {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      parts.push(child.nodeValue ?? '');
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      const tag = el.localName;
      if (tag === 'br') parts.push(' ');
      if (NOT_TEXT_TAGS.has(tag) || el.getAttribute('aria-hidden') === 'true') continue;
      if (!withHidden && isHidden(el, build)) continue;
      if (tag === 'img') {
        parts.push(` ${el.getAttribute('alt') ?? ''} `);
        continue;
      }
      const block = BLOCK_TAGS.has(tag);
      if (block) parts.push(' ');
      collectText(el, build, parts, withHidden);
      if (block) parts.push(' ');
    }
  }
}

function hasDirectText(el: Element): boolean {
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE && /\S/.test(child.nodeValue ?? '')) return true;
  }
  return false;
}

function directText(el: Element): string {
  let text = '';
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) text += `${child.nodeValue ?? ''} `;
  }
  return collapse(text);
}

function hasBlockChild(el: Element): boolean {
  for (const child of el.children) {
    if (BLOCK_TAGS.has(child.localName)) return true;
  }
  return false;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  const clean = collapse(text);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
