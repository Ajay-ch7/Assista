// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { PageSnapshot, SnapshotNode } from '../shared/snapshot';
import { setSavedDetails } from './saved';
import { StaleRefError, buildSnapshot, resolveRef } from './snapshot';

function snapshotOf(html: string): PageSnapshot {
  document.body.innerHTML = html;
  return buildSnapshot(document);
}

function byRole(snapshot: PageSnapshot, role: string): SnapshotNode[] {
  return snapshot.nodes.filter((node) => node.role === role);
}

describe('buildSnapshot: structure', () => {
  it('reports url, title, a fresh id and empty rule sets', () => {
    document.title = 'Shop';
    const first = snapshotOf('<p>Hello</p>');
    const second = snapshotOf('<p>Hello</p>');
    expect(first.title).toBe('Shop');
    expect(first.url).toBe(document.location.href);
    expect(first.snapshot_id).not.toBe(second.snapshot_id);
    expect(first.rules).toEqual({ preticked: [], countdowns: [] });
    expect(first.flags).toEqual({
      has_canvas: false,
      thin: false,
      clutter_removed: 0,
      hidden_text_removed: 0,
    });
  });

  it('lists headings, landmarks, links and buttons in document order', () => {
    const snapshot = snapshotOf(`
      <header><a href="/">Riverside</a></header>
      <nav aria-label="Main"><a href="/tents">Tents</a></nav>
      <main>
        <h1>Trail Backpack</h1>
        <h3>Details</h3>
        <button>Add to cart</button>
        <div role="button">Save for later</div>
      </main>
      <footer>Copyright 2026</footer>`);
    expect(snapshot.nodes.map((n) => [n.role, n.name])).toEqual([
      ['banner', ''],
      ['link', 'Riverside'],
      ['navigation', 'Main'],
      ['link', 'Tents'],
      ['main', ''],
      ['heading', 'Trail Backpack'],
      ['heading', 'Details'],
      ['button', 'Add to cart'],
      ['button', 'Save for later'],
      ['contentinfo', ''],
      ['text', ''],
    ]);
    expect(byRole(snapshot, 'heading').map((n) => n.state?.level)).toEqual([1, 3]);
    expect(snapshot.nodes.map((n) => n.ref)).toEqual(
      snapshot.nodes.map((_, index) => `e${index + 1}`),
    );
  });

  it('keeps a paragraph as one text node and still lists the links inside it', () => {
    const snapshot = snapshotOf(
      '<p>Read the <a href="/terms">terms</a> before you <b>buy</b>.</p><ul><li>Free returns</li></ul>',
    );
    expect(snapshot.nodes.map((n) => [n.role, n.name, n.text])).toEqual([
      ['paragraph', '', 'Read the terms before you buy.'],
      ['link', 'terms', ''],
      ['listitem', '', 'Free returns'],
    ]);
  });

  it('does not let a wrapper with loose text swallow the blocks inside it', () => {
    const snapshot = snapshotOf('<div>Sale ends soon<p>First offer</p><p>Second offer</p></div>');
    expect(snapshot.nodes.map((n) => n.text)).toEqual([
      'Sale ends soon',
      'First offer',
      'Second offer',
    ]);
  });

  it('skips scripts, styles, aria-hidden content and closed details', () => {
    const snapshot = snapshotOf(`
      <script>var secret = 1;</script><style>p { color: red; }</style>
      <span aria-hidden="true">decorative</span>
      <details><summary>More</summary><p>Folded away</p></details>
      <details open><summary>Open</summary><p>On show</p></details>`);
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('decorative');
    expect(text).not.toContain('Folded away');
    expect(text).toContain('On show');
    expect(byRole(snapshot, 'button').map((n) => [n.name, n.state?.expanded])).toEqual([
      ['More', false],
      ['Open', true],
    ]);
  });

  it('reads only what is visible', () => {
    const snapshot = snapshotOf(`
      <p>Shown</p>
      <p style="display:none">Not displayed</p>
      <p hidden>Hidden attribute</p>
      <div style="visibility:hidden"><button>Ghost</button></div>
      <p>Before <span style="display:none">inline secret</span>after</p>`);
    expect(snapshot.nodes.map((n) => n.text || n.name)).toEqual(['Shown', 'Before after']);
  });
});

