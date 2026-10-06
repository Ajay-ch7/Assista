// Phase 2: understanding pages, through the real extension and the real backend (with the
// mock model, which routes by keyword and describes pictures by their alt text).

import { ask, demoUrl, expect, of, recordedPanel, test } from './fixtures';

const SITES = [
  ['shop.html', 'This page is titled Trail Backpack 30L - Riverside Outfitters.'],
  ['news.html', 'This page is titled River levels rise after record rain - The Valley Gazette.'],
  ['library.html', 'This page is titled Opening hours - Lakeside Public Library.'],
  ['booking.html', 'This page is titled Book a table - Saffron Kitchen.'],
  ['checkout.html', 'This page is titled Checkout - Riverside Outfitters.'],
  ['terms.html', 'This page is titled Terms of membership - StreamBox.'],
  ['instructions.html', 'This page is titled Best rain jackets of 2026 - Gear Notes.'],
] as const;

for (const [site, first] of SITES) {
  test(`orientation on ${site}`, async ({ context, openPanel }) => {
    const page = await context.newPage();
    await page.goto(demoUrl(site));
    const { panel, received } = await recordedPanel(openPanel);
    const speech = await ask(panel, 'where am I?');
    expect(speech[0]).toBe(first);
    expect(of(received, 'request_screenshot')).toEqual([]);
  });
}

test('orientation on a page with poor markup uses a screenshot', async ({ context, openPanel }) => {
  const gallery = await context.newPage();
  await gallery.goto(demoUrl('gallery.html'));
  const { panel, sent } = await recordedPanel(openPanel);
  // Chrome can capture only the tab on show.
  await gallery.bringToFront();

  const speech = await ask(panel, 'where am I?');

  const snapshot = of(sent, 'snapshot')[0].snapshot as { flags: { thin: boolean } };
  expect(snapshot.flags.thin).toBe(true);
  const [shot] = of(sent, 'screenshot');
  expect(shot).toMatchObject({ mime: 'image/jpeg' });
  expect((shot.image as string).length).toBeGreaterThan(1000);
  expect(speech[0]).toBe('From the screenshot: This page is titled Nila Studio.');
});

test('clutter is left out of the snapshot and mentioned', async ({ context, openPanel }) => {
  const news = await context.newPage();
  await news.goto(demoUrl('news.html'));
  const { panel, sent } = await recordedPanel(openPanel);

  const speech = await ask(panel, 'where am I?');

  const raw = JSON.stringify(of(sent, 'snapshot'));
  for (const clutter of ['Cheap flights', 'raincoats', 'Win a new car', 'Accept all cookies']) {
    expect(raw).not.toContain(clutter);
  }
  expect(raw).toContain('The Kaveri rose by two metres overnight');
  expect(speech.at(-1)).toBe('I skipped 5 ads, banners or repeated menus.');
});

test('an image is described, and a follow-up needs no new picture', async ({
  context,
  openPanel,
}) => {
  const shop = await context.newPage();
  await shop.goto(demoUrl('shop.html'));
  await shop.locator('#password').fill('hunter2-secret');
  const { panel, sent, received } = await recordedPanel(openPanel);
  await shop.bringToFront();

  const described = await ask(panel, 'describe the product photo');
  expect(described).toEqual([
    'I looked at a picture: A green 30 litre backpack with a front pocket.',
  ]);
  expect(of(received, 'request_screenshot')).toEqual([expect.objectContaining({ ref: 'i1' })]);
  const [shot] = of(sent, 'screenshot');
  expect(shot).toMatchObject({ ref: 'i1', mime: 'image/jpeg' });
  expect((shot.image as string).length).toBeGreaterThan(1000);
  // The masks over sensitive fields are gone once the picture is taken.
  await expect(shop.locator('[data-assista-mask]')).toHaveCount(0);

  const followUp = await ask(panel, 'is it waterproof?');
  expect(followUp).toEqual([
    'Looking again at the picture I described: A green 30 litre backpack with a front pocket.',
  ]);
  expect(of(received, 'request_screenshot')).toHaveLength(1);
});

test('a page in a background tab cannot be looked at, and the user hears why', async ({
  context,
  openPanel,
}) => {
  const shop = await context.newPage();
  await shop.goto(demoUrl('shop.html'));
  const panel = await openPanel();
  const speech = await ask(panel, 'describe the product photo');
  expect(speech.join(' ')).toContain('I can only look at the tab that is on screen.');
});

test('local commands stay in the extension', async ({ context, openPanel }) => {
  const shop = await context.newPage();
  await shop.goto(demoUrl('shop.html'));
  const { panel, sent } = await recordedPanel(openPanel);

  await ask(panel, 'where am I?');
  const transcripts = () => of(sent, 'transcript').length;
  expect(transcripts()).toBe(1);

  expect(await ask(panel, 'Be brief.')).toEqual(['I will keep my answers brief.']);
  await expect.poll(() => of(sent, 'settings').at(-1)?.verbosity).toBe('brief');

  expect(await ask(panel, 'slower please')).toEqual(['Slower.']);
  const stored = await panel.evaluate(() => chrome.storage.local.get('preferences'));
  expect(stored.preferences).toEqual({
    verbosity: 'brief',
    speed: 0.75,
    privateMode: false,
  });

  expect(await ask(panel, 'spell Kaveri')).toEqual(['capital K, A, V, E, R, I']);
  await ask(panel, 'repeat that');
  expect(transcripts()).toBe(1);
});
