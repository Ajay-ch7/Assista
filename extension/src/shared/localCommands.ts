// Local commands (F10, F11): stop, repeat, slower, faster, spell it, how much detail to
// give, and reading back the action log. They are handled in the extension and never reach the model. A typed command is
// caught before it is sent; a spoken one is recognised by the backend, which ends the
// turn after transcript_final without answering. backend/app/local_commands.py mirrors
// the matching, and a backend test checks it against localCommands.json.

import type { Verbosity } from './protocol';
import PHRASES from './localCommands.json';

export type LocalCommand =
  | { kind: 'stop' }
  | { kind: 'repeat' }
  | { kind: 'slower' }
  | { kind: 'faster' }
  | { kind: 'actions' }
  | { kind: 'forget' }
  | { kind: 'private_on' }
  | { kind: 'private_off' }
  | { kind: 'verbosity'; level: Verbosity }
  | { kind: 'spell'; text: string | null };

/** Words around a command that do not change it: "please repeat that", "Assista, stop". */
const LEADING = /^(?:(?:hey|ok|okay)\s+)?(?:assista\s+)?(?:please\s+)?(?:can you\s+|could you\s+)?/;
const TRAILING = /(?:\s+(?:please|now|assista|thanks|thank you))+$/;

/** Lowercases, drops punctuation and filler words. */
export function normalizeCommand(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9@.\s'-]+/g, ' ')
    .replace(/[.]+(\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING, '')
    .replace(TRAILING, '')
    .trim();
}

export function parseLocalCommand(text: string): LocalCommand | null {
  const said = normalizeCommand(text);
  if (!said) return null;
  for (const [kind, phrases] of Object.entries(PHRASES)) {
    if (!phrases.includes(said)) continue;
    switch (kind) {
      case 'brief':
      case 'normal':
      case 'detailed':
        return { kind: 'verbosity', level: kind };
      case 'spell':
        return { kind: 'spell', text: null };
      default:
        return { kind } as LocalCommand;
    }
  }
  // "spell Kaveri" spells the word given; the original casing is kept.
  if (!said.startsWith('spell ')) return null;
  const spell = /\bspell\s+(?:out\s+)?(.+?)[.!?]*\s*$/i.exec(text);
  return spell ? { kind: 'spell', text: spell[1].trim() } : null;
}
