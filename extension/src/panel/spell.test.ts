import { describe, expect, it } from 'vitest';
import { spellOut, spellTarget } from './spell';

describe('spellTarget', () => {
  it.each([
    ['Your order number is X7K9Q2.', 'X7K9Q2'],
    ['Write to asha@example.com for help.', 'asha@example.com'],
    ['The helpline number is 1077.', '1077'],
    ['The article is by Meera Iyer. It was published today.', 'Meera Iyer'],
    ['The Kaveri rose by two metres.', 'Kaveri'],
    ['This page is titled Lakeside Public Library, and it lists hours.', 'Lakeside Public Library'],
    ['it is closed today', 'today'],
  ])('picks the hard part of %j', (reply, target) => {
    expect(spellTarget(reply)).toBe(target);
  });

  it('is empty without a reply', () => {
    expect(spellTarget('')).toBe('');
  });
});

describe('spellOut', () => {
  it('spells letters, digits and symbols one by one', () => {
    expect(spellOut('X7K')).toBe('X, 7, K');
    expect(spellOut('asha@ex.com')).toBe('A, S, H, A, at, E, X, dot, C, O, M');
    expect(spellOut('Meera Iyer')).toBe('capital M, E, E, R, A, space, capital I, Y, E, R');
  });

  it('stops after a reasonable length', () => {
    expect(spellOut('a'.repeat(200)).split(', ')).toHaveLength(60);
  });
});
