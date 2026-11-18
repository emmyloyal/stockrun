// Shared 8-bit blocks: CMP8, MIN8, SUB8 (docs/CIRCUITS.md "Shared sub-circuits").
// Each block is a function on a Builder, so the big circuits can inline it (flat) or
// call it through REF. The top-level circuits take a = inputs 0..7 and b = inputs 8..15, LSB-first.

import { Builder, type Sig } from './builder.ts';

/** a > b, ripple from LSB: g' = MAJ(a_i, !b_i, g), g starts at 0. About 6 NANDs per bit. */
export function gt(B: Builder, a: Sig[], b: Sig[]): Sig {
  let g: Sig = Builder.ZERO;
  for (let i = 0; i < a.length; i++) {
    const t1 = B.nand(a[i], B.not(b[i])); // !(a & !b)
    const t3 = B.nand(B.not(a[i]), b[i]); // a | !b
    const t2 = B.nand(g, t3);             // !(g & (a | !b))
    g = B.nand(t1, t2);                   // (a & !b) | (g & (a | !b))
  }
  return g;
}

/** min(a, b) = (a > b) ? b : a */
export function min(B: Builder, a: Sig[], b: Sig[]): Sig[] {
  return B.muxN(gt(B, a, b), b, a);
}

/** (a − b) mod 2^n as a + !b + 1, with a ripple carry. Also returns the carry out (1 iff a ≥ b). */
export function sub(B: Builder, a: Sig[], b: Sig[]): { diff: Sig[]; noBorrow: Sig } {
  // Bit 0 has carry-in 1: diff0 = a0 xor b0, carry0 = a0 | !b0 (saves 3 NANDs over the generic adder).
  const diff: Sig[] = [B.xor(a[0], b[0])];
  let c: Sig = B.nand(B.not(a[0]), b[0]);
  for (let i = 1; i < a.length; i++) {
    const x = a[i], y = B.not(b[i]);
    // NAND full adder on (x, y, c).
    const s1 = B.nand(x, y);
    const p = B.nand(B.nand(x, s1), B.nand(y, s1)); // x xor y
    const s4 = B.nand(p, c);
    diff.push(B.nand(B.nand(p, s4), B.nand(c, s4))); // p xor c
    c = B.nand(s1, s4);                               // carry
  }
  return { diff, noBorrow: c };
}

export const CMP8 = () => { const B = new Builder(16); return B.build([gt(B, B.inputs(0, 8), B.inputs(8, 8))]); };
export const MIN8 = () => { const B = new Builder(16); return B.build(min(B, B.inputs(0, 8), B.inputs(8, 8))); };
export const SUB8 = () => { const B = new Builder(16); return B.build(sub(B, B.inputs(0, 8), B.inputs(8, 8)).diff); };

export const BLOCKS = { CMP8, MIN8, SUB8 } as const;
