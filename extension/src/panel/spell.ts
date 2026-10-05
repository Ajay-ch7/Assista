// "Spell it": picks the hard-to-hear part of the last reply and spells it out letter by
// letter, the way a person would read out a code or an email address.

const SYMBOLS: Record<string, string> = {
  '@': 'at',
  '.': 'dot',
  '-': 'dash',
  _: 'underscore',
  '/': 'slash',
  '\\': 'backslash',
  '+': 'plus',
  '#': 'hash',
  '&': 'and',
  "'": 'apostrophe',
  ',': 'comma',
  ':': 'colon',
  '?': 'question mark',
  '!': 'exclamation mark',
  '(': 'open bracket',
  ')': 'close bracket',
  ' ': 'space',
};
const MAX_SPELLED = 60;

/** A token worth spelling: it has a digit or a symbol inside, or capitals after the first letter. */
const CODE_LIKE = /^(?=.*[0-9@_/#+]|.+[A-Z]).{2,}$/;

/**
 * Picks what "spell it" means after `reply`: the last code-like token (an order number,
 * an email address), else the last name (capitalised words not starting a sentence),
 * else the last word.
 */
export function spellTarget(reply: string): string {
  const sentences = reply.match(/[^.!?]+[.!?]*/g) ?? [];
  const tokens = reply
    .split(/\s+/)
    .map((token) => token.replace(/^[("']+|[)"',;:.!?]+$/g, ''))
    .filter(Boolean);
  const code = tokens.filter((token) => CODE_LIKE.test(token)).at(-1);
  if (code) return code;

  for (const sentence of sentences.reverse()) {
    const words = sentence.trim().split(/\s+/).slice(1);
    const names: string[][] = [];
    let run: string[] = [];
    for (const raw of words) {
      const word = raw.replace(/[^A-Za-z'-]+$/g, '');
      if (/^[A-Z][a-z'-]+$/.test(word)) {
        run.push(word);
      } else {
        if (run.length) names.push(run);
        run = [];
      }
      if (word !== raw && run.length) {
        // Punctuation ends a name.
        names.push(run);
        run = [];
      }
    }
    if (run.length) names.push(run);
    if (names.length) return names.at(-1)!.join(' ');
  }
  return tokens.at(-1) ?? '';
}

/**
 * "Kaveri 7" -> "capital K, A, V, E, R, I, space, 7". Letters are written in capitals so
 * the voice says their names; "capital" is said only when the text mixes cases.
 */
export function spellOut(text: string): string {
  const chars = Array.from(text.trim().replace(/\s+/g, ' ')).slice(0, MAX_SPELLED);
  const mixedCase = /[a-z]/.test(text) && /[A-Z]/.test(text);
  return chars
    .map((char) => {
      if (SYMBOLS[char]) return SYMBOLS[char];
      if (mixedCase && /[A-Z]/.test(char)) return `capital ${char}`;
      return /[a-z]/i.test(char) ? char.toUpperCase() : char;
    })
    .join(', ');
}
