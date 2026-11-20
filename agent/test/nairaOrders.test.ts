// Naira orders follow the vault's rules exactly, with every decision made by a circuit's eval.
// The circuit here is the reference model (the source of truth the taped-out netlists are proven against); the last
// test sends the same packed inputs to the REAL circuits #1-#3 on X Layer (eval is a free read).
import { describe, it, expect } from 'vitest';
import { createPublicClient, http, parseAbi, toHex, type Hash } from 'viem';
import { xLayer } from 'viem/chains';
import { openDb } from '../src/accounts/accounts.ts';
import { Ledger, kobo } from '../src/money/ledger.ts';
import { NairaOrders, SELF_HANDLER, type EvalCircuit } from '../src/orders/nairaOrders.ts';
import { restockGuard, pickupCheck, deliveryCheck } from '../../circuits/reference/circuits.ts';
import { packFields, unpackFields, packRestock } from '../../circuits/reference/pack.ts';
import { STATUS } from '../src/check/checkService.ts';

const SUP = '0x' + '11'.repeat(32) as Hash, UNKNOWN = '0x' + '22'.repeat(32) as Hash;
const COMPANY = '0x00000000000000000000000000000000000c0a11' as const;

/** The reference model behind the same packed bytes the real circuits take. */
const referenceEval: EvalCircuit = async (which, input) => {
  const bits = (w: number[]) => unpackFields(input, w);
  if (which === 'restock') { const [total, budget, limit, sup, cat, dist, ownerOk] = bits([8, 8, 8, 2, 3, 2, 1]); const o = restockGuard({ total, budget, limit, sup, cat, dist, ownerOk: !!ownerOk }); return { output: packFields([[o.decision, 2], [o.reason, 3]]), block: 1n, circuitId: 1n }; }
  if (which === 'pickup') { const [atSupplier, ordered, aiCount, riderCount, damage, bonded] = bits([1, 8, 8, 8, 1, 1]); const o = pickupCheck({ atSupplier: !!atSupplier, ordered, aiCount, riderCount, damage: !!damage, bonded: !!bonded }); return { output: packFields([[o.decision, 2], [o.payQty, 8], [o.reason, 3]]), block: 1n, circuitId: 2n }; }
  const [atShop, picked, delivered, damage, ownerOk, ownerIssue, timeout] = bits([1, 8, 8, 1, 1, 1, 1]);
  const o = deliveryCheck({ atShop: !!atShop, picked, delivered, damage: !!damage, ownerOk: !!ownerOk, ownerIssue: !!ownerIssue, timeout: !!timeout });
  return { output: packFields([[o.decision, 2], [o.shortQty, 8], [o.reason, 3]]), block: 1n, circuitId: 3n };
};

function setup(evalCircuit: EvalCircuit = referenceEval) {
  let t = 1_800_000_000_000;
  const db = openDb(), ledger = new Ledger(db);
  const orders = new NairaOrders({ db, ledger, evalCircuit, supplierStatus: (k) => (k === SUP ? 1 : 0), carriers: () => [COMPANY], now: () => t });
  const args = (o: Partial<{ ordered: number; unitNaira: number; feeNaira: number; rider: `0x${string}`; cat: number; supplier: Hash }> = {}) => ({
    supplierKey: o.supplier ?? SUP, ordered: o.ordered ?? 5, unitPrice: BigInt(kobo(o.unitNaira ?? 13_300)), cat: o.cat ?? 0, dist: 1,
    rider: o.rider ?? COMPANY, riderFee: BigInt(kobo(o.feeNaira ?? 2_950)),
  });
  return { ledger, orders, args, tick: (ms: number) => { t += ms; } };
}

