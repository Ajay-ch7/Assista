// Action tools that run in the page: click, type, select, scroll and back. Each acts on a
// reference id from the latest snapshot, and a reference from an older snapshot is refused.

import { gateCheck } from '../safety/gate';
import { isSensitiveField } from '../safety/redaction';
import type { ActionDone, ActionReply, ToolRequest } from '../shared/messages';
import { kindOf, savedValueFor } from './saved';
import { StaleRefError, describeElement, resolveRef } from './snapshot';

/** Runs something after the reply has been sent; a click can unload the page. */
type Defer = (run: () => void) => void;
const afterReply: Defer = (run) => setTimeout(run, 0);

const NOT_TEXT_INPUTS = new Set([
  'button',
  'submit',
  'reset',
  'image',
  'checkbox',
  'radio',
  'file',
  'range',
  'color',
  'hidden',
]);

class ActionError extends Error {}

export function runAction(
  tool: ToolRequest,
  doc: Document = document,
  defer: Defer = afterReply,
): ActionReply {
  try {
    switch (tool.name) {
      case 'click':
        return click(target(tool), tool, defer);
      case 'type':
        return type(target(tool), tool.args.text, tool.args.use_saved === true);
      case 'select':
        return select(target(tool), tool.args.option);
      case 'focus':
        return focus(target(tool));
      case 'scroll':
        return scroll(tool, doc);
      case 'go_back':
        defer(() => doc.defaultView!.history.back());
        return done({ action: 'go_back' });
      default:
        return failed('unknown_tool');
    }
  } catch (error) {
    if (error instanceof StaleRefError) return failed('stale_ref');
    if (error instanceof ActionError) return failed(error.message);
    return failed(`action_failed: ${String(error)}`);
  }
}

function done(result: ActionDone): ActionReply {
  return { ok: true, result };
}

function failed(error: string): ActionReply {
  return { ok: false, error };
}

function target(tool: ToolRequest): Element {
  if (!tool.ref) throw new ActionError('missing_ref');
  return resolveRef(tool.snapshotId, tool.ref);
}

function click(el: Element, tool: ToolRequest, defer: Defer): ActionReply {
  const described = describeElement(el);
  if (isDisabled(el)) return failed('disabled');
  if (isTextField(el) && isSensitiveField(el, described.name)) {
    return focusPrivately(el, described.name);
  }
  const hold = gateCheck(el, described.name, tool.heard);
  if (hold) {
    if (!tool.confirmed) return { ok: false, error: 'held_by_gate', held: hold };
    // The user agreed to what was read back. If the control now reads differently, the
    // page changed it in the meantime, and the agreement no longer covers it.
    if (tool.confirmed.control !== hold.control) return failed('changed_since_confirmation');
  }
  reveal(el);
  defer(() => (el as HTMLElement).click());
  return done({ action: 'click', target: described });
}

function type(el: Element, text: unknown, useSaved: boolean): ActionReply {
  const described = describeElement(el);
  if (useSaved) {
    // The value comes from the device's own store; the model never sees it beforehand.
    text = isTextField(el) ? savedValueFor(el, described.name) : null;
    if (typeof text !== 'string') return failed('nothing_saved');
  }
  if (typeof text !== 'string') return failed('missing_text');
  if (!isTextField(el)) return failed('not_a_text_field');
  if (isDisabled(el) || (el as HTMLInputElement).readOnly === true) return failed('disabled');
  // Secrets are typed by the user, never by the assistant: nothing spoken or sent to a
  // model may end up in a password, code, card or PIN field.
  if (isSensitiveField(el, described.name)) return focusPrivately(el, described.name);
  reveal(el);
  setValue(el, text);
  const typed: ActionDone = { action: 'type', target: described, detail: text };
  const kind = kindOf(el, described.name);
  if (kind) typed.kind = kind;
  if (useSaved) typed.fromSaved = true;
  return done(typed);
}

