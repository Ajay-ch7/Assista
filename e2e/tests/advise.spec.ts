// Phase 4: advising and reading, through the real extension and the real backend (with the
// mock model). Facts the user must not miss, such as a box the page ticked for them, are
// found by code in the extension and announced by code in the backend.

import { ask, demoUrl, expect, of, recordedPanel, test } from './fixtures';

interface Rules {
  preticked: string[];
  countdowns: { ref: string; seconds_left: number }[];
}
interface Snapshot {
  nodes: { ref: string; name: string; text: string }[];
  rules: Rules;
}

const lastSnapshot = (frames: ReturnType<typeof of>) =>
  frames.at(-1)!.snapshot as unknown as Snapshot;
const named = (snapshot: Snapshot, ref: string) => {
  const node = snapshot.nodes.find((item) => item.ref === ref)!;
  return node.name || node.text;
};

test('page rules: the pre-ticked box and the session timer reach the backend', async ({
  context,
  openPanel,
}) => {
  const page = await context.newPage();
  await page.goto(demoUrl('checkout.html'));
  const { panel, sent } = await recordedPanel(openPanel);
  await ask(panel, 'where am I?');
  let snapshot = lastSnapshot(of(sent, 'snapshot'));
  expect(snapshot.rules.preticked.map((ref) => named(snapshot, ref))).toEqual([
    'Add Protection Plan for 299 rupees',
  ]);
  expect(snapshot.rules.countdowns).toEqual([]);

  // Once the user unticks it themselves, it is no longer the page's doing.
  await page.getByLabel('Add Protection Plan').click();
  await page.getByLabel('Add Protection Plan').click();
  await ask(panel, 'where am I?');
  snapshot = lastSnapshot(of(sent, 'snapshot'));
  expect(snapshot.rules.preticked).toEqual([]);

  await page.goto(demoUrl('booking.html'));
  await ask(panel, 'where am I?');
  snapshot = lastSnapshot(of(sent, 'snapshot'));
  const [countdown] = snapshot.rules.countdowns;
  expect(named(snapshot, countdown.ref)).toMatch(
    /^We are holding your table. Time left: (5:00|4:5\d)$/,
  );
  expect(countdown.seconds_left).toBeGreaterThanOrEqual(280);
  expect(countdown.seconds_left).toBeLessThanOrEqual(300);
});

test('exit check: the hidden fee and the pre-ticked box are announced, with the true total', async ({
  context,
  openPanel,
}) => {
  const page = await context.newPage();
  await page.goto(demoUrl('checkout.html'));
  const panel = await openPanel();
  const speech = (await ask(panel, 'how much will I pay?')).join(' ');

  const pageTotal = (await page.locator('#total').innerText()).trim();
  expect(pageTotal).toBe('4,946 rupees');
  expect(speech).toContain(`You will pay ${pageTotal} in total.`);
  expect(speech).toContain(
    'Easy to miss, outside the order summary: Prices include a convenience fee of 49 rupees.',
  );
  expect(speech).toContain(
    'Watch out: the page ticked Add Protection Plan for 299 rupees for you.',
  );

  // Unticked by the user: the total drops, and the box is no longer called out.
  await page.getByLabel('Add Protection Plan').click();
  const after = (await ask(panel, 'what is the total now?')).join(' ');
  expect(after).toContain('You will pay 4,647 rupees in total.');
  expect(after).not.toContain('Watch out');
});

test('tricks: pressure to hurry and shaming wording are pointed out', async ({
  context,
  openPanel,
}) => {
  const page = await context.newPage();
  await page.goto(demoUrl('checkout.html'));
  const panel = await openPanel();
  const speech = (await ask(panel, 'is there a catch on this page?')).join(' ');
  expect(speech).toContain('Only 2 left in stock!');
  expect(speech).toContain("No thanks, I don't care about protecting my gear");
});
