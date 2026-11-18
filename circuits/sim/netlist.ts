// Software evaluator for TapeOut netlists, following TAP-02 (Draft):
//   §2 encoding: 0x00 NAND a:u24 b:u24 | 0x01 LATCH d:u24 | 0x02 REF cpu:20B id:u64 nIns:u8 nOuts:u8 ins:u24×nIns
//      integers are big-endian; s[0]=0, s[1]=1, s[2+i]=input i; outputs = last nOut signals.
//   §5 bit packing: vector bit i = bit (i mod 8) of byte floor(i/8) (LSB-first).
// Supports combinational circuits (no LATCH). REF is resolved through `refs`.

export interface Circuit { netlist: Uint8Array; nIn: number; nOut: number }
export type RefResolver = (cpu: string, id: bigint) => Circuit;

export function bytesToBits(bytes: Uint8Array, n: number): number[] {
  const bits = new Array<number>(n);
  for (let i = 0; i < n; i++) bits[i] = (i >> 3) < bytes.length ? (bytes[i >> 3] >> (i & 7)) & 1 : 0; // lenient read (§5)
  return bits;
}

export function bitsToBytes(bits: number[]): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((v, i) => { if (v) out[i >> 3] |= 1 << (i & 7); });
  return out;
}

const u24 = (b: Uint8Array, p: number) => (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];

export function evalBits(c: Circuit, inputs: number[], refs?: RefResolver): number[] {
  const nl = c.netlist;
  const s: number[] = [0, 1, ...inputs.slice(0, c.nIn)];
  while (s.length < 2 + c.nIn) s.push(0);
  const get = (i: number) => {
    if (i >= s.length) throw new Error(`forward reference to signal ${i} (have ${s.length})`);
    return s[i];
  };
  let p = 0;
  while (p < nl.length) {
    const op = nl[p];
    if (op === 0x00) {
      if (p + 7 > nl.length) throw new Error('truncated NAND');
      s.push(get(u24(nl, p + 1)) & get(u24(nl, p + 4)) ? 0 : 1);
      p += 7;
    } else if (op === 0x01) {
      throw new Error('LATCH not supported (combinational evaluator; use step semantics)');
    } else if (op === 0x02) {
      if (p + 31 > nl.length) throw new Error('truncated REF');
      const cpu = '0x' + [...nl.slice(p + 1, p + 21)].map((x) => x.toString(16).padStart(2, '0')).join('');
      let id = 0n;
      for (let k = 0; k < 8; k++) id = (id << 8n) | BigInt(nl[p + 21 + k]);
      const nIns = nl[p + 29], nOuts = nl[p + 30];
      const ins: number[] = [];
      for (let k = 0; k < nIns; k++) ins.push(get(u24(nl, p + 31 + 3 * k)));
      if (!refs) throw new Error(`REF to ${cpu}#${id} but no resolver given`);
      const sub = refs(cpu, id);
      if (sub.nIn !== nIns || sub.nOut !== nOuts) throw new Error(`REF arity mismatch for ${cpu}#${id}`);
      s.push(...evalBits(sub, ins, refs));
      p += 31 + 3 * nIns;
    } else {
      throw new Error(`unknown opcode 0x${op.toString(16)} at byte ${p}`);
    }
  }
  if (s.length - 2 - c.nIn < c.nOut) throw new Error('netlist produces fewer signals than nOut');
  return s.slice(s.length - c.nOut);
}

/** Same as TapeOut's eval: packed inputs in, ceil(nOut/8) packed output bytes out. */
export function evalNetlist(c: Circuit, inputs: Uint8Array, refs?: RefResolver): Uint8Array {
  return bitsToBytes(evalBits(c, bytesToBits(inputs, c.nIn), refs));
}

/** Small builder for hand-written netlists (tests, tiny blocks). Returns the produced signal index. */
export class NetlistBuilder {
  private bytes: number[] = [];
  private next: number;
  readonly nIn: number;
  constructor(nIn: number) { this.nIn = nIn; this.next = 2 + nIn; }
  static readonly ZERO = 0;
  static readonly ONE = 1;
  input(i: number) { return 2 + i; }
  nand(a: number, b: number): number {
    this.bytes.push(0x00, (a >> 16) & 255, (a >> 8) & 255, a & 255, (b >> 16) & 255, (b >> 8) & 255, b & 255);
    return this.next++;
  }
  not(a: number) { return this.nand(a, a); }
  and(a: number, b: number) { return this.not(this.nand(a, b)); }
  or(a: number, b: number) { return this.nand(this.not(a), this.not(b)); }
  xor(a: number, b: number) { const n = this.nand(a, b); return this.nand(this.nand(a, n), this.nand(b, n)); }
  /** Copy signal `a` so it becomes one of the trailing output signals (2 NANDs). */
  buf(a: number) { return this.not(this.not(a)); }
  build(nOut: number): Circuit { return { netlist: Uint8Array.from(this.bytes), nIn: this.nIn, nOut }; }
  get gates() { return this.next - 2 - this.nIn; }
}
