import { describe, expect, it } from 'vitest';
import { ReplyRecorder } from './replies';

const PCM = { encoding: 'pcm_s16le', sample_rate: 16000, channels: 1 } as const;

describe('ReplyRecorder', () => {
  it('keeps the sentences and audio of the last reply only', () => {
    const replies = new ReplyRecorder();
    replies.sentence('t1', 'Old reply.', PCM);
    replies.audio(new ArrayBuffer(4));
    replies.sentence('t2', 'First.', PCM);
    replies.audio(new ArrayBuffer(2));
    replies.audio(new ArrayBuffer(2));
    replies.sentence('t2', 'Second.', PCM);
    replies.audio(new ArrayBuffer(2));

    expect(replies.text).toBe('First. Second.');
    expect(replies.last.map((s) => s.chunks.length)).toEqual([2, 1]);
    expect(replies.hasAudio).toBe(true);
  });

  it('knows when a reply came without audio', () => {
    const replies = new ReplyRecorder();
    expect(replies.hasAudio).toBe(false);
    replies.sentence('t1', 'Typed reply.', null);
    replies.audio(new ArrayBuffer(2));
    expect(replies.hasAudio).toBe(false);
    expect(replies.last[0].chunks).toEqual([]);
  });
});
