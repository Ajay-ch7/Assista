// Confirmation gate (F07, F21). Decides, in the extension, which actions are held until
// the user says yes:
// - any control that reads pay, buy, place order, submit, confirm, delete or send;
// - anything that submits a form;
// - anything the user did not ask for by name, which is what a page that plants
//   instructions for the assistant would cause.
// The rules are code, so no model reply can skip them.

export type GateReason = 'risky_control' | 'form_submit' | 'not_requested';

export interface GateHold {
  /** The control's name, as it is read back to the user. */
  control: string;
  reason: GateReason;
}

const RISKY_WORDS = /\b(?:pay|buy|purchase|place\s+(?:\w+\s+)?order|submit|confirm|delete|send)\b/i;

/** Words that say nothing about which control is meant: small words, and the verbs of asking. */
const FILLER = new Set(
  (
    'a an the to of and or for in on at my me i it this that these those is are be please ' +
    'now here there button link page tab box field ' +
    'press click tap hit push open go follow select choose pick tick untick check'
  ).split(' '),
);

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => !FILLER.has(word));
}

/** "book" and "booking", "subscribe" and "subscription" count as the same word. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  // They must agree on all but the last two letters of the shorter word, and on four.
  const needed = Math.max(4, Math.min(a.length, b.length) - 2);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return shared >= needed;
}

/**
 * True when one of the user's recent requests names the thing about to be acted on:
 * they share a word that says something. "Add it to the cart" asks for "Add to cart";
 * "scroll down" does not ask for "Subscribe".
 */
export function wasRequested(name: string, heard: readonly string[]): boolean {
  const said = heard.flatMap(tokens);
  return tokens(name).some((word) => said.some((other) => sameWord(word, other)));
}

/**
 * Returns why a click on `el` must wait for the user, or null when it may go ahead.
 * `heard` is what the user said in their recent requests, as the panel heard it.
 */
export function gateCheck(el: Element, name: string, heard?: readonly string[]): GateHold | null {
  const control = name || 'this control';
  if (RISKY_WORDS.test(wording(el, name))) return { control, reason: 'risky_control' };
  if (submitsForm(el)) return { control, reason: 'form_submit' };
  if (heard && !wasRequested(name, heard)) return { control, reason: 'not_requested' };
  return null;
}

/** Everything the control says about itself, seen or not. */
function wording(el: Element, name: string): string {
  return [
    name,
    el.textContent,
    el.getAttribute('value'),
    el.getAttribute('title'),
    el.getAttribute('aria-label'),
  ]
    .filter(Boolean)
    .join(' | ');
}

function submitsForm(el: Element): boolean {
  const control = el as HTMLButtonElement | HTMLInputElement;
  if (!(control.form ?? el.closest('form'))) return false;
  if (el.localName === 'button') return control.type === 'submit';
  if (el.localName === 'input') return control.type === 'submit' || control.type === 'image';
  return false;
}
