// Saved details in the page (F20): knows which fields have a saved detail to offer, and
// fills one in when asked. The value goes from the device's store straight into the field.

import { isSensitiveField } from '../safety/redaction';
import { fieldKind, type DetailKind } from '../shared/fieldKind';
import type { SavedDetails } from '../store/savedDetails';

/** The details saved on this device, kept current by the content script. */
let details: SavedDetails = {};

export function setSavedDetails(next: SavedDetails): void {
  details = next;
}

/** The kind of detail `el` asks for; null for sensitive fields and anything not worth saving. */
export function kindOf(el: Element, name: string): DetailKind | null {
  if (isSensitiveField(el, name)) return null;
  return fieldKind({
    autocomplete: el.getAttribute('autocomplete'),
    type: el.getAttribute('type'),
    name: el.getAttribute('name'),
    id: el.getAttribute('id'),
    label: name,
  });
}

/** The saved detail that fits `el`, or null when there is none. */
export function savedValueFor(el: Element, name: string): string | null {
  const kind = kindOf(el, name);
  return (kind && details[kind]) || null;
}
