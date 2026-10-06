import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionReply, ToolRequest } from '../shared/messages';
import {
  MAX_ENTRIES,
  describeActions,
  entryFor,
  loadActions,
  logAction,
  type ActionEntry,
} from './actionLog';

const tool = (name: string): ToolRequest => ({ name, snapshotId: 's1', ref: 'e1', args: {} });
const done = (result: object): ActionReply => ({ ok: true, result: result as never });

describe('entryFor', () => {
  it('records what was done', () => {
    const reply = done({
      action: 'type',
      target: { role: 'textbox', name: 'City' },
      detail: 'Pune',
    });
    expect(entryFor(tool('type'), reply, 7)).toEqual({
      at: 7,
      tool: 'type',
      target: 'City',
      detail: 'Pune',
      outcome: 'done',
    });
  });

  it('tells apart held, confirmed, private and failed actions', () => {
    const held: ActionReply = {
      ok: false,
      error: 'held_by_gate',
      held: { control: 'Place order', reason: 'risky_control' },
    };
    const sensitive: ActionReply = {
      ok: false,
      error: 'sensitive_field',
      sensitive: { field: 'One-time code' },
    };
    const clicked = done({ action: 'click', target: { role: 'button', name: 'Place order' } });
    expect(entryFor(tool('click'), held, 1)).toMatchObject({
      target: 'Place order',
      outcome: 'held',
    });
    expect(entryFor(tool('click'), clicked, 1, true).outcome).toBe('confirmed');
    expect(entryFor(tool('type'), sensitive, 1)).toMatchObject({
      target: 'One-time code',
      outcome: 'private',
    });
    expect(entryFor(tool('click'), { ok: false, error: 'stale_ref' }, 1).outcome).toBe('failed');
  });
});

describe('describeActions', () => {
  const entry = (partial: Partial<ActionEntry>): ActionEntry => ({
    at: 0,
    tool: 'click',
    outcome: 'done',
    ...partial,
  });

  it('says so when nothing has been done', () => {
    expect(describeActions([])).toBe('I have not done anything on a page yet.');
  });

  it('reads every kind of action as a sentence, oldest first', () => {
    const text = describeActions(
      [
        entry({ target: 'Add to cart' }),
        entry({ tool: 'type', target: 'Full name', detail: 'Asha Rao' }),
        entry({ tool: 'select', target: 'Delivery', detail: 'Express' }),
        entry({ tool: 'type', target: 'One-time code', outcome: 'private' }),
        entry({ target: 'Place order', outcome: 'held' }),
        entry({ target: 'Place order', outcome: 'confirmed' }),
      ],
      10,
    );
    expect(text).toBe(
      'I did 6 things. I pressed Add to cart. I typed Asha Rao into Full name. ' +
        'I chose Express for Delivery. I moved to One-time code for you to type. ' +
        'I stopped before pressing Place order and asked you first. ' +
        'I pressed Place order after you said yes.',
    );
  });

  it('reads navigation, refusals and failures', () => {
    const text = describeActions(
      [
        entry({ tool: 'scroll', detail: 'down' }),
        entry({ tool: 'scroll', detail: 'bottom of the page' }),
        entry({ tool: 'go_back' }),
        entry({ tool: 'switch_tab', target: 'River levels rise' }),
        entry({ tool: 'open_url', detail: 'example.com' }),
        entry({ target: 'Delete account', outcome: 'declined' }),
        entry({ outcome: 'failed' }),
      ],
      10,
    );
    expect(text).toContain('I scrolled down. I scrolled to the bottom of the page.');
    expect(text).toContain('I went back a page. I switched to the tab River levels rise.');
    expect(text).toContain('I opened example.com.');
    expect(text).toContain('You said no, so I did not press Delete account.');
    expect(text).toContain('I tried to press that, but it did not work.');
  });

  it('reads only the latest few', () => {
    const many = Array.from({ length: 8 }, (_, i) => entry({ target: `Button ${i + 1}` }));
    const text = describeActions(many, 3);
    expect(text).toBe(
      'Here are my last 3 actions. I pressed Button 6. I pressed Button 7. I pressed Button 8.',
    );
  });
});

describe('logAction', () => {
  let stored: Record<string, unknown>;

  beforeEach(() => {
    stored = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: stored[key] }),
          set: async (items: Record<string, unknown>) => {
            // Yield, so overlapping writes would lose entries if they were not queued.
            await Promise.resolve();
            Object.assign(stored, items);
          },
        },
      },
    });
  });

  it('keeps entries in order, even when actions finish together', async () => {
    await Promise.all(
      [1, 2, 3, 4].map((at) => logAction({ at, tool: 'click', target: `B${at}`, outcome: 'done' })),
    );
    expect((await loadActions()).map((item) => item.at)).toEqual([1, 2, 3, 4]);
  });

  it('keeps only the newest entries', async () => {
    for (let at = 1; at <= MAX_ENTRIES + 5; at++) {
      await logAction({ at, tool: 'click', outcome: 'done' });
    }
    const entries = await loadActions();
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(entries[0].at).toBe(6);
  });

  it('survives a stored value that is not a list', async () => {
    stored.actionLog = 'corrupt';
    expect(await loadActions()).toEqual([]);
  });
});