describe('buildSnapshot: names', () => {
  it('names controls from aria attributes, labels, alt text and titles', () => {
    const snapshot = snapshotOf(`
      <span id="l1">Delivery</span><span id="l2">notes</span>
      <textarea aria-labelledby="l1 l2"></textarea>
      <button aria-label="Close dialog">X</button>
      <label for="email">Email address</label><input id="email" type="email">
      <label>Phone <input type="tel"></label>
      <input placeholder="Search products" type="search">
      <a href="/cart"><img src="cart.png" alt="Cart"></a>
      <button title="Refresh"></button>
      <input type="submit" value="Place order">
      <input name="coupon">`);
    const controls = snapshot.nodes.filter((n) => n.role !== 'text');
    expect(controls.map((n) => [n.role, n.name])).toEqual([
      ['textbox', 'Delivery notes'],
      ['button', 'Close dialog'],
      ['textbox', 'Email address'],
      ['textbox', 'Phone'],
      ['searchbox', 'Search products'],
      ['link', 'Cart'],
      ['button', 'Refresh'],
      ['button', 'Place order'],
      ['textbox', 'coupon'],
    ]);
    // A label wrapped around its field is the field's name, not a separate text node.
    expect(snapshot.nodes.some((n) => n.text.includes('Phone'))).toBe(false);
  });
});

describe('buildSnapshot: form fields', () => {
  it('reports values and states', () => {
    const snapshot = snapshotOf(`
      <input aria-label="Name" value="Asha" required>
      <select aria-label="Size"><option>Small</option><option selected>Large</option></select>
      <input type="checkbox" aria-label="Gift wrap" checked>
      <input type="radio" aria-label="Express" name="speed">
      <button disabled>Pay</button>
      <div role="switch" aria-checked="true" aria-label="Dark mode"></div>`);
    expect(snapshot.nodes).toEqual([
      expect.objectContaining({
        role: 'textbox',
        name: 'Name',
        value: 'Asha',
        state: { disabled: false, required: true },
      }),
      expect.objectContaining({ role: 'combobox', name: 'Size', value: 'Large' }),
      expect.objectContaining({ role: 'checkbox', state: { disabled: false, checked: true } }),
      expect.objectContaining({ role: 'radio', state: { disabled: false, checked: false } }),
      expect.objectContaining({ role: 'button', name: 'Pay', state: { disabled: true } }),
      expect.objectContaining({ role: 'switch', state: { disabled: false, checked: true } }),
    ]);
    expect(snapshot.nodes[2]).not.toHaveProperty('value');
  });

  it('never carries the value of a sensitive field', () => {
    const snapshot = snapshotOf(`
      <label>Password <input type="password" value="hunter2-secret"></label>
      <label>Card number <input name="card" value="4111111111111111"></label>
      <input aria-label="One-time code" autocomplete="one-time-code" value="493817">
      <label>PIN <input value="9921"></label>
      <label>PIN code <input value="560001"></label>`);
    const fields = byRole(snapshot, 'textbox');
    expect(fields.slice(0, 4).map((n) => [n.sensitive, n.value])).toEqual([
      [true, null],
      [true, null],
      [true, null],
      [true, null],
    ]);
    expect(fields[4]).toMatchObject({ name: 'PIN code', value: '560001' });
    expect(fields[4]).not.toHaveProperty('sensitive');
    const sent = JSON.stringify(snapshot);
    for (const secret of ['hunter2-secret', '4111111111111111', '493817', '9921']) {
      expect(sent).not.toContain(secret);
    }
  });
});

describe('buildSnapshot: private fields', () => {
  it('says whether a sensitive field is filled, without its value', () => {
    const snapshot = snapshotOf(`
      <label>Password <input type="password" value="hunter2-secret"></label>
      <label>One-time code <input autocomplete="one-time-code"></label>
      <label>Name <input value="Asha"></label>`);
    const [password, code, name] = byRole(snapshot, 'textbox');
    expect(password).toMatchObject({ sensitive: true, value: null, state: { filled: true } });
    expect(code).toMatchObject({ sensitive: true, value: null, state: { filled: false } });
    expect(name.state).not.toHaveProperty('filled');
    expect(JSON.stringify(snapshot)).not.toContain('hunter2');
  });
});

describe('buildSnapshot: saved details', () => {
  it('marks empty fields a saved detail fits, without the value', () => {
    setSavedDetails({ name: 'Asha Rao', phone: '98450 12345' });
    const snapshot = snapshotOf(`
      <label>Full name <input></label>
      <label>Phone <input type="tel" value="12345"></label>
      <label>City <input></label>
      <label>Password <input type="password"></label>`);
    setSavedDetails({});
    const [name, phone, city, password] = byRole(snapshot, 'textbox');
    expect(name.state).toMatchObject({ saved: true });
    expect(phone.state).not.toHaveProperty('saved');
    expect(city.state).not.toHaveProperty('saved');
    expect(password.state).not.toHaveProperty('saved');
    expect(JSON.stringify(snapshot)).not.toContain('Asha');
    expect(JSON.stringify(snapshot)).not.toContain('98450');
  });
});

