// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { endCapture, maskSensitiveFields, prepareCapture } from './capture';
import { StaleRefError, buildSnapshot } from './snapshot';

const FORM = `
  <label>Email <input id="email" value="asha@example.com"></label>
  <label>Password <input id="password" type="password" value="hunter2"></label>
  <label>Card number <input id="card" value="4111111111111111"></label>
  <img id="bag" src="bag.png" alt="Bag" width="200" height="100">`;

function masks(): Element[] {
  return Array.from(document.querySelectorAll('[data-assista-mask]'));
}

beforeAll(() => {
  // jsdom has no layout, so it lacks scrolling.
  Element.prototype.scrollIntoView = () => undefined;
});

describe('maskSensitiveFields', () => {
  it('covers sensitive fields only, outside the snapshot, until the capture ends', () => {
    document.body.innerHTML = FORM;
    expect(maskSensitiveFields()).toBe(2);
    expect(masks()).toHaveLength(2);
    for (const mask of masks()) {
      expect(mask.parentElement).toBe(document.documentElement);
      expect((mask as HTMLElement).style.background).toMatch(/#000|rgb\(0, 0, 0\)/);
    }
    // Masks never show up in a snapshot taken meanwhile.
    expect(JSON.stringify(buildSnapshot(document))).not.toContain('mask');
    endCapture();
    expect(masks()).toHaveLength(0);
  });

  it('does not stack masks when called twice', () => {
    document.body.innerHTML = FORM;
    maskSensitiveFields();
    maskSensitiveFields();
    expect(masks()).toHaveLength(2);
    endCapture();
  });
});

describe('prepareCapture', () => {
  it('brings the element into view and reports where it is', async () => {
    document.body.innerHTML = FORM;
    buildSnapshot(document);
    const img = document.getElementById('bag')!;
    const scroll = vi.spyOn(img, 'scrollIntoView');
    vi.spyOn(img, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 200, 100));

    const frame = await prepareCapture('i1');
    expect(scroll).toHaveBeenCalledWith({ block: 'center', inline: 'center' });
    expect(frame.rect).toEqual({ x: 10, y: 20, width: 200, height: 100 });
    expect(frame.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight });
    expect(masks()).toHaveLength(2);
    endCapture();
  });

  it('captures the full view without a ref', async () => {
    document.body.innerHTML = FORM;
    const frame = await prepareCapture();
    expect(frame.rect).toBeNull();
    endCapture();
  });

  it('rejects a ref that is not in the latest snapshot', async () => {
    document.body.innerHTML = FORM;
    buildSnapshot(document);
    await expect(prepareCapture('i9')).rejects.toBeInstanceOf(StaleRefError);
  });
});
