import { describe, it, expect } from 'vitest';
import { evalNetlist, NetlistBuilder } from '../sim/netlist';

describe('netlist simulator (TAP-02)', () => {
  it('evaluates a 4-NAND XOR exhaustively', () => {
    const b = new NetlistBuilder(2);
    b.xor(b.input(0), b.input(1));
    const c = b.build(1);
    expect(b.gates).toBe(4);
    for (let x = 0; x < 4; x++) {
      const out = evalNetlist(c, Uint8Array.of(x));
      expect(out[0]).toBe((x & 1) ^ (x >> 1));
    }
  });

  it('maps input 8 to bit 0 of byte 1 and outputs LSB-first', () => {
    // 9 inputs; the last two signals (= outputs 0 and 1) are copies of in8 and in0.
    const b2 = new NetlistBuilder(9);
    const n8 = b2.not(b2.input(8));
    const n0 = b2.not(b2.input(0));
    b2.not(n8); b2.not(n0); // trailing: in8, in0
    const c = b2.build(2);
    expect([...evalNetlist(c, Uint8Array.of(0x01, 0x00))]).toEqual([0b10]); // in0=1 -> output 1
    expect([...evalNetlist(c, Uint8Array.of(0x00, 0x01))]).toEqual([0b01]); // in8=1 -> output 0
    expect([...evalNetlist(c, Uint8Array.of(0x01))]).toEqual([0b10]); // missing byte reads as 0
  });

  it('rejects forward references and unknown opcodes', () => {
    expect(() => evalNetlist({ netlist: Uint8Array.of(0, 0, 0, 9, 0, 0, 2), nIn: 1, nOut: 1 }, Uint8Array.of(0))).toThrow();
    expect(() => evalNetlist({ netlist: Uint8Array.of(7), nIn: 1, nOut: 1 }, Uint8Array.of(0))).toThrow();
  });
});
