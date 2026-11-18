// Fault injection: forces each gate of each decision circuit stuck at 0 and at 1, then checks that
// random inputs expose the difference against the reference model. An undetected fault is either a
// test gap or a redundant gate (see docs/CIRCUITS.md). Run: node scripts/fault-check.ts
import { evalNetlist } from '../sim/netlist.ts';
import { CIRCUITS } from '../netlists/circuits.ts';
import * as R from '../reference/circuits.ts';
import * as P from '../reference/pack.ts';
const rnd = (n: number) => Math.floor(Math.random() * n);
const cases: any = {
  RestockGuard: [() => ({ total: rnd(256), budget: rnd(256), limit: rnd(256), sup: rnd(4), cat: rnd(8), dist: rnd(4), ownerOk: rnd(2) === 1 }), P.packRestock, P.RESTOCK_OUT, R.restockGuard],
  PickupCheck: [() => { const o = rnd(256); const n = () => rnd(2) ? rnd(256) : Math.min(255, Math.max(0, o + rnd(5) - 2)); return { atSupplier: rnd(8) > 0, ordered: o, aiCount: n(), riderCount: n(), damage: rnd(8) === 0, bonded: rnd(8) > 0 }; }, P.packPickup, P.PICKUP_OUT, R.pickupCheck],
  DeliveryCheck: [() => { const p = rnd(256); return { atShop: rnd(8) > 0, picked: p, delivered: rnd(2) ? rnd(256) : Math.min(255, Math.max(0, p + rnd(5) - 2)), damage: rnd(8) === 0, ownerOk: rnd(2) === 1, ownerIssue: rnd(4) === 0, timeout: rnd(4) === 0 }; }, P.packDelivery, P.DELIVERY_OUT, R.deliveryCheck],
};
for (const [name, gen] of Object.entries(CIRCUITS)) {
  const c = gen(); const [mk, pack, w, ref] = cases[name];
  let caught = 0; const G = c.gates;
  const faults: [number, number][] = []; for (let g = 0; g < G; g++) faults.push([g, 0], [g, 1]);
  const undetected: string[] = [];
  for (const [g, v] of faults) {         // stuck-at-v: NAND(1,1)=0, NAND(0,0)=1
    const nl = c.netlist.slice(); const k = v ? 0 : 1; nl.set([0, 0, 0, k, 0, 0, k], g * 7);
    let hit = false;
    const m = { ...c, netlist: nl };
    for (let s = 0; s < 100000; s++) { const i = mk(); if (P.unpackFields(evalNetlist(m, pack(i)), w).join() !== Object.values(ref(i)).join()) { hit = true; break; } }
    if (hit) caught++; else undetected.push(`g${g}@${v}`);
  }
  console.log(`${name}: ${caught}/${faults.length} stuck-at faults detected`, undetected.slice(0, 12).join(' '));
}
