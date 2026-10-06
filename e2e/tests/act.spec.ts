// Phase 3: acting safely, through the real extension and the real backend (with the mock
// model, which turns plainly worded requests into tool calls by keyword).

import type { Page } from '@playwright/test';
import { ask, demoUrl, expect, test } from './fixtures';

interface Frame {
  type: string;
  [key: string]: unknown;
}

/** Opens the panel and records every text frame it sends and receives, raw and parsed. */
async function recordedPanel(openPanel: () => Promise<Page>) {
  const panel = await openPanel();
  const sent: Frame[] = [];
  const received: Frame[] = [];
  const raw: string[] = [];
  panel.on('websocket', (ws) => {
    ws.on('framesent', (frame) => {
      if (typeof frame.payload !== 'string') return;
      raw.push(frame.payload);
      sent.push(JSON.parse(frame.payload));
    });
    ws.on('framereceived', (frame) => {
      if (typeof frame.payload !== 'string') return;
      raw.push(frame.payload);
      received.push(JSON.parse(frame.payload));
    });
  });
  // Reload so the WebSocket is opened after the recorders are attached.
  await panel.reload();
  await expect(panel.locator('#status')).toHaveAttribute('data-connection', 'open');
  return { panel, sent, received, raw };
}

const of = (frames: Frame[], type: string) => frames.filter((frame) => frame.type === type);
const lastReply = (panel: Page) => panel.locator('#log li[data-role="assistant"]').last();

test('voice navigation: a spoken command presses a button, and the log remembers it', async ({
  context,
  openPanel,
}) => {
  const shop = await context.newPage();
  await shop.goto(demoUrl('shop.html'));
  const { panel, sent, received } = await recordedPanel(openPanel);

  const speech = await ask(panel, 'press add to cart');

  await expect(shop.locator('#cart-link')).toHaveText('Cart (1)');
  expect(speech).toContain('I pressed Add to cart.');
  const [call] = of(received, 'tool_call');
  expect(call).toMatchObject({ name: 'click' });
  expect(of(sent, 'tool_result')[0]).toMatchObject({
    call_id: call.call_id,
    ok: true,
    result: { action: 'click', target: { role: 'button', name: 'Add to cart' } },
  });

  // The action log is read from the device; the question never reaches the backend.
  const before = sent.length;
  await panel.locator('#text-input').fill('What did you do?');
  await panel.locator('#text-input').press('Enter');
  await expect(lastReply(panel)).toHaveText('I did one thing. I pressed Add to cart.');
  expect(sent.length).toBe(before);
});

test('voice navigation: scrolling, typing into a field and choosing an option', async ({
  context,
  openPanel,
}) => {
  const form = await context.newPage();
  await form.goto(demoUrl('form.html'));
  const panel = await openPanel();

  expect(await ask(panel, 'type Pune into the city field')).toContain('I typed Pune into City.');
  await expect(form.locator('#city')).toHaveValue('Pune');

  expect(await ask(panel, 'choose express for delivery speed')).toContain(
    'I chose Express for Delivery speed.',
  );
  await expect(form.locator('#speed')).toHaveValue('Express');

  expect(await ask(panel, 'scroll down')).toContain('Done.');
});

test('the gate holds a risky press, and no leaves the page untouched', async ({
  context,
  openPanel,
}) => {
  const form = await context.newPage();
  await form.goto(demoUrl('form.html'));
  const { panel, sent, received } = await recordedPanel(openPanel);

  const readBack = await ask(panel, 'place the order');

  expect(readBack[0]).toBe('I am about to press Place order.');
  expect(readBack.at(-1)).toBe('Shall I go ahead?');
  expect(of(sent, 'tool_result')[0]).toMatchObject({
    ok: false,
    held_by_gate: true,
    result: { control: 'Place order', reason: 'risky_control' },
  });
  expect(of(received, 'confirm_request')).toHaveLength(1);
  await expect(form).toHaveTitle('Delivery details - Riverside Outfitters');

  expect(await ask(panel, 'no')).toEqual(['Okay.', 'I have not pressed Place order.']);
  expect(of(sent, 'confirm')[0]).toMatchObject({ approved: false });
  await expect(form).toHaveTitle('Delivery details - Riverside Outfitters');

  // The hold is over: a later yes is not a release.
  await ask(panel, 'yes');
  await expect(form).toHaveTitle('Delivery details - Riverside Outfitters');
  expect(of(sent, 'confirm')).toHaveLength(1);
});

