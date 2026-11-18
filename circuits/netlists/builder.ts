// Tiny netlist compiler: build a NAND graph with helper gates, then emit a TAP-02 netlist.
//
// - Signals: 0 = constant 0, 1 = constant 1, 2+i = input i, then gates.
// - Folds constants (NAND(x,0) = 1) and double negation, and merges identical gates.
// - build() drops gates that no output needs, and puts the output gates last, in order,
//   because TAP-02 takes the outputs from the last nOut signals. An output that is an input,
//   a constant, a repeat, or a gate that other gates also use gets a 2-NAND buffer.

import type { Circuit } from '../sim/netlist.ts';

export type Sig = number;

export class Builder {
  static readonly ZERO: Sig = 0;
  static readonly ONE: Sig = 1;
  readonly nIn: number;
  private gates: [Sig, Sig][] = [];
  private cache = new Map<string, Sig>();

  constructor(nIn: number) { this.nIn = nIn; }

  private get base() { return 2 + this.nIn; }
  private isGate(s: Sig) { return s >= this.base; }
  private gate(s: Sig) { return this.gates[s - this.base]; }

  input(i: number): Sig {
    if (!Number.isInteger(i) || i < 0 || i >= this.nIn) throw new RangeError(`input ${i} out of range`);
    return 2 + i;
  }
  /** `width` consecutive inputs starting at `start`, LSB first. */
  inputs(start: number, width: number): Sig[] { return Array.from({ length: width }, (_, k) => this.input(start + k)); }

  private push(a: Sig, b: Sig): Sig {
    const limit = this.base + this.gates.length;
    if (a < 0 || b < 0 || a >= limit || b >= limit) throw new RangeError(`bad signal ${a}/${b}`);
    this.gates.push([a, b]);
    return limit;
  }

  nand(a: Sig, b: Sig): Sig {
    if (a === 0 || b === 0) return Builder.ONE;
    if (a === 1 && b === 1) return Builder.ZERO;
    if (a === 1) a = b; else if (b === 1) b = a; // NAND(x,1) = NOT x
    if (a === b && this.isGate(a)) {             // NOT(NOT x) = x
      const [x, y] = this.gate(a);
      if (x === y) return x;
    }
    const [x, y] = a <= b ? [a, b] : [b, a];
    const key = `${x},${y}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const s = this.push(x, y);
    this.cache.set(key, s);
    return s;
  }

  not(a: Sig) { return this.nand(a, a); }
  and(a: Sig, b: Sig) { return this.not(this.nand(a, b)); }
  or(a: Sig, b: Sig) { return this.nand(this.not(a), this.not(b)); }
  nor(a: Sig, b: Sig) { return this.not(this.or(a, b)); }
  xor(a: Sig, b: Sig) { const n = this.nand(a, b); return this.nand(this.nand(a, n), this.nand(b, n)); }
  xnor(a: Sig, b: Sig) { return this.not(this.xor(a, b)); }
  /** s ? x1 : x0 */
  mux(s: Sig, x1: Sig, x0: Sig) { return this.nand(this.nand(x1, s), this.nand(x0, this.not(s))); }
  muxN(s: Sig, x1: Sig[], x0: Sig[]) { return x1.map((v, i) => this.mux(s, v, x0[i])); }
  orAll(xs: Sig[]) { return xs.reduce((acc, x) => this.or(acc, x), Builder.ZERO); }
  andAll(xs: Sig[]) { return xs.reduce((acc, x) => this.and(acc, x), Builder.ONE); }

  /** Emit a TAP-02 netlist whose outputs are `outputs`, in order. */
  build(outputs: Sig[]): Circuit & { gates: number } {
    if (outputs.length === 0) throw new Error('need at least one output');
    const gates = this.gates.map((g) => [...g] as [Sig, Sig]);
    const base = this.base;
    const isGate = (s: Sig) => s >= base;

    // Find which gates the outputs need (dead-code elimination).
    const live = new Set<Sig>();
    const mark = (s: Sig) => {
      const stack = [s];
      while (stack.length) {
        const t = stack.pop()!;
        if (!isGate(t) || live.has(t)) continue;
        live.add(t);
        stack.push(...gates[t - base]);
      }
    };
    outputs.forEach(mark);

    const users = new Map<Sig, number>();
    for (const g of live) for (const x of gates[g - base]) if (isGate(x)) users.set(x, (users.get(x) ?? 0) + 1);

    // Pick one gate per output to place at the end. Add a 2-NAND buffer when needed.
    const finals: Sig[] = [];
    const taken = new Set<Sig>();
    const extra: [Sig, Sig][] = [];
    let nextId = base + gates.length;
    for (const o of outputs) {
      if (isGate(o) && !taken.has(o) && !users.get(o)) { taken.add(o); finals.push(o); continue; }
      const inv = nextId++; extra.push([o, o]); // NOT o
      const buf = nextId++; extra.push([inv, inv]); // NOT NOT o
      finals.push(buf);
    }
    const all = [...gates, ...extra];
    const extraIds = extra.map((_, k) => base + gates.length + k);
    const finalSet = new Set(finals);

    const order: Sig[] = [];
    for (let k = 0; k < gates.length; k++) { const id = base + k; if (live.has(id) && !finalSet.has(id)) order.push(id); }
    for (const id of extraIds) if (!finalSet.has(id)) order.push(id);
    order.push(...finals);

    const remap = new Map<Sig, Sig>();
    order.forEach((id, k) => remap.set(id, base + k));
    const r = (s: Sig) => (isGate(s) ? remap.get(s)! : s);

    const bytes: number[] = [];
    order.forEach((id, k) => {
      const [a, b] = all[id - base].map(r);
      if (a >= base + k || b >= base + k) throw new Error('internal: forward reference after reordering');
      bytes.push(0x00, (a >> 16) & 255, (a >> 8) & 255, a & 255, (b >> 16) & 255, (b >> 8) & 255, b & 255);
    });
    return { netlist: Uint8Array.from(bytes), nIn: this.nIn, nOut: outputs.length, gates: order.length };
  }
}
