import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { evalNetlist, type Circuit } from '../sim/netlist.ts';
import { BLOCKS } from '../netlists/blocks.ts';
import { CIRCUITS } from '../netlists/circuits.ts';
import { Builder } from '../netlists/builder.ts';
import { cmp8, min8, sub8 } from '../reference/circuits.ts';
import { packFields, unpackFields } from '../reference/pack.ts';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Exhaustive: all 65,536 (a, b) pairs against the reference model. */
function exhaustive(c: Circuit, outWidth: number, ref: (a: number, b: number) => number) {
  let bad = 0;
  for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) {
    const [got] = unpackFields(evalNetlist(c, packFields([[a, 8], [b, 8]])), [outWidth]);
    if (got !== ref(a, b) && ++bad <= 3) console.error(`a=${a} b=${b} got=${got} want=${ref(a, b)}`);
  }
  return bad;
}

describe('shared blocks: netlists match the reference model exhaustively', () => {
  it('CMP8 (a > b)', () => { const c = BLOCKS.CMP8(); expect(c.nOut).toBe(1); expect(exhaustive(c, 1, cmp8)).toBe(0); });
  it('MIN8', () => { const c = BLOCKS.MIN8(); expect(c.nOut).toBe(8); expect(exhaustive(c, 8, min8)).toBe(0); });
  it('SUB8 (mod 256)', () => { const c = BLOCKS.SUB8(); expect(c.nOut).toBe(8); expect(exhaustive(c, 8, sub8)).toBe(0); });

  it('gate counts stay within budget (eval costs ~2.3k gas per gate)', () => {
    expect(BLOCKS.CMP8().gates).toBeLessThanOrEqual(45);
    expect(BLOCKS.MIN8().gates).toBeLessThanOrEqual(70);
    expect(BLOCKS.SUB8().gates).toBeLessThanOrEqual(75);
  });

  it('build/ artifacts are exactly what the generator produces (we tape out what we tested)', () => {
    for (const [name, gen] of Object.entries({ ...BLOCKS, ...CIRCUITS })) {
      const c = gen();
      const art = JSON.parse(readFileSync(new URL(`../build/${name}.json`, import.meta.url), 'utf8'));
      expect({ nIn: art.nIn, nOut: art.nOut, gates: art.gates, netlist: art.netlist }).toEqual({ nIn: c.nIn, nOut: c.nOut, gates: c.gates, netlist: '0x' + hex(c.netlist) });
    }
  });
});

describe('builder', () => {
  it('buffers outputs that are inputs, repeated, or used internally', () => {
    const B = new Builder(2);
    const n = B.nand(B.input(0), B.input(1));
    const c = B.build([B.input(1), n, B.not(n), n]);
    for (let x = 0; x < 4; x++) {
      const a = x & 1, b = x >> 1, nn = (a & b) ^ 1;
      expect(unpackFields(evalNetlist(c, Uint8Array.of(x)), [1, 1, 1, 1])).toEqual([b, nn, nn ^ 1, nn]);
    }
  });
  it('folds constants and double negation, and drops dead gates', () => {
    const B = new Builder(1);
    const x = B.input(0);
    expect(B.nand(x, Builder.ZERO)).toBe(Builder.ONE);
    expect(B.not(B.not(x))).toBe(x);
    B.xor(x, x); // dead
    const c = B.build([B.not(x)]);
    expect(c.gates).toBe(1);
  });
});
