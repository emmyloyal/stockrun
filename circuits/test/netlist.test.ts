import { describe, it, expect } from 'vitest';
import { evalNetlist } from '../sim/netlist.ts';
import { Builder } from '../netlists/builder.ts';

describe('netlist simulator (TAP-02)', () => {
  it('evaluates a 4-NAND XOR exhaustively', () => {
    const B = new Builder(2);
    const c = B.build([B.xor(B.input(0), B.input(1))]);
    expect(c.gates).toBe(4);
    for (let x = 0; x < 4; x++) expect(evalNetlist(c, Uint8Array.of(x))[0]).toBe((x & 1) ^ (x >> 1));
  });

  it('maps input 8 to bit 0 of byte 1 and outputs LSB-first', () => {
    const B = new Builder(9);
    const c = B.build([B.input(8), B.input(0)]); // output 0 = in8, output 1 = in0
    expect([...evalNetlist(c, Uint8Array.of(0x01, 0x00))]).toEqual([0b10]);
    expect([...evalNetlist(c, Uint8Array.of(0x00, 0x01))]).toEqual([0b01]);
    expect([...evalNetlist(c, Uint8Array.of(0x01))]).toEqual([0b10]); // missing byte reads as 0
  });

  it('rejects forward references and unknown opcodes', () => {
    expect(() => evalNetlist({ netlist: Uint8Array.of(0, 0, 0, 9, 0, 0, 2), nIn: 1, nOut: 1 }, Uint8Array.of(0))).toThrow();
    expect(() => evalNetlist({ netlist: Uint8Array.of(7), nIn: 1, nOut: 1 }, Uint8Array.of(0))).toThrow();
  });
});
