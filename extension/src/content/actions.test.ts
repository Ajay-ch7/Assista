// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionReply, ToolRequest } from '../shared/messages';
import type { PageSnapshot } from '../shared/snapshot';
import { runAction } from './actions';
import { setSavedDetails } from './saved';
import { buildSnapshot } from './snapshot';

let snapshot: PageSnapshot;

function page(html: string): void {
  document.body.innerHTML = html;
  snapshot = buildSnapshot(document);
}

function refOf(name: string): string {
  const node = snapshot.nodes.find((item) => item.name === name);
  if (!node) throw new Error(`no node named ${name}`);
  return node.ref;
}

/** Runs a tool against the current snapshot, with deferred work done at once. */
function run(name: string, target?: string, args: Record<string, unknown> = {}): ActionReply {
  const tool: ToolRequest = {
    name,
    snapshotId: snapshot.snapshot_id,
    ref: target === undefined ? undefined : refOf(target),
    args,
  };
  return runAction(tool, document, (work) => work());
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('click', () => {
  it('clicks the element and says what it clicked', () => {
    page('<button id="b">Add to cart</button>');
    const clicked = vi.fn();
    document.getElementById('b')!.addEventListener('click', clicked);
    expect(run('click', 'Add to cart')).toEqual({
      ok: true,
      result: { action: 'click', target: { role: 'button', name: 'Add to cart' } },
    });
    expect(clicked).toHaveBeenCalledOnce();
    expect(document.activeElement?.id).toBe('b');
  });

  it('ticks a checkbox', () => {
    page('<label><input type="checkbox" id="c"> Gift wrap</label>');
    run('click', 'Gift wrap');
    expect((document.getElementById('c') as HTMLInputElement).checked).toBe(true);
  });

  it('refuses a disabled control', () => {
    page('<button disabled>Pay</button>');
    expect(run('click', 'Pay')).toEqual({ ok: false, error: 'disabled' });
  });

  it('replies before the click happens, because a click can unload the page', () => {
    page('<a href="#next" id="a">Next page</a>');
    const clicked = vi.fn();
    document.getElementById('a')!.addEventListener('click', clicked);
    let deferred: (() => void) | undefined;
    const tool = {
      name: 'click',
      snapshotId: snapshot.snapshot_id,
      ref: refOf('Next page'),
      args: {},
    };
    const reply = runAction(tool, document, (work) => (deferred = work));
    expect(reply.ok).toBe(true);
    expect(clicked).not.toHaveBeenCalled();
    deferred!();
    expect(clicked).toHaveBeenCalledOnce();
  });
});

describe('click: confirmation gate', () => {
  function tool(name: string, confirmed?: { control: string }): ToolRequest {
    return {
      name: 'click',
      snapshotId: snapshot.snapshot_id,
      ref: refOf(name),
      args: {},
      confirmed,
    };
  }

  it('holds a risky control and does nothing', () => {
    page('<button id="b" type="button">Place order</button>');
    const clicked = vi.fn();
    document.getElementById('b')!.addEventListener('click', clicked);
    expect(run('click', 'Place order')).toEqual({
      ok: false,
      error: 'held_by_gate',
      held: { control: 'Place order', reason: 'risky_control' },
    });
    expect(clicked).not.toHaveBeenCalled();
  });

  it('holds a form submission', () => {
    page('<form><label>Name <input></label><button id="b">Continue</button></form>');
    const submitted = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('form')!.addEventListener('submit', submitted);
    expect(run('click', 'Continue')).toMatchObject({
      error: 'held_by_gate',
      held: { control: 'Continue', reason: 'form_submit' },
    });
    expect(submitted).not.toHaveBeenCalled();
  });

  it('ignores anything the backend puts in the arguments', () => {
    page('<button id="b" type="button">Pay now</button>');
    const clicked = vi.fn();
    document.getElementById('b')!.addEventListener('click', clicked);
    const reply = run('click', 'Pay now', { confirmed: true, force: true, control: 'Pay now' });
    expect(reply).toMatchObject({ ok: false, error: 'held_by_gate' });
    expect(clicked).not.toHaveBeenCalled();
  });

  it('runs a held action once the user has confirmed it', () => {
    page('<button id="b" type="button">Place order</button>');
    const clicked = vi.fn();
    document.getElementById('b')!.addEventListener('click', clicked);
    const reply = runAction(tool('Place order', { control: 'Place order' }), document, (work) =>
      work(),
    );
    expect(reply).toMatchObject({ ok: true, result: { action: 'click' } });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it('refuses when the control changed after the user heard it read back', () => {
    page('<button id="b" type="button">Send feedback</button>');
    const clicked = vi.fn();
    const button = document.getElementById('b')!;
    button.addEventListener('click', clicked);
    const request = tool('Send feedback', { control: 'Send feedback' });
    button.textContent = 'Send 5,000 rupees';
    expect(runAction(request, document, (work) => work())).toEqual({
      ok: false,
      error: 'changed_since_confirmation',
    });
    expect(clicked).not.toHaveBeenCalled();
  });
});

describe('click: actions nobody asked for', () => {
  function click(name: string, heard: string[], args: Record<string, unknown> = {}) {
    const tool: ToolRequest = {
      name: 'click',
      snapshotId: snapshot.snapshot_id,
      ref: refOf(name),
      args,
      heard,
    };
    return runAction(tool, document, (work) => work());
  }

  it('holds a press the user did not ask for, and does nothing', () => {
    page('<button id="b" type="button">Subscribe</button>');
    const clicked = vi.fn();
    document.getElementById('b')!.addEventListener('click', clicked);
    expect(click('Subscribe', ['scroll down'])).toEqual({
      ok: false,
      error: 'held_by_gate',
      held: { control: 'Subscribe', reason: 'not_requested' },
    });
    expect(clicked).not.toHaveBeenCalled();
  });

  it('runs a press the user asked for', () => {
    page('<button id="b" type="button">Subscribe</button>');
    expect(click('Subscribe', ['press the subscribe button'])).toMatchObject({ ok: true });
  });

  it('takes what was heard from the panel, never from the tool arguments', () => {
    page('<button id="b" type="button">Subscribe</button>');
    const clicked = vi.fn();
    document.getElementById('b')!.addEventListener('click', clicked);
    const smuggled = { heard: ['press subscribe'], confirmed: { control: 'Subscribe' } };
    expect(click('Subscribe', ['what is this page?'], smuggled)).toMatchObject({
      ok: false,
      error: 'held_by_gate',
    });
    expect(clicked).not.toHaveBeenCalled();
  });
});

describe('type', () => {
  it('fills a field and fires the events a typing user would', () => {
    page('<label>Full name <input id="n"></label>');
    const field = document.getElementById('n') as HTMLInputElement;
    const events: string[] = [];
    field.addEventListener('input', () => events.push('input'));
    field.addEventListener('change', () => events.push('change'));
    expect(run('type', 'Full name', { text: 'Asha Rao' })).toEqual({
      ok: true,
      result: {
        action: 'type',
        target: { role: 'textbox', name: 'Full name' },
        detail: 'Asha Rao',
        kind: 'name',
      },
    });
    expect(field.value).toBe('Asha Rao');
    expect(events).toEqual(['input', 'change']);
  });

  it('fills a textarea and replaces what was there', () => {
    page('<label>Address <textarea id="t">old</textarea></label>');
    run('type', 'Address', { text: '12 Lake Road' });
    expect((document.getElementById('t') as HTMLTextAreaElement).value).toBe('12 Lake Road');
  });

  it.each([
    ['<label>Password <input type="password" id="f"></label>', 'Password'],
    ['<label>One-time code <input id="f" autocomplete="one-time-code"></label>', 'One-time code'],
    ['<label>Card number <input id="f"></label>', 'Card number'],
    ['<label>PIN <input id="f"></label>', 'PIN'],
  ])('never types into a sensitive field, and moves focus there instead', (html, name) => {
    page(html);
    const reply = run('type', name, { text: '493817' });
    expect(reply).toEqual({ ok: false, error: 'sensitive_field', sensitive: { field: name } });
    expect((document.getElementById('f') as HTMLInputElement).value).toBe('');
    expect(document.activeElement?.id).toBe('f');
  });

  it('moves focus to a sensitive field when it is clicked', () => {
    page('<label>Password <input type="password" id="f"></label>');
    expect(run('click', 'Password')).toMatchObject({ ok: false, error: 'sensitive_field' });
    expect(document.activeElement?.id).toBe('f');
  });

  it('refuses things that are not text fields, read-only fields and missing text', () => {
    page(`<button>Go</button><label>Code <input readonly value="x"></label>
          <label>Name <input></label>`);
    expect(run('type', 'Go', { text: 'x' })).toEqual({ ok: false, error: 'not_a_text_field' });
    expect(run('type', 'Code', { text: 'y' })).toEqual({ ok: false, error: 'disabled' });
    expect(run('type', 'Name')).toEqual({ ok: false, error: 'missing_text' });
  });
});

describe('type: saved details', () => {
  afterEach(() => setSavedDetails({}));

  it('fills a field from the saved details when asked to', () => {
    setSavedDetails({ phone: '98450 12345' });
    page('<label>Mobile number <input id="p" type="tel"></label>');
    expect(run('type', 'Mobile number', { use_saved: true })).toEqual({
      ok: true,
      result: {
        action: 'type',
        target: { role: 'textbox', name: 'Mobile number' },
        detail: '98450 12345',
        kind: 'phone',
        fromSaved: true,
      },
    });
    expect((document.getElementById('p') as HTMLInputElement).value).toBe('98450 12345');
  });

  it('says so when nothing fits the field', () => {
    setSavedDetails({ phone: '98450 12345' });
    page('<label>City <input></label>');
    expect(run('type', 'City', { use_saved: true })).toEqual({ ok: false, error: 'nothing_saved' });
  });

  it('never fills a sensitive field from the saved details', () => {
    setSavedDetails({ name: 'Asha Rao', phone: '98450 12345' });
    page('<label>Phone PIN <input id="f"></label>');
    expect(run('type', 'Phone PIN', { use_saved: true })).toEqual({
      ok: false,
      error: 'nothing_saved',
    });
    expect((document.getElementById('f') as HTMLInputElement).value).toBe('');
  });

  it('reports no kind for a field that is not a personal detail', () => {
    page('<label>Special requests <input></label>');
    const reply = run('type', 'Special requests', { text: 'A quiet table' });
    expect(reply).toMatchObject({ ok: true });
    expect(reply.ok && reply.result.kind).toBeUndefined();
  });
});

describe('select', () => {
  const HTML = `<label>Delivery <select id="s">
    <option value="std">Standard</option><option value="exp">Express delivery</option>
  </select></label>`;

  it('chooses an option by its text, part of its text or its value', () => {
    for (const option of ['Express delivery', 'express', 'EXP']) {
      page(HTML);
      const reply = run('select', 'Delivery', { option });
      expect(reply).toMatchObject({ ok: true, result: { detail: 'Express delivery' } });
      expect((document.getElementById('s') as HTMLSelectElement).value).toBe('exp');
    }
  });

  it('lists the options when none matches', () => {
    page(HTML);
    expect(run('select', 'Delivery', { option: 'Overnight' })).toEqual({
      ok: false,
      error: 'no_such_option: Standard | Express delivery',
    });
  });

  it('refuses anything that is not a select', () => {
    page('<label>Name <input></label>');
    expect(run('select', 'Name', { option: 'x' })).toEqual({ ok: false, error: 'not_a_select' });
  });
});

describe('scroll and back', () => {
  it('scrolls by most of a screen and reports where it ended', () => {
    page('<p>Text</p>');
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 5000,
      configurable: true,
    });
    Object.defineProperty(window, 'scrollY', { value: 600, configurable: true });
    expect(run('scroll', undefined, { direction: 'down' })).toEqual({
      ok: true,
      result: { action: 'scroll', detail: 'down' },
    });
    expect(scrollBy).toHaveBeenCalledWith(0, window.innerHeight * 0.85);
    Object.defineProperty(window, 'scrollY', { value: 5000, configurable: true });
    expect(run('scroll', undefined, { direction: 'down' })).toMatchObject({
      result: { detail: 'bottom of the page' },
    });
    expect(run('scroll', undefined, { direction: 'sideways' })).toEqual({
      ok: false,
      error: 'bad_direction',
    });
  });

  it('goes back in history', () => {
    page('<p>Text</p>');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    expect(run('go_back')).toEqual({ ok: true, result: { action: 'go_back' } });
    expect(back).toHaveBeenCalledOnce();
  });
});

describe('focus', () => {
  it('moves focus to a field without typing or pressing anything', () => {
    page('<label>Search <input id="q" type="search"></label>');
    expect(run('focus', 'Search')).toEqual({
      ok: true,
      result: { action: 'focus', target: { role: 'searchbox', name: 'Search' } },
    });
    expect(document.activeElement?.id).toBe('q');
    expect((document.getElementById('q') as HTMLInputElement).value).toBe('');
  });

  it('can move focus to a heading', () => {
    page('<h2 id="h">Reviews</h2>');
    expect(run('focus', 'Reviews')).toMatchObject({ ok: true });
    expect(document.activeElement?.id).toBe('h');
  });

  it('hands a private field to the user', () => {
    page('<label>Password <input id="p" type="password"></label>');
    expect(run('focus', 'Password')).toEqual({
      ok: false,
      error: 'sensitive_field',
      sensitive: { field: 'Password' },
    });
    expect(document.activeElement?.id).toBe('p');
  });
});

describe('references', () => {
  it('rejects a reference from an older snapshot', () => {
    page('<button>Buy</button>');
    const old = snapshot;
    buildSnapshot(document);
    const tool = { name: 'click', snapshotId: old.snapshot_id, ref: old.nodes[0].ref, args: {} };
    expect(runAction(tool, document)).toEqual({ ok: false, error: 'stale_ref' });
  });

  it('rejects an element that has left the page, a missing reference and unknown tools', () => {
    page('<button>Buy</button>');
    const ref = refOf('Buy');
    document.body.innerHTML = '';
    const base = { snapshotId: snapshot.snapshot_id, args: {} };
    expect(runAction({ ...base, name: 'click', ref }, document)).toEqual({
      ok: false,
      error: 'stale_ref',
    });
    expect(runAction({ ...base, name: 'click' }, document)).toEqual({
      ok: false,
      error: 'missing_ref',
    });
    expect(runAction({ ...base, name: 'launch', ref }, document)).toEqual({
      ok: false,
      error: 'unknown_tool',
    });
  });
});
