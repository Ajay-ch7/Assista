// Keeps the last reply, sentence by sentence with its audio, so "repeat" can replay it
// without asking the backend again, and "spell it" knows what was said.

import type { AudioFormat } from '../shared/protocol';

export interface RecordedSentence {
  text: string;
  /** Null when the sentence came without audio, as in text mode. */
  format: AudioFormat | null;
  chunks: ArrayBuffer[];
}

export class ReplyRecorder {
  private sentences: RecordedSentence[] = [];
  private turn: string | null = null;

  /** Starts a new sentence. The first sentence of a new turn replaces the last reply. */
  sentence(turn: string, text: string, format: AudioFormat | null): void {
    if (turn !== this.turn) {
      this.turn = turn;
      this.sentences = [];
    }
    this.sentences.push({ text, format, chunks: [] });
  }

  /** Adds audio to the sentence started last. */
  audio(chunk: ArrayBuffer): void {
    const current = this.sentences.at(-1);
    if (current?.format) current.chunks.push(chunk);
  }

  get last(): readonly RecordedSentence[] {
    return this.sentences;
  }

  get text(): string {
    return this.sentences.map((sentence) => sentence.text).join(' ');
  }

  /** True when every sentence of the last reply has its audio. */
  get hasAudio(): boolean {
    return (
      this.sentences.length > 0 &&
      this.sentences.every((sentence) => sentence.format && sentence.chunks.length > 0)
    );
  }
}
