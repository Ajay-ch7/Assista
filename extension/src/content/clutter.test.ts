// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { PageSnapshot } from '../shared/snapshot';
import { isAd, isCookieBanner } from './clutter';
import { buildSnapshot } from './snapshot';

function snapshotOf(html: string): PageSnapshot {
  document.body.innerHTML = html;
  return buildSnapshot(document);
}

function first(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
}

describe('isAd', () => {
  it.each([
    ['an AdSense slot', '<ins class="adsbygoogle"></ins>'],
    ['an ad data attribute', '<div data-ad-slot="123"></div>'],
    ['an ad class', '<div class="sidebar-ad">Buy now</div>'],
    ['a camel-case ad id', '<div id="topAdSlot">Buy now</div>'],
    ['a sponsored block', '<section class="sponsored">Buy now</section>'],
    ['an advertisement label', '<aside aria-label="Advertisement">Buy now</aside>'],
  ])('finds %s', (_name, html) => {
    expect(isAd(first(html))).toBe(true);
  });

  it.each([
    ['a word that merely contains "ad"', '<div class="header address badge">Hi</div>'],
    ['an "add" button', '<button class="add-to-cart">Add</button>'],
    [
      'a wrapper that holds the page',
      '<div class="page-with-ads"><main><h1>News</h1></main></div>',
    ],
    ['the main content itself', '<main class="ad">Article</main>'],
  ])('leaves %s alone', (_name, html) => {
    expect(isAd(first(html))).toBe(false);
  });
});

describe('isCookieBanner', () => {
  it('finds a consent block by its name and text', () => {
    expect(isCookieBanner(first('<div id="cookie-consent">We use cookies.</div>'))).toBe(true);
  });

  it('finds an unnamed cookie dialog with an accept button', () => {
    const banner = first(
      '<div role="dialog"><p>This site uses cookies.</p><button>Accept all</button></div>',
    );
    expect(isCookieBanner(banner)).toBe(true);
  });

  it('finds a pinned cookie bar with an accept button', () => {
    const banner = first(
      '<div style="position:fixed; bottom:0">Cookies help us. <a href="#">Got it</a></div>',
    );
    expect(isCookieBanner(banner)).toBe(true);
  });

  it('leaves a page about cookies and an ordinary dialog alone', () => {
    expect(isCookieBanner(first('<main class="cookie-policy">We use cookies.</main>'))).toBe(false);
    expect(isCookieBanner(first('<div class="cookie-recipes">Chocolate chip</div>'))).toBe(false);
    expect(
      isCookieBanner(first('<div role="dialog"><p>Your cart</p><button>OK</button></div>')),
    ).toBe(false);
    const long = `<div class="consent">${'We use cookies. '.repeat(200)}</div>`;
    expect(isCookieBanner(first(long))).toBe(false);
  });
});

describe('buildSnapshot: clutter skipping', () => {
  it('drops ads, cookie banners and repeated navigation, and counts them', () => {
    const snapshot = snapshotOf(`
      <div id="cookie-banner" role="dialog">
        <p>We use cookies to improve your visit.</p><button>Accept</button>
      </div>
      <header>
        <nav aria-label="Main">
          <a href="/news">News</a><a href="/sport">Sport</a><a href="/weather">Weather</a>
        </nav>
      </header>
      <div class="ad-banner"><a href="https://ads.example">Cheap flights!</a></div>
      <main>
        <h1>River levels rise</h1>
        <p>The river rose two metres overnight.</p>
        <ins class="adsbygoogle"><img src="ad.png" alt="Win a car" width="300" height="250"></ins>
      </main>
      <footer>
        <nav aria-label="Footer">
          <a href="/news">News</a><a href="/sport">Sport</a><a href="/weather">Weather</a>
        </nav>
        <nav aria-label="Legal"><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
      </footer>`);

    const text = JSON.stringify(snapshot);
    for (const clutter of ['cookies', 'Accept', 'Cheap flights', 'Win a car', 'Footer']) {
      expect(text).not.toContain(clutter);
    }
    expect(snapshot.flags.clutter_removed).toBe(4);
    expect(snapshot.images).toEqual([]);
    expect(snapshot.nodes.filter((n) => n.role === 'navigation').map((n) => n.name)).toEqual([
      'Main',
      'Legal',
    ]);
    expect(snapshot.nodes.filter((n) => n.role === 'link').map((n) => n.name)).toEqual([
      'News',
      'Sport',
      'Weather',
      'Privacy',
      'Terms',
    ]);
    expect(text).toContain('The river rose two metres overnight.');
  });

  it('keeps a short navigation block even when its links appeared before', () => {
    const snapshot = snapshotOf(`
      <nav aria-label="Main"><a href="/a">Home</a><a href="/b">Help</a></nav>
      <nav aria-label="Footer"><a href="/a">Home</a><a href="/b">Help</a></nav>`);
    expect(snapshot.flags.clutter_removed).toBe(0);
    expect(snapshot.nodes.filter((n) => n.role === 'navigation')).toHaveLength(2);
  });

  it('keeps navigation that only shares a few links with an earlier one', () => {
    const snapshot = snapshotOf(`
      <nav aria-label="Main"><a href="/a">Home</a><a href="/b">Shop</a><a href="/c">Help</a></nav>
      <nav aria-label="Shop">
        <a href="/b">Shop</a><a href="/d">Tents</a><a href="/e">Boots</a><a href="/f">Packs</a>
      </nav>`);
    expect(snapshot.flags.clutter_removed).toBe(0);
  });
});
