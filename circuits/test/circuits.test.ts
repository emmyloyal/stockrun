import { describe, it, expect } from 'vitest';
import { restockGuard, pickupCheck, deliveryCheck, Decision } from '../reference/circuits';
import { packFields, unpackFields, packRestock, packPickup, PICKUP_OUT } from '../reference/pack';

const base = { total: 20, budget: 100, limit: 40, sup: 0b01, cat: 0, dist: 0, ownerOk: false };

describe('RestockGuard', () => {
  it('approves a normal order', () => expect(restockGuard(base)).toEqual({ decision: Decision.APPROVE, reason: 0 }));
  it('rejects unknown and blocked suppliers, even with owner approval', () => {
    expect(restockGuard({ ...base, sup: 0b00, ownerOk: true }).reason).toBe(1);
    expect(restockGuard({ ...base, sup: 0b11, ownerOk: true }).reason).toBe(1);
  });
  it('rejects over-budget orders, even with owner approval', () => {
    expect(restockGuard({ ...base, total: 101, ownerOk: true })).toEqual({ decision: Decision.REJECT, reason: 2 });
    expect(restockGuard({ ...base, total: 100 }).decision).not.toBe(Decision.REJECT); // boundary: equal is fine
  });
  it('asks the owner above the limit, unless approved', () => {
    expect(restockGuard({ ...base, total: 41 })).toEqual({ decision: Decision.ASK_OWNER, reason: 3 });
    expect(restockGuard({ ...base, total: 40 }).decision).toBe(Decision.APPROVE); // boundary
    expect(restockGuard({ ...base, total: 41, ownerOk: true }).decision).toBe(Decision.APPROVE);
  });
  it('asks the owner for restricted categories and far suppliers', () => {
    expect(restockGuard({ ...base, cat: 6 }).reason).toBe(4);
    expect(restockGuard({ ...base, cat: 5 }).decision).toBe(Decision.APPROVE);
    expect(restockGuard({ ...base, dist: 0b11 }).reason).toBe(5);
    expect(restockGuard({ ...base, dist: 0b10 }).decision).toBe(Decision.APPROVE);
  });
  it('preferred suppliers behave like approved ones', () => expect(restockGuard({ ...base, sup: 0b10 }).decision).toBe(Decision.APPROVE));
  it('never approves when total > budget (random sweep)', () => {
    for (let n = 0; n < 100_000; n++) {
      const i = { total: rnd(256), budget: rnd(256), limit: rnd(256), sup: rnd(4), cat: rnd(8), dist: rnd(4), ownerOk: rnd(2) === 1 };
      const o = restockGuard(i);
      if (i.total > i.budget || i.sup === 0 || i.sup === 3) expect(o.decision).toBe(Decision.REJECT);
      if (o.decision === Decision.APPROVE) expect(i.ownerOk || i.total <= i.limit).toBe(true);
    }
  });
});

const pick = { atSupplier: true, ordered: 20, aiCount: 20, riderCount: 20, damage: false, bonded: true };

describe('PickupCheck', () => {
  it('pays in full when counts match', () => expect(pickupCheck(pick)).toEqual({ decision: Decision.PAY_FULL, payQty: 20, reason: 0 }));
  it('pays the smaller of the two counts', () => {
    expect(pickupCheck({ ...pick, aiCount: 18 })).toEqual({ decision: Decision.PAY_PART, payQty: 18, reason: 5 });
    expect(pickupCheck({ ...pick, riderCount: 17, aiCount: 19 }).payQty).toBe(17);
  });
  it('never pays more than ordered', () => expect(pickupCheck({ ...pick, aiCount: 25, riderCount: 25 }).payQty).toBe(20));
  it('holds for location, bond, damage and zero count, in that order', () => {
    expect(pickupCheck({ ...pick, atSupplier: false, bonded: false }).reason).toBe(1);
    expect(pickupCheck({ ...pick, bonded: false, damage: true }).reason).toBe(2);
    expect(pickupCheck({ ...pick, damage: true }).reason).toBe(3);
    expect(pickupCheck({ ...pick, aiCount: 0 })).toEqual({ decision: Decision.HOLD, payQty: 0, reason: 4 });
  });
});

const del = { atShop: true, picked: 18, delivered: 18, damage: false, ownerOk: true, ownerIssue: false, timeout: false };

describe('DeliveryCheck', () => {
  it('pays the rider on owner confirmation', () => expect(deliveryCheck(del)).toEqual({ decision: Decision.PAY_RIDER, shortQty: 0, reason: 0 }));
  it('auto-releases after the 24h timeout with a clean delivery', () =>
    expect(deliveryCheck({ ...del, ownerOk: false, timeout: true }).decision).toBe(Decision.PAY_RIDER));
  it('compensates the owner for short delivery', () =>
    expect(deliveryCheck({ ...del, delivered: 15 })).toEqual({ decision: Decision.COMPENSATE, shortQty: 3, reason: 4 }));
  it('holds conflicting owner reports and damage', () => {
    expect(deliveryCheck({ ...del, ownerOk: false, ownerIssue: true }).reason).toBe(2);
    expect(deliveryCheck({ ...del, damage: true }).reason).toBe(3);
  });
  it('waits when not at the shop or no response yet', () => {
    expect(deliveryCheck({ ...del, atShop: false }).reason).toBe(1);
    expect(deliveryCheck({ ...del, ownerOk: false })).toEqual({ decision: Decision.WAIT, shortQty: 0, reason: 5 });
  });
});

describe('packing', () => {
  it('round-trips fields', () => {
    const bytes = packFields([[5, 3], [200, 8], [1, 1]]);
    expect(unpackFields(bytes, [3, 8, 1])).toEqual([5, 200, 1]);
  });
  it('RestockGuard packs to 34 bits padded to 5 bytes', () => expect(packRestock(base).length).toBe(5));

  // Golden vectors for the TAP-02 §5 layout (LSB-first). StockRunVault.t.sol checks the same bytes.
  it('puts input 0 at bit 0 of byte 0', () => {
    expect([...packFields([[1, 1]])]).toEqual([0x01]);
    expect([...packFields([[0, 1], [1, 1]])]).toEqual([0x02]);
    expect([...packFields([[0b10, 2], [1, 1]])]).toEqual([0x06]); // field LSB on the lower wire
    expect([...packFields([[0, 8], [1, 1]])]).toEqual([0x00, 0x01]);
  });
  it('RestockGuard golden vector', () => {
    const bytes = packRestock({ total: 0x12, budget: 0x34, limit: 0x56, sup: 1, cat: 2, dist: 3, ownerOk: true });
    expect([...bytes]).toEqual([0x12, 0x34, 0x56, 0xe9, 0x00]);
  });
  it('PickupCheck golden vector', () => {
    const bytes = packPickup({ atSupplier: true, ordered: 20, aiCount: 18, riderCount: 19, damage: false, bonded: true });
    expect([...bytes]).toEqual([0x29, 0x24, 0x26, 0x04]);
  });
  it('unpacks outputs LSB-first: PAY_PART(1), payQty 18, reason 5', () =>
    expect(unpackFields(new Uint8Array([0x49, 0x14]), PICKUP_OUT)).toEqual([1, 18, 5]));
  it('rejects short output', () => expect(() => unpackFields(new Uint8Array([0x49]), PICKUP_OUT)).toThrow());
});

function rnd(n: number) { return Math.floor(Math.random() * n); }
