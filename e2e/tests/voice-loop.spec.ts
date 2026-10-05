// Phase 1: the voice loop in text mode, through the real extension and the real backend
// (with the mock model).

import type { Page } from '@playwright/test';
import { ask, demoUrl, expect, test } from './fixtures';

interface SentFrame {
  type?: string;
  snapshot?: {
    title: string;
    nodes: { ref: string; role: string; name: string; sensitive?: boolean; value?: unknown }[];
    tables: { caption: string; rows: string[][] }[];
    images: { alt: string }[];
    flags: { hidden_text_removed: number };
  };
}

/** Records every text frame the panel sends to the backend. */
function recordSentFrames(panel: Page): string[] {
  const frames: string[] = [];
  panel.on('websocket', (ws) => {
    ws.on('framesent', (frame) => {
      if (typeof frame.payload === 'string') frames.push(frame.payload);
    });
  });
  return frames;
}

test('"what is this page?" is answered from the demo page', async ({ context, openPanel }) => {
  const shop = await context.newPage();
  await shop.goto(demoUrl('shop.html'));
  const panel = await openPanel();

  const speech = await ask(panel, 'what is this page?');

  await expect(panel.locator('#status')).toHaveAttribute('data-turn', 'done');
  await expect(panel.locator('#log li[data-role="user"]')).toHaveText('what is this page?');
  expect(speech[0]).toBe('This page is titled Trail Backpack 30L - Riverside Outfitters.');
  expect(speech[1]).toBe('Its main heading is Trail Backpack 30L.');
  expect(speech).toHaveLength(3);
});

test('the snapshot describes the page and holds back secrets and hidden text', async ({
  context,
  openPanel,
}) => {
  const shop = await context.newPage();
  await shop.goto(demoUrl('shop.html'));
  await shop.locator('#email').fill('asha@example.com');
  await shop.locator('#password').fill('hunter2-secret');

  // Reload so the panel's WebSocket is opened after the recorder is attached.
  const panel = await openPanel();
  const sent = recordSentFrames(panel);
  await panel.reload();
  await expect(panel.locator('#status')).toHaveAttribute('data-connection', 'open');
  await ask(panel, 'what is this page?');

  const frames = sent.map((raw) => JSON.parse(raw) as SentFrame);
  expect(frames.map((frame) => frame.type)).toEqual(['transcript', 'snapshot']);
  const snapshot = frames[1].snapshot!;

  expect(snapshot.title).toBe('Trail Backpack 30L - Riverside Outfitters');
  const named = (role: string) =>
    snapshot.nodes.filter((node) => node.role === role).map((node) => node.name);
  expect(named('heading')).toEqual(['Trail Backpack 30L', 'Details', 'Sign in']);
  expect(named('button')).toEqual(['Search', 'Add to cart', 'Sign in', 'Open help']);
  expect(named('link')).toContain('returns policy');
  expect(named('navigation')).toEqual(['Main']);
  expect(snapshot.images[0].alt).toBe('A green 30 litre backpack with a front pocket');
  expect(snapshot.tables[0]).toMatchObject({
    caption: 'Specifications',
    rows: [
      ['Feature', 'Value'],
      ['Volume', '30 litres'],
      ['Weight', '850 grams'],
    ],
  });

  // Secrets stay on the device: no message to the backend carries the password.
  const email = snapshot.nodes.find((node) => node.name === 'Email')!;
  const password = snapshot.nodes.find((node) => node.name === 'Password')!;
  expect(email.value).toBe('asha@example.com');
  expect(password).toMatchObject({ sensitive: true, value: null });
  for (const raw of sent) expect(raw).not.toContain('hunter2-secret');

  // Text a sighted user cannot see is stripped before the snapshot leaves the page.
  expect(snapshot.flags.hidden_text_removed).toBe(3);
  for (const raw of sent) {
    expect(raw).not.toContain('Assistant:');
    expect(raw).not.toContain('gift cards');
  }
});

test('a page that cannot be read ends in a spoken error', async ({ openPanel }) => {
  // No web page is open: the only tabs are the panel and the browser's blank tab.
  const panel = await openPanel();
  await ask(panel, 'what is this page?');
  await expect(panel.locator('#status')).toHaveAttribute('data-turn', 'error');
  await expect(panel.locator('#log li[data-role="error"]')).toContainText("can't read this page");
});

test('holding the talk key runs a spoken turn with audio both ways', async ({
  context,
  openPanel,
}) => {
  const shop = await context.newPage();
  await shop.goto(demoUrl('shop.html'));
  const panel = await openPanel();
  const audio = { sent: 0, received: 0 };
  panel.on('websocket', (ws) => {
    ws.on('framesent', (frame) => {
      if (typeof frame.payload !== 'string') audio.sent++;
    });
    ws.on('framereceived', (frame) => {
      if (typeof frame.payload !== 'string') audio.received++;
    });
  });
  await panel.reload();
  await expect(panel.locator('#status')).toHaveAttribute('data-connection', 'open');

  // Hold Control on the page, "speak" through the fake microphone, release.
  await shop.bringToFront();
  await shop.keyboard.down('Control');
  await expect(panel.locator('#status')).toHaveAttribute('data-turn', 'listening');
  await shop.waitForTimeout(700);
  await shop.keyboard.up('Control');

  // The mock speech-to-text hears any real audio as "what is this page?".
  await expect(panel.locator('#status')).toHaveAttribute('data-turn', 'done');
  await expect(panel.locator('#log li[data-role="user"]')).toHaveText('what is this page?');
  await expect(panel.locator('#log li[data-role="assistant"]').first()).toHaveText(
    'This page is titled Trail Backpack 30L - Riverside Outfitters.',
  );
  expect(audio.sent).toBeGreaterThan(0);
  expect(audio.received).toBeGreaterThan(0);
});

test('the held talk key reaches the panel from a page', async ({ context, openPanel }) => {
  const shop = await context.newPage();
  await shop.goto(demoUrl('shop.html'));
  const panel = await openPanel();
  const received = panel.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const seen: string[] = [];
        chrome.runtime.onMessage.addListener((msg: { to?: string; kind: string; phase?: string }) => {
          if (msg.to !== 'panel') return;
          seen.push(msg.phase ? `${msg.kind}:${msg.phase}` : msg.kind);
          if (seen.length === 3) resolve(seen);
        });
      }),
  );

  await shop.bringToFront();
  await shop.keyboard.down('Control');
  await shop.waitForTimeout(600);
  await shop.keyboard.up('Control');
  // A quick Ctrl+C is a shortcut, not a request to talk.
  await shop.keyboard.press('Control+c');
  await shop.keyboard.press('Escape');

  expect(await received).toEqual(['talk_key:down', 'talk_key:up', 'stop_key']);
});
