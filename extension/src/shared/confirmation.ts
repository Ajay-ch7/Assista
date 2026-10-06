// The user's spoken yes or no to an action the confirmation gate is holding. The panel
// decides here, on the device, whether a held action runs. backend/app/confirmation.py
// mirrors the matching, and a backend test checks it against confirmation.json.

import WORDS from './confirmation.json';
import { normalizeCommand } from './localCommands';

/** True for a clear yes, false for a clear no, null for anything else. */
export function parseConfirmation(text: string): boolean | null {
  const said = normalizeCommand(text);
  if (WORDS.yes.includes(said)) return true;
  if (WORDS.no.includes(said)) return false;
  return null;
}
