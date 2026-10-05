// Finds form fields whose value must never leave the device: passwords, one-time codes,
// card details and PINs. The snapshot marks them sensitive and sends no value.

const SENSITIVE_AUTOCOMPLETE = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
]);

// "PIN code" is a postal code in India, so it is not treated as a PIN.
const SENSITIVE_HINT = new RegExp(
  [
    'pass ?(word|code|phrase)',
    '\\botp\\b',
    'one ?time',
    '(verification|security|auth\\w*) ?code',
    '\\b(cvv|cvc|csc|cvn)\\b',
    '\\b(card|cc) ?(number|num|no|expiry|expiration|exp)\\b',
    '\\b[mu]?pin\\b(?! ?code)',
  ].join('|'),
  'i',
);

/** "cardNumber", "card_number" and "card-number" all become "card Number"-style words. */
function words(value: string | null | undefined): string {
  return (value ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ');
}

/** `label` is the field's accessible name, as computed for the snapshot. */
export function isSensitiveField(el: Element, label = ''): boolean {
  if (el.getAttribute('type')?.toLowerCase() === 'password') return true;
  const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
  if (autocomplete.some((token) => SENSITIVE_AUTOCOMPLETE.has(token))) return true;
  const hints = [
    label,
    el.getAttribute('name'),
    el.getAttribute('id'),
    el.getAttribute('placeholder'),
    el.getAttribute('aria-label'),
  ];
  return hints.some((hint) => SENSITIVE_HINT.test(words(hint)));
}
