// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildSnapshot } from './snapshot';

const PROSE = `<p>${'A long and well described page about walking boots. '.repeat(6)}</p>`;

function thin(html: string): boolean {
  document.body.innerHTML = html;
  return buildSnapshot(document).flags.thin;
}

describe('flags.thin', () => {
  it('is false for a well described page', () => {
    expect(
      thin(`<h1>Boots</h1>${PROSE}<img src="b.jpg" alt="Brown boots"><button>Buy</button>`),
    ).toBe(false);
  });

  it('is false for plain text without pictures, however short', () => {
    expect(thin('<p>Hello</p>')).toBe(false);
  });

  it('is true when images lack alt text', () => {
    expect(thin(`${PROSE}<img src="a.jpg" width="300" height="200">`)).toBe(true);
  });

  it('ignores decorative images and one stray image among described ones', () => {
    expect(thin(`${PROSE}<img src="line.png" alt="">`)).toBe(false);
    expect(
      thin(`${PROSE}<img src="a.jpg" alt="Boots"><img src="b.jpg" alt="Laces"><img src="c.jpg">`),
    ).toBe(false);
  });

  it('is true when the page has a canvas or a chart', () => {
    expect(thin(`${PROSE}<canvas></canvas>`)).toBe(true);
    expect(thin(`${PROSE}<div class="sales-chart"></div>`)).toBe(true);
    expect(thin(`${PROSE}<svg role="img" aria-label="Sales"></svg>`)).toBe(true);
  });

  it('is true when buttons are unlabeled', () => {
    expect(thin(`${PROSE}<button></button><button></button><button>Buy</button>`)).toBe(true);
    expect(thin(`${PROSE}<div role="button"></div><button>Buy</button>`)).toBe(true);
  });

  it('is true when a screen of pictures holds very little text', () => {
    expect(thin('<p>Welcome</p><img src="hero.jpg" alt="Sunset">')).toBe(true);
    expect(thin('<div style="background-image:url(hero.jpg)">Welcome</div>')).toBe(true);
  });
});