test('exit check: the form is filled and submitted by voice, behind the gate, with no secret sent', async ({
  context,
  openPanel,
}) => {
  const SECRET = '493817';
  const form = await context.newPage();
  await form.goto(demoUrl('form.html'));
  const { panel, sent, received, raw } = await recordedPanel(openPanel);

  // One field at a time.
  expect(await ask(panel, 'fill in the form')).toEqual(['What should I put for Full name?']);
  expect(await ask(panel, 'Asha Rao')).toEqual(['What should I put for Phone?']);
  await expect(form.locator('#name')).toHaveValue('Asha Rao');
  expect(await ask(panel, '98450 12345')).toEqual(['What should I put for City?']);

  // The next field is private: focus moves there, and the assistant types nothing.
  const handOver = await ask(panel, 'Pune');
  expect(handOver.at(-1)).toBe('Type it on your keyboard, then say continue.');
  await expect(form.locator('#city')).toHaveValue('Pune');
  await expect(form.locator('#otp')).toBeFocused();
  await expect(form.locator('#otp')).toHaveValue('');

  // The user types the code themselves.
  await form.bringToFront();
  await form.keyboard.type(SECRET);
  await expect(form.locator('#otp')).toHaveValue(SECRET);

  // Submitting is held, and everything is read back first.
  const readBack = await ask(panel, 'continue');
  expect(readBack).toEqual([
    'I am about to press Place order.',
    'Order total: 4,598 rupees.',
    'Full name is Asha Rao.',
    'Phone is 98450 12345.',
    'City is Pune.',
    'Delivery speed is Standard.',
    'One-time code is entered.',
    'Shall I go ahead?',
  ]);
  expect(of(sent, 'tool_result').at(-1)).toMatchObject({ ok: false, held_by_gate: true });
  expect(of(received, 'confirm_request')).toHaveLength(1);
  await expect(form).toHaveTitle('Delivery details - Riverside Outfitters');

  // Yes releases it, in the extension.
  const outcome = await ask(panel, 'yes');
  await expect(form).toHaveTitle('Order placed - Riverside Outfitters');
  await expect(form.locator('h1')).toHaveText('Thank you, Asha Rao');
  expect(outcome).toEqual([
    'Done.',
    'I pressed Place order.',
    'This page is titled Order placed - Riverside Outfitters.',
    'Its main heading is Thank you, Asha Rao.',
  ]);
  expect(of(sent, 'confirm')).toEqual([expect.objectContaining({ approved: true })]);
  // The backend never asked for the press a second time: one click call, held, then released.
  expect(of(received, 'tool_call').filter((call) => call.name === 'click')).toHaveLength(1);

  // No sensitive value appears in any message, in either direction.
  expect(raw.length).toBeGreaterThan(30);
  for (const frame of raw) expect(frame).not.toContain(SECRET);
  const typed = of(received, 'tool_call').filter((call) => call.name === 'type');
  expect(typed.map((call) => (call.args as { text: string }).text)).toEqual([
    'Asha Rao',
    '98450 12345',
    'Pune',
    '',
  ]);

  // The log tells the whole story, from the device.
  await panel.locator('#text-input').fill('what did you do?');
  await panel.locator('#text-input').press('Enter');
  await expect(lastReply(panel)).toHaveText(
    'Here are my last 5 actions. I typed 98450 12345 into Phone. I typed Pune into City. ' +
      'I moved to One-time code for you to type. ' +
      'I stopped before pressing Place order and asked you first. ' +
      'I pressed Place order after you said yes.',
  );
});
