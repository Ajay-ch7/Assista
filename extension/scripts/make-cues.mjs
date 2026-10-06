// Writes the sound cues to public/cues as small mono WAV files. Run with
// `node scripts/make-cues.mjs` after changing a cue; the output is committed.
// Each cue is short and distinct in pitch and rhythm, so it can be told apart without
// looking: listening rises, done falls, error drops low, alert repeats, private is two
// soft low notes.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RATE = 22050;
const OUT = resolve(import.meta.dirname, '../public/cues');

/** A tone with a quick attack and a smooth release, so it does not click. */
function tone(frequency, seconds, volume = 0.3, harmonic = 0) {
  const length = Math.round(seconds * RATE);
  const samples = new Float32Array(length);
  const attack = Math.min(0.005 * RATE, length / 4);
  for (let i = 0; i < length; i++) {
    const t = i / RATE;
    const envelope = Math.min(1, i / attack) * Math.pow(1 - i / length, 2);
    const wave =
      Math.sin(2 * Math.PI * frequency * t) + harmonic * Math.sin(2 * Math.PI * frequency * 2 * t);
    samples[i] = (volume * envelope * wave) / (1 + harmonic);
  }
  return samples;
}

function silence(seconds) {
  return new Float32Array(Math.round(seconds * RATE));
}

function join(...parts) {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), i * 2);
  });
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const CUES = {
  listening: join(tone(660, 0.07), tone(880, 0.09)),
  thinking: tone(440, 0.05, 0.12),
  link: tone(1320, 0.06, 0.2),
  error: join(tone(440, 0.12, 0.3, 0.5), tone(311, 0.2, 0.3, 0.5)),
  done: join(tone(880, 0.08, 0.2), tone(660, 0.14, 0.2)),
  alert: join(
    tone(1000, 0.08, 0.35),
    silence(0.05),
    tone(1000, 0.08, 0.35),
    silence(0.05),
    tone(1000, 0.08, 0.35),
  ),
  private: join(tone(392, 0.1, 0.22), silence(0.04), tone(392, 0.1, 0.22)),
};

mkdirSync(OUT, { recursive: true });
for (const [name, samples] of Object.entries(CUES)) {
  writeFileSync(resolve(OUT, `${name}.wav`), wav(samples));
}
console.log(`Wrote ${Object.keys(CUES).length} cues to ${OUT}`);
