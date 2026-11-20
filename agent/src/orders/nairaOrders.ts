// Orders paid in naira from StockRun's ledger. The same rules as StockRunVault.sol, step for step, with the ledger
// in place of the vault's token balance:
//   propose -> RestockGuard (#1) decides: lock goods + delivery fee, ask the buyer, or reject (nothing stored)
//   pickup  -> PickupCheck (#2) decides how much the seller is paid; the rest goes back to the buyer
//   delivery-> DeliveryCheck (#3) decides: pay the logistics fee, hold it back for the buyer (goods short), or wait
// Every decision is the circuit's: inputs are built here from stored order state (never from the caller), packed
// exactly as the vault packs them (circuits/reference/pack.ts), and sent to the circuit's `eval` on X Layer. The
// call, its block, input and output are kept on the order so anyone can re-run it. If the call fails, the order holds.
import type { DatabaseSync } from 'node:sqlite';
import { getAddress, toHex, type Address, type Hash } from 'viem';
import { packDelivery, packPickup, packRestock, unpackFields, RESTOCK_OUT, PICKUP_OUT, DELIVERY_OUT } from '../../../circuits/reference/pack.ts';
import type { Ledger } from '../money/ledger.ts';
import type { ProposeArgs, ProposeResult } from '../tools/vault.ts';
import { STATUS } from '../check/checkService.ts';

/** Self-pickup handler for naira orders (the buyer is identified by their session, not a key). */
export const SELF_HANDLER: Address = getAddress('0x0000000000000000000000000000000000005e1f');
const isSelf = (a: string) => a.toLowerCase() === SELF_HANDLER.toLowerCase();
export const UNIT_KOBO = 500_000n;               // circuit money unit: ₦5,000
export const PICKUP_TIMEOUT_MS = 48 * 3600_000;
export const OWNER_TIMEOUT_MS = 24 * 3600_000;

/** One circuit call on X Layer: returns the output bytes and the block it was evaluated at. */
export type EvalCircuit = (which: 'restock' | 'pickup' | 'delivery', input: Uint8Array) => Promise<{ output: Uint8Array; block: bigint; circuitId: bigint }>;
export interface Evidence { circuit: string; circuitId: string; block: string; input: string; output: string; at: number }

