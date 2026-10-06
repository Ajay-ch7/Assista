// Saved details (F20): which kind of personal detail a form field asks for. The same kind
// links a value the user gave once to the matching field on another site.

export type DetailKind =
  | 'name'
  | 'given-name'
  | 'family-name'
  | 'email'
  | 'phone'
  | 'address'
  | 'city'
  | 'state'
  | 'postcode'
  | 'country'
  | 'organization';

/** How each kind is said aloud. */
export const KIND_WORDS: Record<DetailKind, string> = {
  name: 'name',
  'given-name': 'first name',
  'family-name': 'last name',
  email: 'email address',
  phone: 'phone number',
  address: 'address',
  city: 'city',
  state: 'state',
  postcode: 'postal code',
  country: 'country',
  organization: 'company',
};

/** The browser's own names for fields, from the autocomplete attribute. */
const AUTOCOMPLETE: Record<string, DetailKind> = {
  name: 'name',
  'given-name': 'given-name',
  'family-name': 'family-name',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  'street-address': 'address',
  'address-line1': 'address',
  'address-level2': 'city',
  'address-level1': 'state',
  'postal-code': 'postcode',
  country: 'country',
  'country-name': 'country',
  organization: 'organization',
};

/** Wording on the field itself, most specific first. */
const WORDING: [RegExp, DetailKind][] = [
  [/\b(first|given) ?name\b/, 'given-name'],
  [/\b(last|family) ?name\b|\bsurname\b/, 'family-name'],
  [/\be ?mail\b/, 'email'],
  [/\b(phone|mobile|telephone|tel)\b/, 'phone'],
  [/\b(pin ?code|zip|post ?code|postal)\b/, 'postcode'],
  [/\b(street|address)\b/, 'address'],
  [/\b(city|town)\b/, 'city'],
  [/\b(state|province)\b/, 'state'],
  [/\bcountry\b/, 'country'],
  [/\b(company|organi[sz]ation)\b/, 'organization'],
  [/\b(full|your)? ?name\b/, 'name'],
];

/** Fields that look personal but must never be saved. */
const NEVER = /\b(user ?name|login|card|coupon|promo|gift|search|file ?name|nick ?name)\b/;

export interface FieldHints {
  autocomplete?: string | null;
  type?: string | null;
  name?: string | null;
  id?: string | null;
  label?: string | null;
}

function words(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase();
}

/** The kind of detail a field asks for, or null when it is not one worth remembering. */
export function fieldKind(hints: FieldHints): DetailKind | null {
  for (const token of (hints.autocomplete ?? '').toLowerCase().split(/\s+/)) {
    if (AUTOCOMPLETE[token]) return AUTOCOMPLETE[token];
  }
  const type = (hints.type ?? '').toLowerCase();
  const wording = [hints.label, hints.name, hints.id].map(words).join(' | ');
  if (NEVER.test(wording)) return null;
  if (type === 'email') return 'email';
  if (type === 'tel') return 'phone';
  for (const [pattern, kind] of WORDING) {
    if (pattern.test(wording)) return kind;
  }
  return null;
}
