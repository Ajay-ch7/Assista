// Confirmation gate (F07). Decides, in the extension, which clicks are held until the user
// says yes: any control that reads pay, buy, place order, submit, confirm, delete or send,
// and anything that submits a form. The rules are code, so no model reply can skip them.

export type GateReason = 'risky_control' | 'form_submit';

export interface GateHold {
  /** The control's name, as it is read back to the user. */
  control: string;
  reason: GateReason;
}

const RISKY_WORDS = /\b(?:pay|buy|purchase|place\s+(?:\w+\s+)?order|submit|confirm|delete|send)\b/i;

/** Returns why a click on `el` must wait for the user, or null when it may go ahead. */
export function gateCheck(el: Element, name: string): GateHold | null {
  const control = name || 'this control';
  if (RISKY_WORDS.test(wording(el, name))) return { control, reason: 'risky_control' };
  if (submitsForm(el)) return { control, reason: 'form_submit' };
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
