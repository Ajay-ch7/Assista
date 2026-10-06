// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CountdownWarner, findCountdowns, startCountdownWarnings } from './countdown';

describe('CountdownWarner', () => {
  it('warns at two minutes and again at thirty seconds, once each', () => {
    const warner = new CountdownWarner<string>();
    const warnings: [number, number][] = [];
    for (let seconds = 300; seconds > 0; seconds--) {
      const threshold = warner.update('timer', seconds);
      if (threshold !== null) warnings.push([seconds, threshold]);
    }
    expect(warnings).toEqual([
      [120, 120],
      [30, 30],
    ]);
  });

  it('gives only the nearer warning when a countdown is first seen late', () => {
    const warner = new CountdownWarner<string>();
    expect(warner.update('timer', 20)).toBe(30);
    expect(warner.update('timer', 19)).toBeNull();
    const other = new CountdownWarner<string>();
    expect(other.update('timer', 100)).toBe(120);
    expect(other.update('timer', 30)).toBe(30);
  });

  it('warns again after the session is extended', () => {
    const warner = new CountdownWarner<string>();
    expect(warner.update('timer', 110)).toBe(120);
    expect(warner.update('timer', 600)).toBeNull();
    expect(warner.update('timer', 119)).toBe(120);
  });

  it('keeps countdowns apart and stays quiet at zero', () => {
    const warner = new CountdownWarner<string>();
    expect(warner.update('a', 100)).toBe(120);
    expect(warner.update('b', 100)).toBe(120);
    expect(warner.update('a', 0)).toBeNull();
  });
});

describe('findCountdowns', () => {
  function page(html: string): Element[] {
    document.body.innerHTML = html;
    return findCountdowns(document);
  }

  it('finds a timer by its role and by the words around it', () => {
    expect(page('<p>Time left: <span role="timer" id="t">4:59</span></p>')).toHaveLength(1);
    expect(page('<p id="s">Your session expires in 3 minutes.</p>').map((el) => el.id)).toEqual([
      's',
    ]);
    expect(
      page('<div id="d">Seats held for <b>09:41</b> remaining</div>').map((el) => el.id),
    ).toEqual(['d']);
  });

  it('leaves clock times, prices and hidden timers alone', () => {
    expect(page('<p>Open from 9:30 to 18:00. Dinner at 7:30 pm.</p>')).toEqual([]);
    expect(page('<p>Price: 4,499 rupees. 3 left in the box set of 12.</p>')).toEqual([]);
    expect(page('<p style="display:none">Session expires in 2:00</p>')).toEqual([]);
  });

  it('counts one countdown once, however it is nested', () => {
    const found = page(
      '<div><p>Session <span>time left: <b role="timer">1:30</b></span></p></div>',
    );
    expect(found).toHaveLength(1);
  });
});

describe('startCountdownWarnings', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('warns as the page counts down', () => {
    document.body.innerHTML = '<p>Time left: <span role="timer" id="t">2:03</span></p>';
    const timer = document.getElementById('t')!;
    const warnings: number[] = [];
    const stop = startCountdownWarnings((threshold) => warnings.push(threshold), document);

    vi.advanceTimersByTime(2000);
    expect(warnings).toEqual([]);
    timer.textContent = '1:59';
    vi.advanceTimersByTime(1000);
    expect(warnings).toEqual([120]);
    timer.textContent = '0:29';
    vi.advanceTimersByTime(1000);
    expect(warnings).toEqual([120, 30]);
    timer.textContent = '0:10';
    vi.advanceTimersByTime(5000);
    expect(warnings).toEqual([120, 30]);
    stop();
  });

  it('notices a countdown that appears later', () => {
    document.body.innerHTML = '<p>Welcome.</p>';
    const warnings: number[] = [];
    const stop = startCountdownWarnings((threshold) => warnings.push(threshold), document);
    vi.advanceTimersByTime(3000);
    document.body.innerHTML = '<p>Your session expires in 1:45</p>';
    vi.advanceTimersByTime(12_000);
    expect(warnings).toEqual([120]);
    stop();
  });
});
