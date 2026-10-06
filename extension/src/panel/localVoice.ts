// The browser's built-in voice, for sentences that cannot come from the backend: the
// backend is unreachable, the microphone is blocked, or a turn ended in an error. It is
// also the fallback when the backend's text-to-speech fails: a sentence that arrives
// without audio is spoken here.

/** Speaks `text` at `rate`, where 1 is normal. Cuts off anything it was saying. */
export function say(text: string, rate = 1): void {
  if (!('speechSynthesis' in globalThis)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en';
  utterance.rate = rate;
  speechSynthesis.speak(utterance);
}

/** Speaks `text` after whatever is already being said, without cutting it off. */
export function sayNext(text: string, rate = 1): void {
  if (!('speechSynthesis' in globalThis)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en';
  utterance.rate = rate;
  speechSynthesis.speak(utterance);
}

export function cancelSay(): void {
  if ('speechSynthesis' in globalThis) speechSynthesis.cancel();
}
