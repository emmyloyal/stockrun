// Writes the generated netlists to circuits/build/<NAME>.json for the tapeout scripts, plus
// build/vectors/<NAME>.json: input -> expected output pairs computed from the REFERENCE MODEL
// (not the netlist), for comparing on-chain eval() after tapeout (contracts/test/fork/).
//   node scripts/build-netlists.ts
// test/blocks.test.ts fails if the netlists drift from the generator.

import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BLOCKS } from '../netlists/blocks.ts';
import { CIRCUITS } from '../netlists/circuits.ts';
import * as R from '../reference/circuits.ts';
import * as P from '../reference/pack.ts';

const dir = new URL('../build/', import.meta.url);
mkdirSync(new URL('vectors/', dir), { recursive: true });
const hex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');

// Deterministic PRNG (mulberry32) so the vector files are reproducible.
let seed = 0x5713c0de;
const rnd = (n: number) => { seed = (seed + 0x6d2b79f5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n); };
const coin = (p = 2) => rnd(p) > 0;
const E = [0, 1, 18, 19, 20, 40, 41, 127, 128, 254, 255];

type Vec = { ins: string[]; outs: string[] };
const vec = <I>(inputs: I[], pack: (i: I) => Uint8Array, out: (i: I) => number[], widths: number[]): Vec => ({
  ins: inputs.map((i) => hex(pack(i))),
  outs: inputs.map((i) => hex(P.packFields(out(i).map((v, k) => [v, widths[k]] as [number, number])))),
});
const pairs = () => { const v: [number, number][] = []; for (const a of E) for (const b of E) v.push([a, b]); while (v.length < 200) v.push([rnd(256), rnd(256)]); return v; };
const ab = ([a, b]: [number, number]) => P.packFields([[a, 8], [b, 8]]);

const N = 150;
const vectors: Record<string, Vec> = {
  CMP8: vec(pairs(), ab, ([a, b]) => [R.cmp8(a, b)], [1]),
  MIN8: vec(pairs(), ab, ([a, b]) => [R.min8(a, b)], [8]),
  SUB8: vec(pairs(), ab, ([a, b]) => [R.sub8(a, b)], [8]),
  RestockGuard: vec(Array.from({ length: N }, (_, k) => k < 6
      ? [{ total: 20, budget: 100, limit: 40, sup: 1, cat: 0, dist: 0, ownerOk: false }, { total: 41, budget: 100, limit: 40, sup: 2, cat: 0, dist: 0, ownerOk: false },
         { total: 101, budget: 100, limit: 40, sup: 1, cat: 0, dist: 0, ownerOk: true }, { total: 5, budget: 100, limit: 40, sup: 3, cat: 0, dist: 0, ownerOk: true },
         { total: 5, budget: 100, limit: 40, sup: 1, cat: 6, dist: 0, ownerOk: false }, { total: 5, budget: 100, limit: 40, sup: 1, cat: 0, dist: 3, ownerOk: false }][k]
      : { total: coin() ? E[rnd(E.length)] : rnd(256), budget: coin() ? E[rnd(E.length)] : rnd(256), limit: coin() ? E[rnd(E.length)] : rnd(256), sup: rnd(4), cat: rnd(8), dist: rnd(4), ownerOk: coin() }),
    P.packRestock, (i) => Object.values(R.restockGuard(i)), P.RESTOCK_OUT),
  PickupCheck: vec(Array.from({ length: N }, () => { const o = rnd(256); const near = () => (coin() ? rnd(256) : Math.max(0, Math.min(255, o + rnd(5) - 2)));
      return { atSupplier: coin(8), ordered: o, aiCount: near(), riderCount: near(), damage: !coin(8), bonded: coin(8) }; }),
    P.packPickup, (i) => Object.values(R.pickupCheck(i)), P.PICKUP_OUT),
  DeliveryCheck: vec(Array.from({ length: N }, () => { const p = rnd(256);
      return { atShop: coin(8), picked: p, delivered: coin() ? rnd(256) : Math.max(0, Math.min(255, p + rnd(5) - 2)), damage: !coin(8), ownerOk: coin(), ownerIssue: !coin(4), timeout: !coin(4) }; }),
    P.packDelivery, (i) => Object.values(R.deliveryCheck(i)), P.DELIVERY_OUT),
};

for (const [name, gen] of Object.entries({ ...BLOCKS, ...CIRCUITS })) {
  const c = gen();
  const art = { name, nIn: c.nIn, nOut: c.nOut, gates: c.gates, bytes: c.netlist.length, sha256: createHash('sha256').update(c.netlist).digest('hex'), netlist: hex(c.netlist) };
  writeFileSync(new URL(`${name}.json`, dir), JSON.stringify(art, null, 2) + '\n');
  writeFileSync(new URL(`vectors/${name}.json`, dir), JSON.stringify(vectors[name], null, 1) + '\n');
  console.log(`${name}: ${c.nIn} in, ${c.nOut} out, ${c.gates} NAND, ${c.netlist.length} bytes, ${vectors[name].ins.length} vectors`);
}
