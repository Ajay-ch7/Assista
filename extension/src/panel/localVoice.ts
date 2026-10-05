// The browser's built-in voice, for sentences that cannot come from the backend: the
// backend is unreachable, the microphone is blocked, or a turn ended in an error.

export function say(text: string): void {
  if (!('speechSynthesis' in globalThis)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en';
  speechSynthesis.speak(utterance);
}

export function cancelSay(): void {
  if ('speechSynthesis' in globalThis) speechSynthesis.cancel();
}
