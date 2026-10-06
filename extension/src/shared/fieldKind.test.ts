import { describe, expect, it } from 'vitest';
import { KIND_WORDS, fieldKind } from './fieldKind';

describe('fieldKind', () => {
  it.each([
    [{ autocomplete: 'name' }, 'name'],
    [{ autocomplete: 'shipping address-level2' }, 'city'],
    [{ autocomplete: 'tel' }, 'phone'],
    [{ autocomplete: 'postal-code' }, 'postcode'],
    [{ type: 'email' }, 'email'],
    [{ type: 'tel', label: 'Contact number' }, 'phone'],
    [{ label: 'Full name' }, 'name'],
    [{ label: 'Your name' }, 'name'],
    [{ name: 'firstName' }, 'given-name'],
    [{ id: 'last_name' }, 'family-name'],
    [{ label: 'E-mail' }, 'email'],
    [{ label: 'Mobile number' }, 'phone'],
    [{ label: 'Street address' }, 'address'],
    [{ label: 'Town / City' }, 'city'],
    [{ label: 'PIN code' }, 'postcode'],
    [{ name: 'zip' }, 'postcode'],
    [{ label: 'Country' }, 'country'],
    [{ label: 'Company (optional)' }, 'organization'],
  ] as const)('reads %o as %s', (hints, kind) => {
    expect(fieldKind(hints)).toBe(kind);
  });

  it.each([
    { label: 'Username' },
    { label: 'Name on card' },
    { label: 'Gift message' },
    { label: 'Coupon code' },
    { label: 'Search products', type: 'search' },
    { label: 'Special requests' },
    { label: 'Number of guests' },
    { label: 'Date' },
    {},
  ])('remembers nothing for %o', (hints) => {
    expect(fieldKind(hints)).toBeNull();
  });

  it('has a spoken name for every kind', () => {
    expect(KIND_WORDS.phone).toBe('phone number');
    expect(Object.values(KIND_WORDS).every((word) => word.length > 0)).toBe(true);
  });
});
