// RestockGuard, PickupCheck and DeliveryCheck as flat NAND netlists (blocks inlined; no REF).
// Input/output layouts are those of reference/pack.ts and docs/CIRCUITS.md.
// "First match wins" is built as a priority chain: e_k = (no earlier rule fired) & rule_k.
// Decision codes: 00 REJECT/HOLD/WAIT, 01 ASK_OWNER/PAY_PART/COMPENSATE, 10 APPROVE/PAY_FULL/PAY_RIDER.

import { Builder, type Sig } from './builder.ts';
import { gt, min, sub } from './blocks.ts';

/** Reason code (0..5) as 3 output bits from one-hot "rule k fired" signals. */
function reasonBits(B: Builder, byReason: Partial<Record<1 | 2 | 3 | 4 | 5, Sig>>): [Sig, Sig, Sig] {
  const r = (k: 1 | 2 | 3 | 4 | 5) => byReason[k] ?? Builder.ZERO;
  return [B.orAll([r(1), r(3), r(5)]), B.orAll([r(2), r(3)]), B.orAll([r(4), r(5)])];
}

// ---- RestockGuard: 34 in -> [decision 2, reason 3]
// in: total 0-7, budget 8-15, limit 16-23, sup 24-25, cat 26-28, dist 29-30, ownerOk 31, spare 32-33 (ignored)
export function RESTOCK_GUARD() {
  const B = new Builder(34);
  const total = B.inputs(0, 8), budget = B.inputs(8, 8), limit = B.inputs(16, 8);
  const [sup0, sup1] = B.inputs(24, 2), cat = B.inputs(26, 3), [d0, d1] = B.inputs(29, 2), ok = B.input(31);

  const c1 = B.xnor(sup0, sup1);                 // sup 00 (unknown) or 11 (blocked)
  const c2 = gt(B, total, budget);
  const nok = B.not(ok);
  const c3 = B.and(nok, gt(B, total, limit));
  const c4 = B.and(nok, B.and(cat[2], cat[1]));  // cat >= 6
  const c5 = B.and(nok, B.and(d0, d1));          // dist == 11

  const p2 = B.not(c1);                // rules 1 did not fire
  const e2 = B.and(p2, c2);
  const p3 = B.and(p2, B.not(c2));
  const e3 = B.and(p3, c3);
  const p4 = B.and(p3, B.not(c3));
  const e4 = B.and(p4, c4);
  const p5 = B.and(p4, B.not(c4));
  const e5 = B.and(p5, c5);
  const approve = B.and(p5, B.not(c5));
  const ask = B.orAll([e3, e4, e5]);

  return B.build([ask, approve, ...reasonBits(B, { 1: c1, 2: e2, 3: e3, 4: e4, 5: e5 })]);
}

// ---- PickupCheck: 27 in -> [decision 2, payQty 8, reason 3]
// in: atSupplier 0, ordered 1-8, aiCount 9-16, riderCount 17-24, damage 25, bonded 26
export function PICKUP_CHECK() {
  const B = new Builder(27);
  const at = B.input(0), ordered = B.inputs(1, 8), ai = B.inputs(9, 8), rider = B.inputs(17, 8);
  const damage = B.input(25), bonded = B.input(26);

  const m = min(B, ai, rider);
  const q = min(B, m, ordered);                  // payQty = min(aiCount, riderCount, ordered)
  const short = gt(B, ordered, m);               // q < ordered  <=>  min(ai, rider) < ordered
  const zero = B.not(B.orAll(q));

  const e1 = B.not(at);
  const p2 = at;
  const e2 = B.and(p2, B.not(bonded));
  const p3 = B.and(p2, bonded);
  const e3 = B.and(p3, damage);
  const okp = B.and(p3, B.not(damage));          // passed checks 1-3: may pay
  const e4 = B.and(okp, zero);
  const pay = B.and(okp, B.not(zero));
  const part = B.and(pay, short);
  const full = B.and(pay, B.not(short));
  const payQty = q.map((bit) => B.and(bit, okp)); // 0 when HOLD (q is already 0 for reason 4)

  return B.build([part, full, ...payQty, ...reasonBits(B, { 1: e1, 2: e2, 3: e3, 4: e4, 5: part })]);
}

// ---- DeliveryCheck: 21 in -> [decision 2, shortQty 8, reason 3]
// in: atShop 0, picked 1-8, delivered 9-16, damage 17, ownerOk 18, ownerIssue 19, timeout 20
export function DELIVERY_CHECK() {
  const B = new Builder(21);
  const at = B.input(0), picked = B.inputs(1, 8), delivered = B.inputs(9, 8);
  const damage = B.input(17), ok = B.input(18), issue = B.input(19), timeout = B.input(20);

  // delivered < picked  <=>  picked - delivered has no borrow and is nonzero (shares the subtractor).
  const { diff, noBorrow } = sub(B, picked, delivered);
  const shortfall = B.and(noBorrow, B.orAll(diff));

  const e1 = B.not(at);                          // WAIT, reason 1
  const e3 = B.and(at, damage);                  // HOLD, reason 3
  const p = B.and(at, B.not(damage));
  const comp = B.and(p, shortfall);              // COMPENSATE, reason 4
  const q = B.and(p, B.not(shortfall));
  const e2 = B.and(q, issue);                    // HOLD, reason 2
  const r = B.and(q, B.not(issue));
  const release = B.or(ok, timeout);
  const payRider = B.and(r, release);            // PAY_RIDER, reason 0
  const e5 = B.and(r, B.not(release));           // WAIT, reason 5
  const shortQty = diff.map((bit) => B.and(bit, comp));

  return B.build([comp, payRider, ...shortQty, ...reasonBits(B, { 1: e1, 2: e2, 3: e3, 4: comp, 5: e5 })]);
}

export const CIRCUITS = { RestockGuard: RESTOCK_GUARD, PickupCheck: PICKUP_CHECK, DeliveryCheck: DELIVERY_CHECK } as const;
