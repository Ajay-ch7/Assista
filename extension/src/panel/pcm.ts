/**
 * Turns a stream of 16-bit little-endian PCM chunks into float samples. A chunk may end in
 * the middle of a sample; the odd byte is kept and joined to the next chunk.
 */
export class PcmDecoder {
  private carry: number | null = null;

  reset(): void {
    this.carry = null;
  }

  decode(chunk: ArrayBuffer): Float32Array<ArrayBuffer> {
    let bytes = new Uint8Array(chunk);
    if (this.carry !== null) {
      const joined = new Uint8Array(bytes.length + 1);
      joined[0] = this.carry;
      joined.set(bytes, 1);
      bytes = joined;
      this.carry = null;
    }
    const count = bytes.length >> 1;
    if (bytes.length % 2 === 1) this.carry = bytes[bytes.length - 1];

    const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000;
    return samples;
  }
}
