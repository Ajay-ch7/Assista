// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { PageSnapshot } from '../shared/snapshot';
import { countdownSeconds, noteUserChoice } from './rules';
import { buildSnapshot } from './snapshot';

function snapshotOf(html: string): PageSnapshot {
  document.body.innerHTML = html;
  return buildSnapshot(document);
}

function nameOf(snapshot: PageSnapshot, ref: string): string {
  const node = snapshot.nodes.find((item) => item.ref === ref)!;
  return node.name || node.text;
}

describe('pre-ticked boxes', () => {
  it('lists boxes the page ticked in its own markup', () => {
    const snapshot = snapshotOf(`
      <label><input type="checkbox" checked> Add Protection Plan for 299 rupees</label>
      <label><input type="checkbox"> Email me about new arrivals</label>
      <label><input type="radio" name="speed" checked> Standard delivery</label>`);
    expect(snapshot.rules.preticked.map((ref) => nameOf(snapshot, ref))).toEqual([
      'Add Protection Plan for 299 rupees',
    ]);
  });

  it('leaves out a box the user ticked, and one the page ticked that is now unticked', () => {
    document.body.innerHTML = `
      <label><input id="mine" type="checkbox"> Gift wrap</label>
      <label><input id="unticked" type="checkbox" checked> Insurance</label>`;
    (document.getElementById('mine') as HTMLInputElement).checked = true;
    (document.getElementById('unticked') as HTMLInputElement).checked = false;
    expect(buildSnapshot(document).rules.preticked).toEqual([]);
  });

  it('forgets a pre-ticked box once the user has changed it themselves', () => {
    document.body.innerHTML = '<label><input id="plan" type="checkbox" checked> Plan</label>';
    const box = document.getElementById('plan')!;
    expect(buildSnapshot(document).rules.preticked).toHaveLength(1);
    // Unticked and ticked again by the user: it is their choice now.
    noteUserChoice(box);
    expect(buildSnapshot(document).rules.preticked).toEqual([]);
  });

  it('lists a custom box that was ticked when first seen, but not one ticked later', () => {
    document.body.innerHTML = `
      <div id="a" role="checkbox" aria-checked="true">Share my data with partners</div>
      <div id="b" role="switch" aria-checked="false">Dark mode</div>`;
    expect(buildSnapshot(document).rules.preticked).toHaveLength(1);
    document.getElementById('b')!.setAttribute('aria-checked', 'true');
    const snapshot = buildSnapshot(document);
    expect(snapshot.rules.preticked.map((ref) => nameOf(snapshot, ref))).toEqual([
      'Share my data with partners',
    ]);
  });
});

describe('countdowns', () => {
  it('finds a timer in the text and gives its node and the seconds left', () => {
    const snapshot = snapshotOf(`
      <p>We hold tables for 15 minutes.</p>
      <p>We are holding your table. Time left: <span role="timer">4:40</span></p>`);
    expect(snapshot.rules.countdowns).toHaveLength(1);
    const [countdown] = snapshot.rules.countdowns;
    expect(countdown.seconds_left).toBe(280);
    expect(nameOf(snapshot, countdown.ref)).toContain('Time left: 4:40');
  });

  it.each([
    ['Your session expires in 4:59', 299],
    ['Seats reserved for 1:02:03 more', 3723],
    ['Only 3 minutes left to complete your order', 180],
    ['Time remaining: 2 minutes 30 seconds', 150],
    ['This offer ends in 10 minutes', 600],
    ['You will be signed out in 30 seconds. Session times out in 30 seconds', 30],
  ])('reads %j as %d seconds', (text, seconds) => {
    expect(countdownSeconds(text)).toBe(seconds);
  });

  it.each([
    'Dinner starts at 7:30 pm',
    'We hold tables for 15 minutes.',
    'Opening hours 9:00 to 17:00',
    'Score 3:2 in the final',
    'Delivery takes 3 days',
  ])('does not read %j as a countdown', (text) => {
    expect(countdownSeconds(text)).toBeNull();
  });

  it('reads a bare clock when the page marks it as a timer', () => {
    expect(countdownSeconds('4:40')).toBeNull();
    expect(countdownSeconds('4:40', true)).toBe(280);
  });
});
