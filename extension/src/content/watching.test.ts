// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Watch } from '../shared/watch';
import { buildSnapshot } from './snapshot';
import { PageWatcher, readWatched, selectorFor, valueOf, watchTarget } from './watching';

function page(html: string) {
  document.body.innerHTML = html;
  return buildSnapshot(document);
}

function watchOn(selector: string, lastValue: string, extra: Partial<Watch> = {}): Watch {
  return {
    id: 'w1',
    url: document.location.href,
    pageTitle: 'Shop',
    selector,
    label: 'the price',
    lastValue,
    condition: { kind: 'changes' },
    alert: '',
    createdAt: 0,
    ...extra,
  };
}

describe('selectorFor', () => {
  it('uses a unique id', () => {
    page('<p id="price">4,499</p>');
    expect(selectorFor(document.getElementById('price')!)).toBe('#price');
  });

  it('builds a path when there is no usable id, and the path finds the element again', () => {
    page(`<main><div id="top"><p>One</p><p class="price">4,499</p></div>
          <div><p>Other</p><span>x</span></div></main>`);
    for (const el of document.querySelectorAll('p, span')) {
      const selector = selectorFor(el);
      expect(document.querySelectorAll(selector)).toHaveLength(1);
      expect(document.querySelector(selector)).toBe(el);
    }
    expect(selectorFor(document.querySelector('.price')!)).toBe('#top > p:nth-of-type(2)');
  });

  it('does not trust an id the page uses twice, and escapes odd ids', () => {
    page('<p id="a">One</p><p id="a">Two</p><p id="1:x">Three</p>');
    const [, second, third] = document.querySelectorAll('p');
    expect(document.querySelector(selectorFor(second))).toBe(second);
    expect(document.querySelector(selectorFor(third))).toBe(third);
  });
});

describe('watchTarget and values', () => {
  it('describes the element to watch', () => {
    document.title = 'Shop';
    const snapshot = page('<p id="price">Price:   4,499\n rupees</p>');
    const ref = snapshot.nodes[0].ref;
    expect(watchTarget(snapshot.snapshot_id, ref, document)).toEqual({
      url: document.location.href,
      pageTitle: 'Shop',
      selector: '#price',
      value: 'Price: 4,499 rupees',
      name: 'Price: 4,499 rupees',
    });
  });

  it('reads a field by its value', () => {
    page('<input id="qty" value="2">');
    expect(valueOf(document.getElementById('qty')!)).toBe('2');
  });

  it('never watches or reads a sensitive field', () => {
    const snapshot = page(
      '<label>Password <input id="pw" type="password" value="hunter2"></label>',
    );
    const ref = snapshot.nodes.find((node) => node.sensitive)!.ref;
    expect(() => watchTarget(snapshot.snapshot_id, ref, document)).toThrow('sensitive_field');
    expect(readWatched('#pw', document)).toBeNull();
  });

  it('reads null for a missing element or a broken selector', () => {
    page('<p>Text</p>');
    expect(readWatched('#gone', document)).toBeNull();
    expect(readWatched('p:::', document)).toBeNull();
  });
});

describe('PageWatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function flush(): Promise<void> {
    // Mutation records are delivered as a microtask; the check runs after the settle time.
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
  }

  it('reports a value that changed while the page was away', async () => {
    page('<p id="price">3,999 rupees</p>');
    const report = vi.fn();
    const watcher = new PageWatcher(
      { loadWatches: async () => [watchOn('#price', '4,499 rupees')], report },
      document,
    );
    await watcher.refresh();
    expect(report).toHaveBeenCalledExactlyOnceWith('w1', '3,999 rupees');
    watcher.stop();
  });

  it('reports each change of the page once', async () => {
    page('<p id="price">4,499 rupees</p>');
    const report = vi.fn();
    const watcher = new PageWatcher(
      { loadWatches: async () => [watchOn('#price', '4,499 rupees')], report },
      document,
    );
    await watcher.refresh();
    expect(report).not.toHaveBeenCalled();

    document.getElementById('price')!.textContent = '4,299 rupees';
    await flush();
    expect(report).toHaveBeenCalledExactlyOnceWith('w1', '4,299 rupees');

    document.body.append(document.createElement('div'));
    await flush();
    expect(report).toHaveBeenCalledOnce();
    watcher.stop();
  });

  it('ignores watches that belong to other pages', async () => {
    page('<p id="price">3,999 rupees</p>');
    const report = vi.fn();
    const elsewhere = watchOn('#price', '4,499 rupees', { url: 'https://other.test/' });
    const watcher = new PageWatcher({ loadWatches: async () => [elsewhere], report }, document);
    await watcher.refresh();
    document.getElementById('price')!.textContent = '1 rupee';
    await flush();
    expect(report).not.toHaveBeenCalled();
  });

  it('stops watching the page once its watches are gone', async () => {
    page('<p id="price">4,499 rupees</p>');
    const report = vi.fn();
    let watches = [watchOn('#price', '4,499 rupees')];
    const watcher = new PageWatcher({ loadWatches: async () => watches, report }, document);
    await watcher.refresh();
    watches = [];
    await watcher.refresh();
    document.getElementById('price')!.textContent = '1 rupee';
    await flush();
    expect(report).not.toHaveBeenCalled();
  });
});
