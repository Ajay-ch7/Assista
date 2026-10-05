// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isSensitiveField } from './redaction';

function field(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
}

describe('isSensitiveField', () => {
  it.each([
    ['<input type="password">', ''],
    ['<input autocomplete="one-time-code">', ''],
    ['<input autocomplete="section-pay cc-number">', ''],
    ['<input name="cardNumber">', ''],
    ['<input id="card_number">', ''],
    ['<input name="cvv">', ''],
    ['<input placeholder="Enter OTP">', ''],
    ['<input>', 'One-time password'],
    ['<input>', 'Security code'],
    ['<input name="pin">', ''],
    ['<input>', 'UPI PIN'],
    ['<input name="mpin">', ''],
    ['<input>', 'Card expiry'],
  ])('marks %s (label "%s") as sensitive', (html, label) => {
    expect(isSensitiveField(field(html), label)).toBe(true);
  });

  it.each([
    ['<input type="email" name="email">', 'Email'],
    ['<input name="pincode">', 'PIN code'],
    ['<input name="pin_code">', 'Pin code'],
    ['<input name="shipping">', 'Shipping address'],
    ['<input name="q" type="search">', 'Search products'],
    ['<input autocomplete="cc-name">', 'Name on card'],
    ['<input name="spinner">', 'Quantity'],
  ])('leaves %s (label "%s") alone', (html, label) => {
    expect(isSensitiveField(field(html), label)).toBe(false);
  });
});
