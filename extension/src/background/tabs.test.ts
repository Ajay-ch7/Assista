import { describe, expect, it } from 'vitest';
import { pickTargetTab } from './tabs';

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
