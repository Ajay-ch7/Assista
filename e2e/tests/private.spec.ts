// Phase 5: private mode (F19) and its on-device model, through the real extension. The
// test browser has no built-in model, so one test gives the panel a stand-in for Chrome's
// Prompt API, and the other checks the fallback to the online model.

import { ask, demoUrl, expect, of, recordedPanel, test } from './fixtures';

const lastReply = (panel: import('@playwright/test').Page) =>
  panel.locator('#log li[data-role="assistant"]').last();

async function say(panel: import('@playwright/test').Page, text: string) {
  await panel.locator('#text-input').fill(text);
  await panel.locator('#text-input').press('Enter');
}

test('without an on-device model, private mode keeps the online model but sends no pictures', async ({
  context,
  openPanel,
}) => {
  const shop = await context.newPage();
  await shop.goto(demoUrl('shop.html'));
  const { panel, sent, received } = await recordedPanel(openPanel);

  await say(panel, 'Private mode on');
  await expect(lastReply(panel)).toContainText('This device has no built-in model');
  await expect.poll(() => of(sent, 'settings').at(-1)).toMatchObject({ private_mode: true });

  // Reading still works, through the backend; looking at the screen is refused.
  expect((await ask(panel, 'what is this page?'))[0]).toContain('This page is titled');
  const look = await ask(panel, 'describe the photo');
  expect(look.join(' ')).toContain("Private mode is on, so I won't send a picture of your screen");
  expect(of(received, 'request_screenshot')).toHaveLength(0);

  await say(panel, 'Private mode off');
  await expect(lastReply(panel)).toHaveText('Private mode is off.');
  await expect.poll(() => of(sent, 'settings').at(-1)).toMatchObject({ private_mode: false });
});

test('with an on-device model, a question is answered on the device and nothing is sent', async ({
  context,
  openPanel,
}) => {
  // A stand-in for Chrome's built-in model: it echoes what it was asked and shown.
  await context.addInitScript(() => {
    (globalThis as Record<string, unknown>).LanguageModel = {
      availability: async () => 'available',
      create: async () => ({
        prompt: async (text: string) => {
          const question = text.split("The user's spoken request: ")[1];
          const title = /Page title: (.*)/.exec(text)?.[1];
          return `On-device answer to "${question}" about ${title}.`;
        },
        destroy: () => undefined,
      }),
    };
  });
  const shop = await context.newPage();
  await shop.goto(demoUrl('shop.html'));
  const { panel, sent } = await recordedPanel(openPanel);

  await say(panel, 'private mode on');
  await expect(lastReply(panel)).toContainText('I will answer from this device');

  const before = sent.length;
  await say(panel, 'how much is the backpack?');
  await expect(lastReply(panel)).toHaveText(
    'On-device answer to "how much is the backpack?" about Trail Backpack 30L - Riverside Outfitters.',
  );
  // No transcript, no snapshot: the question and the page stayed on the device.
  expect(sent.slice(before)).toEqual([]);
});
