// Phase 5: page watching, through the real extension and the real backend (with the mock
// model, which picks the element to watch by keyword).

import { ask, demoUrl, expect, of, recordedPanel, test } from './fixtures';

const WATCHING =
  'I am watching the price. Right now it says: Price: 4,499 rupees. ' +
  'I will tell you when it goes down. This works for as long as the page stays open in a tab.';

test('a watch announces a change on the page, and can be listed and cancelled', async ({
  context,
  openPanel,
}) => {
  const shop = await context.newPage();
  await shop.goto(demoUrl('shop.html'));
  const { panel, sent, received } = await recordedPanel(openPanel);

  expect((await ask(panel, 'tell me when the price drops')).join(' ')).toBe(WATCHING);
  expect(of(received, 'tool_call')[0]).toMatchObject({ name: 'set_watch' });
  expect(of(sent, 'tool_result')[0]).toMatchObject({
    ok: true,
    result: { action: 'set_watch', watches: [{ label: 'the price', condition: 'goes down' }] },
  });

  // A rise does not meet the condition; a fall does.
  await shop.evaluate(() => {
    document.getElementById('price')!.textContent = 'Price: 4,999 rupees';
  });
  await shop.waitForTimeout(1200);
  await expect(panel.locator('#log li')).not.toContainText(['The price changed.']);

  const before = sent.length;
  await shop.evaluate(() => {
    document.getElementById('price')!.textContent = 'Price: 3,999 rupees';
  });
  await expect(panel.locator('#log li[data-role="assistant"]').last()).toHaveText(
    'The price changed. It now says: Price: 3,999 rupees.',
  );
  // The alert came from the extension alone: nothing went to the backend.
  expect(sent.length).toBe(before);

  expect((await ask(panel, 'what are you watching?')).join(' ')).toBe(
    'I am watching one thing. the price on Trail Backpack 30L - Riverside Outfitters. ' +
      'It says: Price: 3,999 rupees. I will tell you when it goes down.',
  );
  expect(await ask(panel, 'stop watching the price')).toEqual([
    'I have stopped watching the price.',
  ]);
  expect(await ask(panel, 'what are you watching?')).toEqual([
    'I am not watching anything at the moment.',
  ]);
});

test('a watched tab in the background is reloaded on the alarm and its change announced', async ({
  context,
  openPanel,
}) => {
  const shop = await context.newPage();
  await shop.goto(demoUrl('shop.html'));
  const panel = await openPanel();
  await ask(panel, 'tell me when the price changes');

  // The shop changes its price; the open copy of the page does not show it until reloaded.
  await shop.evaluate(() => localStorage.setItem('demo-price', '4,199'));
  const [worker] = context.serviceWorkers();
  await worker.evaluate(() => chrome.alarms.create('assista-watches', { when: Date.now() }));

  await expect(panel.locator('#log li[data-role="assistant"]').last()).toHaveText(
    'The price changed. It now says: Price: 4,199 rupees.',
    { timeout: 15_000 },
  );
  await expect(shop.locator('#price')).toHaveText('Price: 4,199 rupees');
});

test('a private field is never watched', async ({ context, openPanel }) => {
  const shop = await context.newPage();
  await shop.goto(demoUrl('shop.html'));
  const panel = await openPanel();
  const reply = await panel.evaluate(async () => {
    const snapshot = await chrome.runtime.sendMessage({ to: 'worker', kind: 'get_snapshot' });
    const password = snapshot.snapshot.nodes.find((node: { sensitive?: boolean }) => node.sensitive);
    return chrome.runtime.sendMessage({
      to: 'worker',
      kind: 'run_tool',
      tool: {
        name: 'set_watch',
        snapshotId: snapshot.snapshot.snapshot_id,
        ref: password.ref,
        args: { condition: 'changes', label: 'the password' },
      },
    });
  });
  expect(reply).toEqual({ ok: false, error: 'sensitive_field' });
});

test('a session timer warns at two minutes and at thirty seconds', async ({
  context,
  openPanel,
}) => {
  const booking = await context.newPage();
  await booking.goto(demoUrl('booking.html'));
  const { panel, sent } = await recordedPanel(openPanel);
  const alerts = panel.locator('#log li[data-role="assistant"]');

  // Five minutes are left: no warning yet.
  await booking.waitForTimeout(2500);
  await expect(alerts).toHaveCount(0);

  // The page's own timer is moved on, so the test need not wait three minutes.
  await booking.evaluate('left = 122');
  await expect(alerts.last()).toHaveText(
    'Heads up: the timer on Book a table - Saffron Kitchen has about 2 minutes left.',
    { timeout: 15_000 },
  );
  await booking.evaluate('left = 32');
  await expect(alerts.last()).toHaveText(
    'The timer on Book a table - Saffron Kitchen has 30 seconds left.',
    { timeout: 15_000 },
  );
  await expect(alerts).toHaveCount(2);
  // Warnings come from the extension alone.
  expect(of(sent, 'transcript')).toHaveLength(0);
});
