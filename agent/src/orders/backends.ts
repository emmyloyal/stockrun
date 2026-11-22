// One interface for the two places an order's money can be: a person's vault on X Layer (coins) or StockRun's naira
// ledger. The agent proposes through it; the dispatcher turns logistics status into pickup/delivery steps through it.
// Either way, every payment decision is a circuit's.
import { parseAbi, type Address, type Hash, type PublicClient } from 'viem';
import { checkAbi, type CheckService } from '../check/checkService.ts';
import type { ProposeArgs, ProposeResult } from '../tools/vault.ts';
import type { Wallet } from '../chain/platform.ts';
import type { Money } from '../chain/money.ts';
import { NairaOrders } from './nairaOrders.ts';

/** What the agent needs to place an order. VaultClient already has this shape. */
export interface ProposeTarget {
  supplierStatus(key: Hash): Promise<number | bigint>;
  trustedHandler(who: Address): Promise<boolean>;
  propose(a: ProposeArgs): Promise<ProposeResult>;
}

export interface OrderState { status: number; ordered: number; picked: number }
export type Settled = { outcome: 'paid' | 'paid_part' | 'held' | 'delivered' | 'short'; qty: number; reason: number; tx: string };

/** What the dispatcher needs to move an order along. `handler` is the logistics company's desk key. */
export interface OrderBackend {
  readonly kind: 'coins' | 'naira';
  order(id: string): Promise<OrderState>;
  handlerPickup(handler: Wallet, id: string, count: number): Promise<void>;
  handlerArrive(handler: Wallet, id: string): Promise<void>;
  settlePickup(id: string): Promise<Settled>;
  /** The buyer's count at the door, recorded as the delivery count. */
  deliveredCount(id: string, count: number): Promise<string>;
  settleDelivery(id: string): Promise<Settled>;
}

// ---------------------------------------------------------------- coins: the person's vault on X Layer
const handlerAbi = parseAbi(['function riderPickup(uint256 id, bool atSupplier, uint8 riderCount)', 'function riderArrive(uint256 id, bool atShop)']);

export class VaultBackend implements OrderBackend {
  readonly kind = 'coins' as const;
  private vault: Address; private pub: PublicClient; private settler: CheckService; private money: Money;
  constructor(vault: Address, pub: PublicClient, settler: CheckService, money: Money) { this.vault = vault; this.pub = pub; this.settler = settler; this.money = money; }
  async order(id: string): Promise<OrderState> {
    const o = await this.pub.readContract({ address: this.vault, abi: checkAbi, functionName: 'orders', args: [BigInt(id)] });
    return { status: Number(o[7]), ordered: Number(o[3]), picked: Number(o[15]) };
  }
  private async sign(w: Wallet, functionName: 'riderPickup' | 'riderArrive', args: readonly unknown[]) {
    const { request } = await this.pub.simulateContract({ address: this.vault, abi: handlerAbi, functionName, args: args as never, account: w.account });
    const hash = await w.writeContract(request as never);
    if ((await this.pub.waitForTransactionReceipt({ hash })).status !== 'success') throw new Error(`${functionName} failed`);
  }
  handlerPickup(w: Wallet, id: string, count: number) { return this.sign(w, 'riderPickup', [BigInt(id), true, count]); }
  handlerArrive(w: Wallet, id: string) { return this.sign(w, 'riderArrive', [BigInt(id), true]); }
  async settlePickup(id: string): Promise<Settled> { const r = await this.settler.settle(BigInt(id), 'pickup'); return { outcome: r.outcome, qty: r.qty, reason: r.reason, tx: r.settleTx }; }
  deliveredCount(id: string, count: number) { return this.settler.attestCount(BigInt(id), 'delivery', count); }
  async settleDelivery(id: string): Promise<Settled> { const r = await this.settler.settle(BigInt(id), 'delivery'); return { outcome: r.outcome, qty: r.qty, reason: r.reason, tx: r.settleTx }; }
}

// ---------------------------------------------------------------- naira: StockRun's ledger, decided by eval
/** One person's naira orders: proposes with their request budget; moves orders along for the dispatcher. */
export class NairaBackend implements OrderBackend, ProposeTarget {
  readonly kind = 'naira' as const;
  /** Budget for the request being placed (whole kobo); set by the caller before the agent runs. */
  budgetKobo = 0;
  private orders: NairaOrders; private userId: number; private sellerStatus: (key: Hash) => number;
  constructor(orders: NairaOrders, userId: number, sellerStatus: (key: Hash) => number) { this.orders = orders; this.userId = userId; this.sellerStatus = sellerStatus; }
  async supplierStatus(key: Hash) { return this.sellerStatus(key); }
  async trustedHandler(who: Address) { return this.orders.trusted(who); }
  propose(a: ProposeArgs) { return this.orders.propose(this.userId, a, this.budgetKobo); }

  private mine(id: string) { const o = this.orders.get(id); if (!o || o.user_id !== this.userId) throw new Error('No such order.'); return o; }
  async order(id: string): Promise<OrderState> { const o = this.mine(id); return { status: o.status, ordered: o.ordered, picked: o.picked }; }
  async handlerPickup(w: Wallet, id: string, count: number) { this.mine(id); this.orders.handlerPickup(w.account.address, Number(id), true, count); }
  async handlerArrive(w: Wallet, id: string) { this.mine(id); this.orders.handlerArrive(w.account.address, Number(id)); }
  async settlePickup(id: string): Promise<Settled> {
    const o = this.mine(id), r = await this.orders.settlePickup(Number(id));
    if (r.kind === 'held') return { outcome: 'held', qty: 0, reason: r.reason, tx: `ledger:${id}` };
    if (r.kind !== 'paid') throw new Error('unexpected pickup result');
    return { outcome: r.qty < o.ordered ? 'paid_part' : 'paid', qty: r.qty, reason: r.reason, tx: `ledger:${id}` };
  }
  async deliveredCount(id: string, count: number) {
    this.mine(id);
    this.orders.attestDelivery(Number(id), count, false);
    this.orders.ownerConfirm(this.userId, Number(id), count === this.orders.get(id)!.picked, false);
    return `ledger:${id}`;
  }
  async settleDelivery(id: string): Promise<Settled> {
    this.mine(id);
    const r = await this.orders.settleDelivery(Number(id));
    if (r.kind === 'held') return { outcome: 'held', qty: 0, reason: r.reason, tx: `ledger:${id}` };
    if (r.kind === 'short') return { outcome: 'short', qty: r.shortQty, reason: 4, tx: `ledger:${id}` };
    return { outcome: 'delivered', qty: 0, reason: 0, tx: `ledger:${id}` };
  }
}
