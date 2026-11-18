// The three decision-circuit netlists against the reference model:
// every combination of flags/small fields x boundary values for the 8-bit fields, plus 100k random inputs each.
import { describe, it, expect } from 'vitest';
import { evalNetlist, type Circuit } from '../sim/netlist.ts';
import { CIRCUITS } from '../netlists/circuits.ts';
import { restockGuard, pickupCheck, deliveryCheck, type RestockInput, type PickupInput, type DeliveryInput } from '../reference/circuits.ts';
import { packRestock, packPickup, packDelivery, unpackFields, RESTOCK_OUT, PICKUP_OUT, DELIVERY_OUT } from '../reference/pack.ts';

const EDGE = [0, 1, 2, 5, 18, 19, 20, 39, 40, 41, 100, 127, 128, 254, 255];
const RANDOM = 100_000;
const rnd = (n: number) => Math.floor(Math.random() * n);
const bools = [false, true];

function checker<I>(c: Circuit, pack: (i: I) => Uint8Array, widths: number[], ref: (i: I) => object) {
  let n = 0, bad = 0;
  const check = (i: I) => {
    n++;
    const got = unpackFields(evalNetlist(c, pack(i)), widths);
    const want = Object.values(ref(i));
    if (got.join() !== want.join() && ++bad <= 5) console.error('mismatch', i, 'got', got, 'want', want);
  };
  return { check, result: () => ({ n, bad }) };
}

describe('RestockGuard netlist', () => {
  const c = CIRCUITS.RestockGuard();
  it('has the right shape', () => { expect(c.nIn).toBe(34); expect(c.nOut).toBe(5); });
  it('matches the reference on boundaries x all small fields', () => {
    const k = checker<RestockInput>(c, packRestock, RESTOCK_OUT, restockGuard);
    const near = [0, 1, 39, 40, 41, 255];
    for (const total of near) for (const budget of near) for (const limit of near)
      for (let sup = 0; sup < 4; sup++) for (let cat = 0; cat < 8; cat++) for (let dist = 0; dist < 4; dist++)
        for (const ownerOk of bools) k.check({ total, budget, limit, sup, cat, dist, ownerOk });
    for (const total of EDGE) for (const budget of EDGE) for (const limit of EDGE) k.check({ total, budget, limit, sup: 1, cat: 0, dist: 0, ownerOk: false });
    expect(k.result().bad).toBe(0);
  });
  it(`matches the reference on ${RANDOM} random inputs`, () => {
    const k = checker<RestockInput>(c, packRestock, RESTOCK_OUT, restockGuard);
    for (let s = 0; s < RANDOM; s++) k.check({ total: rnd(256), budget: rnd(256), limit: rnd(256), sup: rnd(4), cat: rnd(8), dist: rnd(4), ownerOk: rnd(2) === 1 });
    expect(k.result().bad).toBe(0);
  });
});

describe('PickupCheck netlist', () => {
  const c = CIRCUITS.PickupCheck();
  it('has the right shape', () => { expect(c.nIn).toBe(27); expect(c.nOut).toBe(13); });
  it('matches the reference on boundaries x all flags', () => {
    const k = checker<PickupInput>(c, packPickup, PICKUP_OUT, pickupCheck);
    for (const ordered of EDGE) for (const aiCount of EDGE) for (const riderCount of EDGE)
      for (const atSupplier of bools) for (const damage of bools) for (const bonded of bools)
        k.check({ atSupplier, ordered, aiCount, riderCount, damage, bonded });
    expect(k.result().bad).toBe(0);
  });
  it(`matches the reference on ${RANDOM} random inputs`, () => {
    const k = checker<PickupInput>(c, packPickup, PICKUP_OUT, pickupCheck);
    for (let s = 0; s < RANDOM; s++) {
      const ordered = rnd(256);
      const near = () => (rnd(2) ? rnd(256) : Math.max(0, Math.min(255, ordered + rnd(5) - 2))); // bias towards ordered
      k.check({ atSupplier: rnd(8) > 0, ordered, aiCount: near(), riderCount: near(), damage: rnd(8) === 0, bonded: rnd(8) > 0 });
    }
    expect(k.result().bad).toBe(0);
  });
});

describe('DeliveryCheck netlist', () => {
  const c = CIRCUITS.DeliveryCheck();
  it('has the right shape', () => { expect(c.nIn).toBe(21); expect(c.nOut).toBe(13); });
  it('matches the reference on the ENTIRE input space (2^21 inputs)', () => {
    const k = checker<DeliveryInput>(c, packDelivery, DELIVERY_OUT, deliveryCheck);
    for (let flags = 0; flags < 32; flags++) {
      const [atShop, damage, ownerOk, ownerIssue, timeout] = [0, 1, 2, 3, 4].map((b) => ((flags >> b) & 1) === 1);
      for (let picked = 0; picked < 256; picked++) for (let delivered = 0; delivered < 256; delivered++)
        k.check({ atShop, picked, delivered, damage, ownerOk, ownerIssue, timeout });
    }
    expect(k.result()).toEqual({ n: 2 ** 21, bad: 0 });
  }, 120_000);
  it(`matches the reference on ${RANDOM} random inputs`, () => {
    const k = checker<DeliveryInput>(c, packDelivery, DELIVERY_OUT, deliveryCheck);
    for (let s = 0; s < RANDOM; s++) {
      const picked = rnd(256), delivered = rnd(2) ? rnd(256) : Math.max(0, Math.min(255, picked + rnd(5) - 2));
      k.check({ atShop: rnd(8) > 0, picked, delivered, damage: rnd(8) === 0, ownerOk: rnd(2) === 1, ownerIssue: rnd(4) === 0, timeout: rnd(4) === 0 });
    }
    expect(k.result().bad).toBe(0);
  });
});
