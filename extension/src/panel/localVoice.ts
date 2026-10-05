// The browser's built-in voice, for sentences that cannot come from the backend: the
// backend is unreachable, the microphone is blocked, or a turn ended in an error.

/** Speaks `text` at `rate`, where 1 is normal. Cuts off anything it was saying. */
export function say(text: string, rate = 1): void {
  if (!('speechSynthesis' in globalThis)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en';
  utterance.rate = rate;
  speechSynthesis.speak(utterance);
}

export function cancelSay(): void {
  if ('speechSynthesis' in globalThis) speechSynthesis.cancel();
}
