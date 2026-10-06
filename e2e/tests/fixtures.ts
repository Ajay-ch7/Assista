import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test as base, chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { BACKEND_PORT, DEMO_PORT } from '../playwright.config';

const EXTENSION_DIR = resolve(import.meta.dirname, '../../extension/dist');

export const demoUrl = (page: string) => `http://127.0.0.1:${DEMO_PORT}/${page}`;

interface Fixtures {
  context: BrowserContext;
  extensionId: string;
  /** Opens the voice shell as a tab, connected to the test backend. */
  openPanel: () => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  // Extensions load only in a persistent context.
  context: async ({}, use) => {
    if (!existsSync(resolve(EXTENSION_DIR, 'manifest.json'))) {
      throw new Error('Build the extension first: run `npm run build` in extension/.');
    }
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        // A synthetic microphone, granted without a prompt, so spoken turns can be tested.
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(new URL(worker.url()).host);
  },

  openPanel: async ({ context, extensionId }, use) => {
    await use(async () => {
      const panel = await context.newPage();
      const backend = `ws://127.0.0.1:${BACKEND_PORT}/ws`;
      await panel.goto(
        `chrome-extension://${extensionId}/src/panel/index.html?backend=${encodeURIComponent(backend)}`,
      );
      await expect(panel.locator('#status')).toHaveAttribute('data-connection', 'open');
      return panel;
    });
  },
});

export { expect };

/** Types a request into the panel and waits for the turn to end. */
export async function ask(panel: Page, text: string): Promise<string[]> {
  const before = await panel.locator('#log li').count();
  await panel.locator('#text-input').fill(text);
  await panel.locator('#text-input').press('Enter');
  await expect(panel.locator('#status')).toHaveAttribute('data-turn', /^(done|error)$/);
  return panel.locator(`#log li:nth-child(n+${before + 1})[data-role="assistant"]`).allInnerTexts();
}

export interface Frame {
  type: string;
  [key: string]: unknown;
}

/** Opens the panel and records every text frame it sends and receives, raw and parsed. */
export async function recordedPanel(openPanel: () => Promise<Page>) {
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

export const of = (frames: Frame[], type: string) =>
  frames.filter((frame) => frame.type === type);
