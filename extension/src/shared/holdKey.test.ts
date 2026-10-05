import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KEYS, HoldKeyMachine } from './holdKey';

function setup() {
  const events: string[] = [];
  const machine = new HoldKeyMachine(DEFAULT_KEYS, {
    onTalkStart: () => events.push('start'),
    onTalkEnd: () => events.push('end'),
    onTalkCancel: () => events.push('cancel'),
    onStop: () => events.push('stop'),
  });
  return { machine, events };
}

describe('HoldKeyMachine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts after the hold time and ends on release', () => {
    const { machine, events } = setup();
    machine.keyDown('Control');
    vi.advanceTimersByTime(399);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(['start']);
    machine.keyUp('Control');
    expect(events).toEqual(['start', 'end']);
  });

  it('does nothing for a short tap', () => {
    const { machine, events } = setup();
    machine.keyDown('Control');
    vi.advanceTimersByTime(200);
    machine.keyUp('Control');
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
  });

  it('ignores the hold when another key is pressed during it', () => {
    const { machine, events } = setup();
    machine.keyDown('Control');
    vi.advanceTimersByTime(100);
    machine.keyDown('c');
    vi.advanceTimersByTime(1000);
    machine.keyUp('c');
    machine.keyUp('Control');
    expect(events).toEqual([]);
  });

  it('ignores the hold when the mouse is used during it', () => {
    const { machine, events } = setup();
    machine.keyDown('Control');
    machine.interrupt();
    vi.advanceTimersByTime(1000);
    machine.keyUp('Control');
    expect(events).toEqual([]);
  });

  it('cancels a turn when another key is pressed after listening began', () => {
    const { machine, events } = setup();
    machine.keyDown('Control');
    vi.advanceTimersByTime(400);
    machine.keyDown('v');
    machine.keyUp('Control');
    expect(events).toEqual(['start', 'cancel']);
  });

  it('ignores auto-repeat of the talk key', () => {
    const { machine, events } = setup();
    machine.keyDown('Control');
    machine.keyDown('Control', true);
    vi.advanceTimersByTime(400);
    machine.keyDown('Control', true);
    expect(events).toEqual(['start']);
  });

  it('works again after a spoiled hold', () => {
    const { machine, events } = setup();
    machine.keyDown('Control');
    machine.keyDown('a');
    machine.keyUp('Control');
    machine.keyDown('Control');
    vi.advanceTimersByTime(400);
    expect(events).toEqual(['start']);
  });

  it('reports the stop key', () => {
    const { machine, events } = setup();
    machine.keyDown('Escape');
    expect(events).toEqual(['stop']);
  });

  it('cancels when the window loses focus while listening', () => {
    const { machine, events } = setup();
    machine.keyDown('Control');
    vi.advanceTimersByTime(400);
    machine.reset();
    machine.keyUp('Control');
    expect(events).toEqual(['start', 'cancel']);
  });

  it('uses reconfigured keys', () => {
    const { machine, events } = setup();
    machine.configure({ talkKey: 'F9', holdMs: 100, stopKey: 'F10' });
    machine.keyDown('Control');
    vi.advanceTimersByTime(1000);
    machine.keyUp('Control');
    machine.keyDown('F9');
    vi.advanceTimersByTime(100);
    machine.keyDown('F10');
    expect(events).toEqual(['start', 'stop', 'cancel']);
  });
});
