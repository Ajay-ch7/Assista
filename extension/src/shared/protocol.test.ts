import { describe, expect, it } from 'vitest';
import { parseServerMessage, type ClientMessage } from './protocol';
import type { PageSnapshot } from './snapshot';

describe('parseServerMessage', () => {
  it('accepts a known message', () => {
    const msg = parseServerMessage('{"type":"speak_text","turn_id":"t1","seq":0,"text":"Hello."}');
    expect(msg).toEqual({ type: 'speak_text', turn_id: 't1', seq: 0, text: 'Hello.' });
  });

  it('rejects unknown types, missing turn ids and invalid JSON', () => {
    expect(parseServerMessage('{"type":"reboot","turn_id":"t1"}')).toBeNull();
    expect(parseServerMessage('{"type":"done"}')).toBeNull();
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage('null')).toBeNull();
  });
});

describe('snapshot message', () => {
  it('carries the section 5.2 shape', () => {
    const snapshot: PageSnapshot = {
      url: 'https://example.test/',
      title: 'Example',
      snapshot_id: 's1',
      nodes: [
        { ref: 'e12', role: 'button', name: 'Add to cart', text: '', state: { disabled: false } },
        {
          ref: 'e13',
          role: 'textbox',
          name: 'Card number',
          text: '',
          sensitive: true,
          value: null,
        },
      ],
      tables: [{ ref: 't1', caption: 'Prices', rows: [['a', 'b']] }],
      images: [{ ref: 'i3', alt: '', width: 400, height: 300 }],
      rules: { preticked: ['e40'], countdowns: [{ ref: 'e51', seconds_left: 280 }] },
      flags: { has_canvas: false, thin: false, clutter_removed: 14, hidden_text_removed: 2 },
    };
    const msg: ClientMessage = { type: 'snapshot', turn_id: 't1', snapshot };
    expect(JSON.parse(JSON.stringify(msg)).snapshot.nodes[1].value).toBeNull();
  });
});
