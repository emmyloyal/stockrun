// Reference model of the three StockRun circuits. Source of truth: docs/CIRCUITS.md.
// Netlists and the vault must match these functions bit for bit.

export const Decision = { REJECT: 0b00, HOLD: 0b00, WAIT: 0b00, ASK_OWNER: 0b01, PAY_PART: 0b01, COMPENSATE: 0b01, APPROVE: 0b10, PAY_FULL: 0b10, PAY_RIDER: 0b10 } as const;

const u8 = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 0 || n > 255) throw new RangeError(`${name} must be 0..255, got ${n}`);
  return n;
};
const bit = (b: boolean | number) => (b ? 1 : 0);

// ---------- RestockGuard ----------
export interface RestockInput { total: number; budget: number; limit: number; sup: number; cat: number; dist: number; ownerOk: boolean }
export interface RestockOutput { decision: number; reason: number }

export function restockGuard(i: RestockInput): RestockOutput {
  u8(i.total, 'total'); u8(i.budget, 'budget'); u8(i.limit, 'limit');
  if (i.sup < 0 || i.sup > 3) throw new RangeError('sup must be 0..3');
  if (i.cat < 0 || i.cat > 7) throw new RangeError('cat must be 0..7');
  if (i.dist < 0 || i.dist > 3) throw new RangeError('dist must be 0..3');

  if (i.sup === 0b00 || i.sup === 0b11) return { decision: Decision.REJECT, reason: 1 };
  if (i.total > i.budget) return { decision: Decision.REJECT, reason: 2 };
  if (!i.ownerOk && i.total > i.limit) return { decision: Decision.ASK_OWNER, reason: 3 };
  if (!i.ownerOk && i.cat >= 6) return { decision: Decision.ASK_OWNER, reason: 4 };
  if (!i.ownerOk && i.dist === 0b11) return { decision: Decision.ASK_OWNER, reason: 5 };
  return { decision: Decision.APPROVE, reason: 0 };
}

// ---------- PickupCheck ----------
export interface PickupInput { atSupplier: boolean; ordered: number; aiCount: number; riderCount: number; damage: boolean; bonded: boolean }
export interface PickupOutput { decision: number; payQty: number; reason: number }

export function pickupCheck(i: PickupInput): PickupOutput {
  u8(i.ordered, 'ordered'); u8(i.aiCount, 'aiCount'); u8(i.riderCount, 'riderCount');
  const hold = (reason: number) => ({ decision: Decision.HOLD, payQty: 0, reason });
  if (!i.atSupplier) return hold(1);
  if (!i.bonded) return hold(2);
  if (i.damage) return hold(3);
  const payQty = Math.min(i.aiCount, i.riderCount, i.ordered);
  if (payQty === 0) return hold(4);
  if (payQty < i.ordered) return { decision: Decision.PAY_PART, payQty, reason: 5 };
  return { decision: Decision.PAY_FULL, payQty, reason: 0 };
}

// ---------- DeliveryCheck ----------
export interface DeliveryInput { atShop: boolean; picked: number; delivered: number; damage: boolean; ownerOk: boolean; ownerIssue: boolean; timeout: boolean }
export interface DeliveryOutput { decision: number; shortQty: number; reason: number }

export function deliveryCheck(i: DeliveryInput): DeliveryOutput {
  u8(i.picked, 'picked'); u8(i.delivered, 'delivered');
  const wait = (reason: number) => ({ decision: Decision.WAIT, shortQty: 0, reason });
  if (!i.atShop) return wait(1);
  if (i.damage) return wait(3);
  if (i.delivered < i.picked) return { decision: Decision.COMPENSATE, shortQty: i.picked - i.delivered, reason: 4 };
  if (i.ownerIssue) return wait(2);
  if (i.ownerOk || i.timeout) return { decision: Decision.PAY_RIDER, shortQty: 0, reason: 0 };
  return wait(5);
}

// ---------- Shared blocks (docs/CIRCUITS.md "Shared sub-circuits") ----------
// I/O layout for all three: inputs a (8 bits) then b (8 bits), LSB-first.
/** CMP8 → 1 bit: 1 iff a > b. */
export const cmp8 = (a: number, b: number) => (u8(a, 'a') > u8(b, 'b') ? 1 : 0);
/** MIN8 → 8 bits: min(a, b). */
export const min8 = (a: number, b: number) => Math.min(u8(a, 'a'), u8(b, 'b'));
/** SUB8 → 8 bits: (a − b) mod 256. Callers only use it when a ≥ b. */
export const sub8 = (a: number, b: number) => (u8(a, 'a') - u8(b, 'b')) & 0xff;

export { bit };
