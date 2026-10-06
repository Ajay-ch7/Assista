import { describe, expect, it } from 'vitest';
import { parseConfirmation } from './confirmation';

describe('parseConfirmation', () => {
  it.each(['Yes.', 'yes please', 'Yeah', 'Okay, go ahead.', 'Sure!', 'Assista, do it', 'Confirm'])(
    'hears "%s" as yes',
    (text) => {
      expect(parseConfirmation(text)).toBe(true);
    },
  );

  it.each(['No.', 'No thanks', 'Nope', 'Cancel that, please', "Don't.", 'Never mind', 'Wait'])(
    'hears "%s" as no',
    (text) => {
      expect(parseConfirmation(text)).toBe(false);
    },
  );

  it.each([
    'yes and also buy two more',
    'what is the total?',
    'maybe',
    'yesterday',
    'no idea what that costs',
    '',
  ])('does not take "%s" as an answer', (text) => {
    expect(parseConfirmation(text)).toBeNull();
  });
});