function select(el: Element, option: unknown): ActionReply {
  if (el.localName !== 'select') return failed('not_a_select');
  if (isDisabled(el)) return failed('disabled');
  const box = el as HTMLSelectElement;
  const wanted = typeof option === 'string' ? option.trim().toLowerCase() : '';
  const options = Array.from(box.options).filter((item) => !item.disabled);
  const label = (item: HTMLOptionElement) => item.text.trim();
  const match =
    options.find(
      (item) => label(item).toLowerCase() === wanted || item.value.toLowerCase() === wanted,
    ) ?? options.find((item) => wanted !== '' && label(item).toLowerCase().includes(wanted));
  if (!wanted || !match) {
    return failed(`no_such_option: ${options.map(label).slice(0, 12).join(' | ')}`);
  }
  reveal(el);
  if (box.multiple) match.selected = true;
  else box.value = match.value;
  notify(el);
  return done({ action: 'select', target: describeElement(el), detail: label(match) });
}

function scroll(tool: ToolRequest, doc: Document): ActionReply {
  const view = doc.defaultView!;
  if (tool.ref) {
    const el = target(tool);
    el.scrollIntoView?.({ block: 'center' });
    return done({ action: 'scroll', target: describeElement(el) });
  }
  const direction = typeof tool.args.direction === 'string' ? tool.args.direction : 'down';
  const page = view.innerHeight * 0.85;
  const height = doc.documentElement.scrollHeight;
  switch (direction) {
    case 'down':
      view.scrollBy(0, page);
      break;
    case 'up':
      view.scrollBy(0, -page);
      break;
    case 'top':
      view.scrollTo(0, 0);
      break;
    case 'bottom':
      view.scrollTo(0, height);
      break;
    default:
      return failed('bad_direction');
  }
  let detail: string = direction;
  if (view.scrollY + view.innerHeight >= height - 2) detail = 'bottom of the page';
  else if (view.scrollY <= 0) detail = 'top of the page';
  return done({ action: 'scroll', detail });
}

/** Moves keyboard focus to an element without pressing or typing anything. */
function focus(el: Element): ActionReply {
  const described = describeElement(el);
  if (isTextField(el) && isSensitiveField(el, described.name)) {
    return focusPrivately(el, described.name);
  }
  // Headings and plain text take focus only once they have a tabindex.
  if ((el as HTMLElement).tabIndex < 0 && !el.hasAttribute('tabindex')) {
    el.setAttribute('tabindex', '-1');
  }
  reveal(el);
  return done({ action: 'focus', target: described });
}

/** Moves focus to a sensitive field and reports that the user must type it. */
function focusPrivately(el: Element, name: string): ActionReply {
  reveal(el);
  return { ok: false, error: 'sensitive_field', sensitive: { field: name } };
}

function reveal(el: Element): void {
  el.scrollIntoView?.({ block: 'center' });
  (el as HTMLElement).focus?.({ preventScroll: true });
}

function isDisabled(el: Element): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
}

function isEditable(el: Element): boolean {
  const editable = el.getAttribute('contenteditable');
  return editable === '' || editable === 'true' || editable === 'plaintext-only';
}

function isTextField(el: Element): boolean {
  if (el.localName === 'textarea') return true;
  if (el.localName === 'input') return !NOT_TEXT_INPUTS.has((el as HTMLInputElement).type);
  return isEditable(el);
}

/** Sets a field's value the way typing would, so frameworks that watch input events see it. */
function setValue(el: Element, text: string): void {
  const view = el.ownerDocument.defaultView!;
  if (el.localName === 'input' || el.localName === 'textarea') {
    const prototype =
      el.localName === 'textarea'
        ? view.HTMLTextAreaElement.prototype
        : view.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(el, text);
    else (el as HTMLInputElement).value = text;
  } else {
    el.textContent = text;
  }
  notify(el);
}

function notify(el: Element): void {
  const view = el.ownerDocument.defaultView!;
  el.dispatchEvent(new view.Event('input', { bubbles: true }));
  el.dispatchEvent(new view.Event('change', { bubbles: true }));
}
