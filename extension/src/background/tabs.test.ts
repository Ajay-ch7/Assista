import { describe, expect, it } from 'vitest';
import { findTab, normalizeUrl, pickTargetTab } from './tabs';

const ORIGIN = 'chrome-extension://abc/';

describe('pickTargetTab', () => {
  it('prefers the active tab of the focused window', () => {
    const active = { id: 1, url: 'https://shop.test/', lastAccessed: 5 };
    const other = { id: 2, url: 'https://news.test/', lastAccessed: 9 };
    expect(pickTargetTab([active], [active, other], ORIGIN)).toBe(active);
  });

  it("skips Assista's own pages and takes the most recently used tab", () => {
    const panel = { id: 1, url: `${ORIGIN}src/panel/index.html`, lastAccessed: 9 };
    const older = { id: 2, url: 'https://news.test/', lastAccessed: 3 };
    const newer = { id: 3, url: 'https://shop.test/', lastAccessed: 7 };
    expect(pickTargetTab([panel], [panel, older, newer], ORIGIN)).toBe(newer);
  });

  it('returns undefined when no tab can be used', () => {
    expect(pickTargetTab([], [{ url: 'https://no-id.test/' }], ORIGIN)).toBeUndefined();
  });
});

describe('findTab', () => {
  const panel = { id: 1, url: `${ORIGIN}src/panel/index.html`, title: 'Assista' };
  const shop = { id: 2, url: 'https://shop.test/bag', title: 'Trail Backpack - Riverside' };
  const news = { id: 3, url: 'https://gazette.test/rain', title: 'River levels rise' };
  const tabs = [panel, shop, news];

  it('matches a tab by part of its title, whatever the case', () => {
    expect(findTab(tabs, { query: 'river levels' }, ORIGIN)).toBe(news);
    expect(findTab(tabs, { query: 'BACKPACK' }, ORIGIN)).toBe(shop);
  });

  it('falls back to the address, and prefers a title match', () => {
    expect(findTab(tabs, { query: 'gazette' }, ORIGIN)).toBe(news);
    expect(findTab(tabs, { query: 'river' }, ORIGIN)).toBe(shop);
  });

  it("counts tabs from one and never picks Assista's own pages", () => {
    expect(findTab(tabs, { index: 1 }, ORIGIN)).toBe(shop);
    expect(findTab(tabs, { index: 2 }, ORIGIN)).toBe(news);
    expect(findTab(tabs, { index: 3 }, ORIGIN)).toBeUndefined();
    expect(findTab(tabs, { query: 'assista' }, ORIGIN)).toBeUndefined();
  });

  it('finds nothing without a query or index', () => {
    expect(findTab(tabs, {}, ORIGIN)).toBeUndefined();
    expect(findTab(tabs, { query: '  ' }, ORIGIN)).toBeUndefined();
  });
});

describe('normalizeUrl', () => {
  it('accepts web addresses and adds https when the scheme is missing', () => {
    expect(normalizeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(normalizeUrl('http://localhost:8787/shop.html')).toBe('http://localhost:8787/shop.html');
    expect(normalizeUrl('  example.com ')).toBe('https://example.com/');
  });

  it.each([
    'javascript:alert(1)',
    'file:///C:/secrets.txt',
    'chrome://settings',
    'data:text/html,<p>hi</p>',
    'the shop',
    '',
    42,
    undefined,
  ])('refuses %s', (input) => {
    expect(normalizeUrl(input)).toBeNull();
  });
});
