// Phase 5 exit check: the full demo script (implementation.md section 9) as one text-mode
// test, through the real extension and the real backend with the mock model.

import { ask, demoUrl, expect, of, recordedPanel, test } from './fixtures';

const SECRET = '493817';

test('the demo script, start to finish', async ({ context, openPanel }) => {
  test.setTimeout(120_000);

  // Before the demo: a watch is set on the shop's price in a tab that stays open, and a
  // booking page with a session timer is left open in another.
  const watched = await context.newPage();
  await watched.goto(demoUrl('shop.html'));
  const { panel, sent, received, raw } = await recordedPanel(openPanel);
  const said = panel.locator('#log li[data-role="assistant"]');
  expect((await ask(panel, 'tell me when the price drops')).join(' ')).toContain(
    'I am watching the price.',
  );
  const booking = await context.newPage();
  await booking.goto(demoUrl('booking.html'));

  // 1. Open the cluttered shopping page and ask "where am I?"
  const tab = await context.newPage();
  await tab.goto(demoUrl('shop.html'));
  expect((await ask(panel, 'where am I?'))[0]).toBe(
    'This page is titled Trail Backpack 30L - Riverside Outfitters.',
  );

  // 2. Ask for a description of a product photo, then a follow-up question about it.
  expect(await ask(panel, 'describe the product photo')).toEqual([
    'I looked at a picture: A green 30 litre backpack with a front pocket.',
  ]);
  expect(await ask(panel, 'is it waterproof?')).toEqual([
    'Looking again at the picture I described: A green 30 litre backpack with a front pocket.',
  ]);
  expect(of(received, 'request_screenshot')).toHaveLength(1);

  // 3. "Add it to the cart and go to checkout."
  const moved = await ask(panel, 'add it to the cart and go to checkout');
  expect(moved).toContain('I pressed Add to cart.');
  expect(moved).toContain('I pressed Checkout.');
  await expect(tab).toHaveURL(demoUrl('checkout.html'));

  // 4. The assistant announces the pre-ticked add-on and the true total.
  const cost = (await ask(panel, 'how much will I pay?')).join(' ');
  expect(cost).toContain('You will pay 4,946 rupees in total.');
  expect(cost).toContain(
    'Watch out: Add Protection Plan for 299 rupees was already ticked when the page opened.',
  );
  expect(cost).toContain('Prices include a convenience fee of 49 rupees.');

  // 5. Fill the address by voice, hear the read-back, confirm at the gate, and type the
  //    one-time code in private mode.
  await ask(panel, 'press continue to delivery');
  await expect(tab).toHaveURL(demoUrl('form.html'));
  expect(await ask(panel, 'fill in the form')).toEqual(['What should I put for Full name?']);
  expect(await ask(panel, 'Asha Rao')).toEqual(['What should I put for Phone?']);
  expect(await ask(panel, '98450 12345')).toEqual(['What should I put for City?']);
  expect((await ask(panel, 'Pune')).at(-1)).toBe('Type it on your keyboard, then say continue.');
  await expect(tab.locator('#otp')).toBeFocused();
  await tab.bringToFront();
  await tab.keyboard.type(SECRET);

  const readBack = await ask(panel, 'continue');
  expect(readBack[0]).toBe('I am about to press Place order.');
  expect(readBack[1]).toBe('I have not pressed it yet.');
  expect(readBack).toContain('Order total: 4,598 rupees.');
  expect(readBack).toContain('Full name is Asha Rao.');
  expect(readBack).toContain('One-time code is entered.');
  expect(readBack.at(-1)).toBe('Shall I go ahead?');
  await expect(tab).toHaveTitle('Delivery details - Riverside Outfitters');

  expect(await ask(panel, 'yes')).toContain('I pressed Place order.');
  await expect(tab).toHaveTitle('Order placed - Riverside Outfitters');
  for (const frame of raw) expect(frame).not.toContain(SECRET);

  // 6. A watch set earlier announces a price change, and the session-timer warning plays.
  await watched.evaluate(() => localStorage.setItem('demo-price', '3,999'));
  const [worker] = context.serviceWorkers();
  await worker.evaluate(() => chrome.alarms.create('assista-watches', { when: Date.now() }));
  await expect(said.last()).toHaveText('The price changed. It now says: Price: 3,999 rupees.', {
    timeout: 15_000,
  });
  await booking.evaluate('left = 122');
  await expect(said.last()).toHaveText(
    'Heads up: the timer on Book a table - Saffron Kitchen has about 2 minutes left.',
    { timeout: 15_000 },
  );

  // 7. Open the page with hidden instructions. The assistant refuses to act on them and
  //    says why.
  await tab.goto(demoUrl('instructions.html'));
  const told = await ask(panel, 'what is this page?');
  expect(told).toContain('The page has instructions aimed at an assistant.');
  expect(told).toContain('I ignored them.');
  const lastSnapshot = of(sent, 'snapshot').at(-1)!.snapshot as {
    flags: { hidden_text_removed: number };
  };
  expect(lastSnapshot.flags.hidden_text_removed).toBe(3);

  // A model that fell for the page is stopped at the gate.
  expect((await ask(panel, 'scroll down'))[0]).toBe(
    'I am about to press Subscribe, but you did not ask for that by name, so I am checking first.',
  );
  expect(await ask(panel, 'no')).toEqual(['Okay.', 'I have not pressed Subscribe.']);
  await expect(tab.locator('#pressed')).toHaveText('');

  // And the action log tells the story of the session from the device.
  await panel.locator('#text-input').fill('what did you do?');
  await panel.locator('#text-input').press('Enter');
  await expect(said.last()).toContainText('You said no, so I did not press Subscribe.');
});