export function migrateNairaOrders(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS naira_orders (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, supplier_key TEXT NOT NULL, rider TEXT NOT NULL,
    ordered INTEGER NOT NULL, cat INTEGER NOT NULL, dist INTEGER NOT NULL, unit_price INTEGER NOT NULL, rider_fee INTEGER NOT NULL,
    budget INTEGER NOT NULL, status INTEGER NOT NULL, created_at INTEGER NOT NULL,
    at_supplier INTEGER NOT NULL DEFAULT 0, rider_counted INTEGER NOT NULL DEFAULT 0, rider_count INTEGER NOT NULL DEFAULT 0,
    ai_counted INTEGER NOT NULL DEFAULT 0, ai_count INTEGER NOT NULL DEFAULT 0, pickup_damage INTEGER NOT NULL DEFAULT 0, picked INTEGER NOT NULL DEFAULT 0,
    at_shop INTEGER NOT NULL DEFAULT 0, arrived_at INTEGER NOT NULL DEFAULT 0, ai_delivered INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
    delivery_damage INTEGER NOT NULL DEFAULT 0, owner_ok INTEGER NOT NULL DEFAULT 0, owner_issue INTEGER NOT NULL DEFAULT 0,
    evidence TEXT NOT NULL DEFAULT '[]')`);
}

interface Row {
  id: number; user_id: number; supplier_key: string; rider: string; ordered: number; cat: number; dist: number; unit_price: number; rider_fee: number;
  budget: number; status: number; created_at: number; at_supplier: number; rider_counted: number; rider_count: number; ai_counted: number; ai_count: number;
  pickup_damage: number; picked: number; at_shop: number; arrived_at: number; ai_delivered: number; delivered: number; delivery_damage: number;
  owner_ok: number; owner_issue: number; evidence: string;
}
export type NairaOrder = Row;
export type SettleOutcome =
  | { kind: 'held'; reason: number }
  | { kind: 'paid'; qty: number; reason: number }                     // pickup: seller paid for qty
  | { kind: 'logistics_paid' } | { kind: 'short'; shortQty: number };   // delivery

export class NairaOrders {
  private db: DatabaseSync; private ledger: Ledger; private evalCircuit: EvalCircuit;
  private supplierStatusOf: (key: Hash) => number; private carriers: () => Address[]; private now: () => number;
  constructor(o: { db: DatabaseSync; ledger: Ledger; evalCircuit: EvalCircuit; supplierStatus: (key: Hash) => number; carriers: () => Address[]; now?: () => number }) {
    this.db = o.db; this.ledger = o.ledger; this.evalCircuit = o.evalCircuit; this.supplierStatusOf = o.supplierStatus;
    this.carriers = o.carriers; this.now = o.now ?? Date.now;
    migrateNairaOrders(o.db);
  }

  get(id: number | bigint | string): Row | null { return (this.db.prepare('SELECT * FROM naira_orders WHERE id = ?').get(Number(id)) as unknown as Row | undefined) ?? null; }
  forUser(userId: number): Row[] { return this.db.prepare('SELECT * FROM naira_orders WHERE user_id = ? ORDER BY id DESC').all(userId) as unknown as Row[]; }
  trusted(h: string): boolean { return isSelf(h) || this.carriers().some((c) => c.toLowerCase() === h.toLowerCase()); }

  private set(id: number, fields: Partial<Row>) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE naira_orders SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => (fields as Record<string, number | string>)[k]), id);
  }
  private async decide(o: Row | null, which: 'restock' | 'pickup' | 'delivery', input: Uint8Array, widths: number[]): Promise<number[]> {
    const r = await this.evalCircuit(which, input);     // throws on any failure: the caller's order holds
    const vals = unpackFields(r.output, widths);
    if (o) {
      const ev: Evidence[] = JSON.parse(this.get(o.id)!.evidence);
      ev.push({ circuit: which, circuitId: String(r.circuitId), block: String(r.block), input: toHex(input), output: toHex(r.output), at: this.now() });
      this.set(o.id, { evidence: JSON.stringify(ev) });
    }
    return vals;
  }
  private value(o: Row) { return o.ordered * o.unit_price; }
  private units(kobo: number, up: boolean) { const u = up ? (BigInt(kobo) + UNIT_KOBO - 1n) / UNIT_KOBO : BigInt(kobo) / UNIT_KOBO; return Number(u > 255n && !up ? 255n : u); }

  // ---------------------------------------------------------------- 1. propose -> RestockGuard
  /** Agent proposes (the AI never moves money). `budgetKobo` is the buyer's budget for this request. */
  async propose(userId: number, a: ProposeArgs, budgetKobo: number): Promise<ProposeResult> {
    if (!this.trusted(a.rider)) return { status: 'rejected', reason: 1 };
    if (isSelf(a.rider) && a.riderFee !== 0n) return { status: 'rejected', reason: 1 };
    const id = Number(this.db.prepare(`INSERT INTO naira_orders (user_id, supplier_key, rider, ordered, cat, dist, unit_price, rider_fee, budget, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, a.supplierKey, getAddress(a.rider), a.ordered, a.cat, a.dist, Number(a.unitPrice), Number(a.riderFee), budgetKobo, STATUS.None, this.now()).lastInsertRowid);
    const r = await this.guard(id, false).catch(() => ({ status: 'circuit_failed' as const }));
    if (r.status !== 'locked' && r.status !== 'ask_owner') this.db.prepare('DELETE FROM naira_orders WHERE id = ?').run(id);   // REJECT: nothing stored
    return r;
  }

  /** The buyer approves an "ask" order. Never overrides a reject (the circuit runs again with ownerOk). */
  async approve(userId: number, id: number): Promise<ProposeResult> {
    const o = this.get(id);
    if (!o || o.user_id !== userId || o.status !== STATUS.AwaitingOwner) throw new Error('This order is not waiting for your OK.');
    return this.guard(id, true);
  }

  private async guard(id: number, ownerOk: boolean): Promise<ProposeResult> {
    const o = this.get(id)!;
    const amount = this.value(o) + o.rider_fee;
    const remaining = Math.min(o.budget, this.ledger.balance(o.user_id).availableKobo);
    const totalUnits = this.units(amount, true);
    if (totalUnits > 255) return { status: 'too_large' };
    const input = packRestock({ total: totalUnits, budget: this.units(remaining, false), limit: this.units(o.budget, false),
      sup: this.supplierStatusOf(o.supplier_key as Hash), cat: o.cat, dist: o.dist, ownerOk });
    const [decision, reason] = await this.decide(o, 'restock', input, RESTOCK_OUT);
    const tx = `ledger:${id}` as Hash;
    if (decision === 0) return { status: 'rejected', reason };
    if (decision === 1) { this.set(id, { status: STATUS.AwaitingOwner }); return { status: 'ask_owner', orderId: BigInt(id), txHash: tx, reason }; }
    if (decision === 2) {
      this.ledger.hold(o.user_id, `order:${id}`, amount);      // throws if the money is not there: nothing is locked
      this.set(id, { status: STATUS.Locked });
      return { status: 'locked', orderId: BigInt(id), txHash: tx, reason: 0 };
    }
    return { status: 'circuit_failed' };
  }

  // ---------------------------------------------------------------- 2. pickup -> PickupCheck
  /** The handler's count at the seller: the buyer (self-pickup, by session) or the logistics company's desk. */
  handlerPickup(handler: Address, id: number, atSupplier: boolean, count: number) {
    const o = this.get(id);
    if (!o || o.rider.toLowerCase() !== handler.toLowerCase()) throw new Error('Only the order\'s handler can confirm the pickup.');
    if (o.status !== STATUS.Locked) throw new Error('The order is not waiting for pickup.');
    if (!Number.isInteger(count) || count < 0 || count > 255) throw new Error('Count from 0 to 255.');
    this.set(id, { at_supplier: atSupplier ? 1 : 0, rider_count: count, rider_counted: 1 });
  }
  /** A photo count (check service). Can only lower what the seller is paid. */
  attestPickup(id: number, count: number, damage: boolean) {
    const o = this.get(id);
    if (!o || o.status !== STATUS.Locked) throw new Error('The order is not waiting for pickup.');
    this.set(id, { ai_count: count, pickup_damage: damage ? 1 : 0, ai_counted: 1 });
  }

  async settlePickup(id: number): Promise<SettleOutcome> {
    const o = this.get(id);
    if (!o || o.status !== STATUS.Locked || !o.rider_counted) throw new Error('Not ready to settle the pickup.');
    const photo = o.ai_counted ? o.ai_count : o.rider_count;
    const input = packPickup({ atSupplier: !!o.at_supplier, ordered: o.ordered, aiCount: photo, riderCount: o.rider_count, damage: !!o.pickup_damage, bonded: this.trusted(o.rider) });
    const [decision, qty, reason] = await this.decide(o, 'pickup', input, PICKUP_OUT);
    if (decision === 0) return { kind: 'held', reason };
    if (qty === 0 || qty > o.ordered) throw new Error('The circuit returned an impossible quantity; the order holds.');
    const pay = qty * o.unit_price, unused = this.value(o) - pay;
    this.ledger.paySeller(o.user_id, `order:${id}`, pay);
    if (unused > 0) this.ledger.release(o.user_id, `order:${id}:unpicked`, unused);
    const self = isSelf(o.rider);
    this.set(id, { picked: qty, status: self ? STATUS.Delivered : STATUS.PickedUp });
    return { kind: 'paid', qty, reason };
  }

  // ---------------------------------------------------------------- 3. delivery -> DeliveryCheck
  handlerArrive(handler: Address, id: number) {
    const o = this.get(id);
    if (!o || o.rider.toLowerCase() !== handler.toLowerCase()) throw new Error('Only the order\'s handler can mark arrival.');
    if (o.status !== STATUS.PickedUp) throw new Error('The goods are not on their way.');
    this.set(id, { at_shop: 1, arrived_at: o.arrived_at || this.now() });
  }
  /** The buyer's count at the door (attested by the check service) or a photo count. */
  attestDelivery(id: number, delivered: number, damage: boolean) {
    const o = this.get(id);
    if (!o || o.status !== STATUS.PickedUp) throw new Error('The goods are not on their way.');
    if (!Number.isInteger(delivered) || delivered < 0 || delivered > o.picked) throw new Error(`Count from 0 to ${o.picked}.`);
    this.set(id, { delivered, delivery_damage: damage ? 1 : 0, ai_delivered: 1 });
  }
  ownerConfirm(userId: number, id: number, ok: boolean, issue: boolean) {
    const o = this.get(id);
    if (!o || o.user_id !== userId || o.status !== STATUS.PickedUp) throw new Error('This order is not waiting for your confirmation.');
    this.set(id, { owner_ok: ok ? 1 : 0, owner_issue: issue ? 1 : 0 });
  }

  async settleDelivery(id: number): Promise<SettleOutcome> {
    const o = this.get(id);
    if (!o || o.status !== STATUS.PickedUp || !o.ai_delivered) throw new Error('Not ready to settle the delivery.');
    const timeout = o.arrived_at !== 0 && this.now() >= o.arrived_at + OWNER_TIMEOUT_MS;
    const input = packDelivery({ atShop: !!o.at_shop, picked: o.picked, delivered: o.delivered, damage: !!o.delivery_damage, ownerOk: !!o.owner_ok, ownerIssue: !!o.owner_issue, timeout });
    const [decision, shortQty, reason] = await this.decide(o, 'delivery', input, DELIVERY_OUT);
    if (decision === 0) return { kind: 'held', reason };
    if (decision === 2) {
      if (o.rider_fee > 0) this.ledger.payLogistics(o.user_id, `order:${id}`, o.rider_fee);
      this.set(id, { status: STATUS.Delivered });
      return { kind: 'logistics_paid' };
    }
    if (decision === 1) {
      if (shortQty === 0 || shortQty > o.picked) throw new Error('The circuit returned an impossible quantity; the order holds.');
      if (o.rider_fee > 0) this.ledger.release(o.user_id, `order:${id}:fee-withheld`, o.rider_fee);
      this.set(id, { status: STATUS.Delivered });
      return { kind: 'short', shortQty };
    }
    throw new Error('Unknown circuit decision; the order holds.');
  }

  /** An order whose pickup never happened: everything goes back to the buyer after 48 h. */
  refundStale(id: number) {
    const o = this.get(id);
    if (!o || o.status !== STATUS.Locked || this.now() < o.created_at + PICKUP_TIMEOUT_MS) throw new Error('Not refundable yet.');
    this.ledger.release(o.user_id, `order:${id}:stale`, this.value(o) + o.rider_fee);
    this.set(id, { status: STATUS.Refunded });
  }
}