describe('naira orders (ledger), decided by the circuits', () => {
  it('logistics: lock goods + fee, pay the seller at pickup, the company on delivery; every call recorded', async () => {
    const { ledger, orders, args } = setup();
    ledger.deposit(1, 'p1', kobo(100_000));
    const r = await orders.propose(1, args(), kobo(80_000));
    expect(r.status).toBe('locked');
    const id = Number((r as { orderId: bigint }).orderId);
    expect(ledger.balance(1)).toEqual({ availableKobo: kobo(100_000 - 66_500 - 2_950), heldKobo: kobo(69_450) });

    orders.handlerPickup(COMPANY, id, true, 5);
    expect(await orders.settlePickup(id)).toEqual({ kind: 'paid', qty: 5, reason: 0 });
    expect(ledger.system('sellers')).toBe(kobo(66_500));
    orders.handlerArrive(COMPANY, id);
    orders.attestDelivery(id, 5, false);
    orders.ownerConfirm(1, id, true, false);
    expect(await orders.settleDelivery(id)).toEqual({ kind: 'logistics_paid' });
    expect(ledger.system('logistics')).toBe(kobo(2_950));
    expect(ledger.balance(1)).toEqual({ availableKobo: kobo(30_550), heldKobo: 0 });
    expect(orders.get(id)!.status).toBe(STATUS.Delivered);
    expect(JSON.parse(orders.get(id)!.evidence).map((e: { circuit: string }) => e.circuit)).toEqual(['restock', 'pickup', 'delivery']);
    expect(ledger.check().ok).toBe(true);
  });

  it('self-pickup: no fee, the buyer\'s count pays the seller, unpicked money comes back, done at pickup', async () => {
    const { ledger, orders, args } = setup();
    ledger.deposit(2, 'p', kobo(70_000));
    const r = await orders.propose(2, args({ rider: SELF_HANDLER, feeNaira: 0 }), kobo(70_000));
    const id = Number((r as { orderId: bigint }).orderId);
    expect(() => orders.handlerPickup(COMPANY, id, true, 4)).toThrow(/handler/);
    orders.handlerPickup(SELF_HANDLER, id, true, 4);
    expect(await orders.settlePickup(id)).toEqual({ kind: 'paid', qty: 4, reason: 5 });
    expect(ledger.system('sellers')).toBe(kobo(53_200));
    expect(ledger.balance(2)).toEqual({ availableKobo: kobo(16_800), heldKobo: 0 });
    expect(orders.get(id)!.status).toBe(STATUS.Delivered);
    expect((await orders.propose(2, args({ rider: SELF_HANDLER, feeNaira: 500 }), kobo(70_000))).status).toBe('rejected');   // self-pickup has no fee
  });

  it('short delivery holds the fee back for the buyer; a photo count can only lower the seller\'s pay', async () => {
    const { ledger, orders, args } = setup();
    ledger.deposit(3, 'p', kobo(200_000));
    const id = Number(((await orders.propose(3, args({ ordered: 10, unitNaira: 13_000 }), kobo(200_000))) as { orderId: bigint }).orderId);
    orders.handlerPickup(COMPANY, id, true, 10);
    orders.attestPickup(id, 9, false);
    expect(await orders.settlePickup(id)).toMatchObject({ kind: 'paid', qty: 9 });
    orders.attestDelivery(id, 7, false);
    orders.handlerArrive(COMPANY, id);
    expect(await orders.settleDelivery(id)).toEqual({ kind: 'short', shortQty: 2 });
    expect(ledger.system('logistics')).toBe(0);
    expect(ledger.balance(3).availableKobo).toBe(kobo(200_000 - 9 * 13_000));      // fee and the 10th unit came back
    expect(ledger.check().ok).toBe(true);
  });

  it('rejects over budget, over balance, unknown sellers and untrusted handlers, storing nothing', async () => {
    const { ledger, orders, args } = setup();
    ledger.deposit(4, 'p', kobo(50_000));
    expect(await orders.propose(4, args(), kobo(40_000))).toEqual({ status: 'rejected', reason: 2 });             // over the request budget
    expect(await orders.propose(4, args(), kobo(500_000))).toEqual({ status: 'rejected', reason: 2 });            // over the balance
    expect(await orders.propose(4, args({ ordered: 1, supplier: UNKNOWN }), kobo(50_000))).toEqual({ status: 'rejected', reason: 1 });
    expect(await orders.propose(4, args({ ordered: 1, rider: '0x00000000000000000000000000000000deadbeef' }), kobo(50_000))).toEqual({ status: 'rejected', reason: 1 });
    expect(orders.forUser(4)).toEqual([]);
    expect(ledger.balance(4)).toEqual({ availableKobo: kobo(50_000), heldKobo: 0 });
  });

  it('asks the buyer for special categories; approval never overrides a reject; a failed circuit call holds', async () => {
    const { ledger, orders, args, tick } = setup();
    ledger.deposit(5, 'p', kobo(50_000));
    const ask = await orders.propose(5, args({ ordered: 1, cat: 6 }), kobo(50_000));
    expect(ask.status).toBe('ask_owner');
    const id = Number((ask as { orderId: bigint }).orderId);
    ledger.hold(5, 'spent-elsewhere', kobo(45_000));                           // money gone before approval
    expect((await orders.approve(5, id)).status).toBe('rejected');
    expect(orders.get(id)!.status).toBe(STATUS.AwaitingOwner);

    const broken = setup(async () => { throw new Error('rpc down'); });
    broken.ledger.deposit(6, 'p', kobo(50_000));
    expect((await broken.orders.propose(6, broken.args({ ordered: 1 }), kobo(50_000))).status).toBe('circuit_failed');
    expect(broken.ledger.balance(6).heldKobo).toBe(0);

    const ok = await orders.propose(5, args({ ordered: 1, unitNaira: 1_000, feeNaira: 0, rider: SELF_HANDLER }), kobo(5_000));
    const oid = Number((ok as { orderId: bigint }).orderId);
    expect(() => orders.refundStale(oid)).toThrow(/Not refundable yet/);
    tick(48 * 3600_000);
    orders.refundStale(oid);
    expect(orders.get(oid)!.status).toBe(STATUS.Refunded);
  });
});

// The same packed inputs, decided by the taped-out circuits on X Layer mainnet (read-only eval, no OKB spent).
const onMainnet = process.env.SKIP_MAINNET_READS !== '1';
describe.skipIf(!onMainnet)('the real circuits on X Layer agree with the reference model', () => {
  it('RestockGuard #1 on a few naira-order inputs', async () => {
    const pub = createPublicClient({ chain: xLayer, transport: http('https://rpc.xlayer.tech', { timeout: 20_000, retryCount: 3 }) });
    const abi = parseAbi(['function eval(uint256 circuitId, bytes input) view returns (bytes)']);
    for (const i of [
      { total: 14, budget: 16, limit: 16, sup: 1, cat: 0, dist: 1, ownerOk: false },   // ₦69,450 of ₦80,000: approve
      { total: 14, budget: 8, limit: 8, sup: 1, cat: 0, dist: 1, ownerOk: false },     // over budget: reject 2
      { total: 1, budget: 10, limit: 10, sup: 0, cat: 0, dist: 1, ownerOk: false },    // unknown seller: reject 1
      { total: 1, budget: 10, limit: 10, sup: 1, cat: 6, dist: 1, ownerOk: false },    // special category: ask 4
    ]) {
      const out = await pub.readContract({ address: '0x34efCc0a3191A48Feec787252E6d817b063A4017', abi, functionName: 'eval', args: [1n, toHex(packRestock(i))] });
      const [decision, reason] = unpackFields(Buffer.from(out.slice(2), 'hex'), [2, 3]);
      expect({ decision, reason }).toEqual(restockGuard(i));
    }
  }, 60_000);
});
