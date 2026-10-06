// Phase 5: saved details (F20), through the real extension and the real backend (with the
// mock model). Details the user dictates are kept on the device and offered on later forms.

import { ask, demoUrl, expect, of, recordedPanel, test } from './fixtures';

const saved = (panel: import('@playwright/test').Page) =>
  panel.evaluate(async () => (await chrome.storage.local.get('savedDetails')).savedDetails);

test('a dictated detail is saved on the device, offered on the next form, and can be forgotten', async ({
  context,
  openPanel,
}) => {
  const form = await context.newPage();
  await form.goto(demoUrl('form.html'));
  const { panel, sent, received } = await recordedPanel(openPanel);

  // Dictating a name saves it; nothing else on the form is saved.
  await ask(panel, 'type Asha Rao into the full name field');
  await expect.poll(() => saved(panel)).toEqual({ name: 'Asha Rao' });

  // A fresh copy of the form: the saved name is offered, not asked for.
  await form.reload();
  expect(await ask(panel, 'fill in the form')).toEqual([
    'I have your saved Full name.',
    'Shall I use it?',
  ]);
  const snapshots = of(sent, 'snapshot');
  expect(JSON.stringify(snapshots.at(-1))).toContain('"saved":true');
  expect(JSON.stringify(snapshots.at(-1))).not.toContain('Asha Rao');

  // Yes fills it from the device: the backend's tool call carries no value.
  expect(await ask(panel, 'yes')).toEqual(['What should I put for Phone?']);
  await expect(form.locator('#name')).toHaveValue('Asha Rao');
  expect(of(received, 'tool_call').at(-1)).toMatchObject({ name: 'type', args: { use_saved: true } });
  expect(of(received, 'tool_call').at(-1)!.args).not.toHaveProperty('text');

  // The phone number is dictated, so it is saved too.
  await ask(panel, '98450 12345');
  await expect.poll(() => saved(panel)).toEqual({ name: 'Asha Rao', phone: '98450 12345' });

  // "Forget my details" is handled on the device and clears them.
  const before = sent.length;
  await panel.locator('#text-input').fill('Forget my details');
  await panel.locator('#text-input').press('Enter');
  await expect(panel.locator('#log li[data-role="assistant"]').last()).toHaveText(
    'I have forgotten your saved details.',
  );
  expect(sent.length).toBe(before);
  await expect.poll(() => saved(panel)).toBeUndefined();

  await form.reload();
  expect(await ask(panel, 'fill in the form')).toEqual(['What should I put for Full name?']);
});

test('a private field is never saved', async ({ context, openPanel }) => {
  const form = await context.newPage();
  await form.goto(demoUrl('form.html'));
  const panel = await openPanel();

  // The assistant is asked to type into the one-time code field: it types nothing.
  await ask(panel, 'type 493817 into the one-time code field');
  await expect(form.locator('#otp')).toHaveValue('');
  await ask(panel, 'type Pune into the city field');
  await expect.poll(() => saved(panel)).toEqual({ city: 'Pune' });
});