describe('buildSnapshot: tables and images', () => {
  it('reports data tables with their caption and rows', () => {
    const snapshot = snapshotOf(`
      <table>
        <caption>Delivery options</caption>
        <tr><th>Speed</th><th>Price</th></tr>
        <tr><td>Standard</td><td>Free</td></tr>
        <tr><td>Express</td><td><a href="/express">99 rupees</a></td></tr>
      </table>`);
    expect(snapshot.tables).toEqual([
      {
        ref: 't1',
        caption: 'Delivery options',
        rows: [
          ['Speed', 'Price'],
          ['Standard', 'Free'],
          ['Express', '99 rupees'],
        ],
      },
    ]);
    // Cell text lives in the table; the link inside is still a node.
    expect(snapshot.nodes.map((n) => [n.role, n.name])).toEqual([['link', '99 rupees']]);
  });

  it('reads a layout table as ordinary content', () => {
    const snapshot = snapshotOf('<table><tr><td><p>Just layout</p></td></tr></table>');
    expect(snapshot.tables).toEqual([]);
    expect(snapshot.nodes.map((n) => n.text)).toEqual(['Just layout']);
  });

  it('reports images with alt text and size, and flags canvases', () => {
    const snapshot = snapshotOf(`
      <img src="bag.jpg" alt="A green backpack" width="400" height="300">
      <img src="chart.png" width="200" height="100">
      <img src="pixel.gif" width="1" height="1">
      <canvas></canvas>`);
    expect(snapshot.images).toEqual([
      { ref: 'i1', alt: 'A green backpack', width: 400, height: 300 },
      { ref: 'i2', alt: '', width: 200, height: 100 },
    ]);
    expect(snapshot.flags.has_canvas).toBe(true);
  });
});

describe('resolveRef', () => {
  it('finds the element behind a reference id', () => {
    const snapshot = snapshotOf('<button id="buy">Buy</button><img alt="Bag" src="b.png">');
    expect(resolveRef(snapshot.snapshot_id, 'e1')).toBe(document.getElementById('buy'));
    expect(resolveRef(snapshot.snapshot_id, 'i1').localName).toBe('img');
  });

  it('rejects a reference id from an older snapshot', () => {
    const old = snapshotOf('<button>Buy</button>');
    const fresh = buildSnapshot(document);
    expect(() => resolveRef(old.snapshot_id, 'e1')).toThrow(StaleRefError);
    expect(resolveRef(fresh.snapshot_id, 'e1').localName).toBe('button');
  });

  it('rejects unknown ids and elements that have left the page', () => {
    const snapshot = snapshotOf('<button>Buy</button>');
    expect(() => resolveRef(snapshot.snapshot_id, 'e99')).toThrow(StaleRefError);
    document.body.innerHTML = '';
    expect(() => resolveRef(snapshot.snapshot_id, 'e1')).toThrow(StaleRefError);
  });
});

describe('buildSnapshot: boxes drawn by the page', () => {
  // Shops often hide the real checkbox and draw their own; the label is what is seen.
  it.each([
    ['opacity: 0', 'position: absolute; opacity: 0;'],
    ['display: none', 'display: none;'],
    ['a 1px clip', 'position: absolute; clip: rect(0, 0, 0, 0);'],
  ])('keeps a box hidden with %s when its label is visible', (_, style) => {
    const snapshot = snapshotOf(`
      <style>.a-checkbox input { ${style} }</style>
      <div class="a-checkbox"><label><input type="checkbox" checked><i class="a-icon"></i>
        <span class="a-label">This order contains a gift</span></label></div>
      <label><input type="radio" name="w" style="${style}"> Gift wrap</label>
      <button>Proceed to Buy</button>`);
    expect(snapshot.nodes.map((n) => [n.role, n.name, n.state?.checked])).toEqual([
      ['checkbox', 'This order contains a gift', true],
      ['radio', 'Gift wrap', false],
      ['button', 'Proceed to Buy', undefined],
    ]);
    expect(snapshot.rules.preticked).toEqual([snapshot.nodes[0].ref]);
  });

  it('still drops a hidden box whose label is hidden too, or that has no label', () => {
    const snapshot = snapshotOf(`
      <label style="display: none"><input type="checkbox" checked> Subscribe me</label>
      <input type="checkbox" style="opacity: 0" aria-label="Agree to everything">
      <div style="opacity: 0"><label><input type="checkbox"> Share my data</label></div>`);
    expect(snapshot.nodes).toEqual([]);
  });
});
