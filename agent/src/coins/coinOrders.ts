// Coin orders: the buyer's own StockRunVault on X Layer, owned by their connected wallet.
//
//   set up   -> StockRun deploys the vault (owner = the buyer's wallet) and pays that gas; deposits stop at the cap
//   deposit  -> the buyer's wallet signs approve + deposit (StockRun never holds the coins)
//   seller   -> the buyer's wallet signs queueSupplier(seller, approved, StockRun's payout wallet): instant, because
//               that wallet is fixed in the vault and can't be redirected
//   order    -> the agent key proposes; RestockGuard (#1) decides inside the vault and locks the goods money
//   pickup   -> the buyer's wallet signs riderPickup(count); anyone may then call settlePickup, and PickupCheck (#2)
//               pays the counted goods to StockRun's payout wallet and releases the rest
//   seller   -> StockRun owes the seller that amount in naira and pays it from its payout account (recorded here)
//
// Every money movement is the vault's, decided by a circuit, and carries a transaction hash. The AI moves nothing.
import type { DatabaseSync } from 'node:sqlite';
import { getAddress, parseAbi, parseEventLogs, type Address, type Hash } from 'viem';
import { deployVault, sendGasTopUp, tokenAbi, type Platform } from '../chain/platform.ts';
import { checkAbi, STATUS } from '../check/checkService.ts';
import { VaultClient, RESTOCK_REASONS, type ProposeResult } from '../tools/vault.ts';
import { supplierKey, haversineKm } from '../tools/suppliers.ts';
import { CATEGORIES, distBucket, type Category } from '../types.ts';
import { AuthError, type User } from '../accounts/accounts.ts';
import type { FoundSeller } from '../discovery/hunt.ts';

export const coinVaultAbi = parseAbi([
  'function locked() view returns (uint256)', 'function maxBalance() view returns (uint256)', 'function owner() view returns (address)',
  'function supplierStatus(bytes32) view returns (uint8)', 'function supplierPayout(bytes32) view returns (address)',
  'function defaultPayout() view returns (address)', 'function weeklyBudget() view returns (uint256)', 'function spentThisWeek() view returns (uint256)',
  'function settlePickup(uint256 id)',
  'event SupplierPaid(uint256 indexed id, address payout, uint8 qty, uint256 amount, uint8 reason)',
  'event PickupHeld(uint256 indexed id, uint8 reason)',
  'error NotAuthorized()', 'error BadStatus()', 'error CircuitFailed()',
]);

const STATUS_NAME = ['None', 'AwaitingOwner', 'Locked', 'PickedUp', 'Delivered', 'Refunded'] as const;

export interface ParsedDeal {
  s: FoundSeller; item: string; unit: string; quantity: number; price: number; category: Category;
  lat: number; lng: number; address: string;
}
export type CoinDealResult =
  | { status: 'needs_seller'; seller: { key: Hash; name: string }; payout: Address; message: string }
  | { status: ProposeResult['status']; orderId?: string; reason?: number; tx?: Hash; message: string };

interface Row {
  user_id: number; vault: string; order_id: number; seller_id: string; seller_name: string; item: string; unit: string; quantity: number;
  lat: number; lng: number; address: string; propose_tx: string; settle_tx: string | null; seller_owed_naira: number; seller_paid_at: number | null; created_at: number;
}

export class CoinOrders {
  private db: DatabaseSync; private p: Platform; private capTokens: bigint; private now: () => number; private log: (s: string) => void;
  constructor(o: { db: DatabaseSync; platform: Platform; capTokens: bigint; now?: () => number; log?: (s: string) => void }) {
    this.db = o.db; this.p = o.platform; this.capTokens = o.capTokens; this.now = o.now ?? Date.now; this.log = o.log ?? (() => {});
    if (o.capTokens <= 0n) throw new Error('coin vaults need a deposit cap');
    o.db.exec(`CREATE TABLE IF NOT EXISTS coin_vaults (user_id INTEGER PRIMARY KEY, vault TEXT NOT NULL, owner TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    o.db.exec(`CREATE TABLE IF NOT EXISTS coin_orders (
      user_id INTEGER NOT NULL, vault TEXT NOT NULL, order_id INTEGER NOT NULL, seller_id TEXT NOT NULL, seller_name TEXT NOT NULL,
      item TEXT NOT NULL, unit TEXT NOT NULL, quantity INTEGER NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, address TEXT NOT NULL,
      propose_tx TEXT NOT NULL, settle_tx TEXT, seller_owed_naira INTEGER NOT NULL DEFAULT 0, seller_paid_at INTEGER,
      created_at INTEGER NOT NULL, PRIMARY KEY (vault, order_id))`);
  }

  get cap() { return { tokens: this.capTokens, naira: this.p.money.toNaira(this.capTokens) }; }
  vaultOf(userId: number): { vault: Address; owner: Address } | null {
    const r = this.db.prepare('SELECT vault, owner FROM coin_vaults WHERE user_id = ?').get(userId) as unknown as { vault: Address; owner: Address } | undefined;
    return r ?? null;
  }
  private need(user: User) {
    if (!user.wallet) throw new AuthError(409, 'Connect a wallet in Me first.');
    const v = this.vaultOf(user.id);
    if (!v) throw new AuthError(409, 'Set up your coin account first (Money → Coins).');
    if (v.owner.toLowerCase() !== user.wallet.toLowerCase()) throw new AuthError(409, `Your coin account belongs to wallet ${v.owner}. Connect that wallet to use it.`);
    return v;
  }

  /** Deploy the buyer's vault, owned by their wallet. StockRun pays the gas and tops the wallet up once so it can sign. */
  async setUp(user: User): Promise<{ vault: Address; created: boolean; gasTopUpTx: Hash | null }> {
    if (!user.wallet) throw new AuthError(409, 'Connect a wallet in Me first.');
    const have = this.vaultOf(user.id);
    if (have) return { vault: have.vault, created: false, gasTopUpTx: null };
    // Weekly budget and auto-approve limit = the cap: one vault can't spend more than it may hold in a week.
    const capNaira = this.cap.naira;
    const vault = await deployVault(this.p, user.wallet, capNaira, capNaira, [], this.capTokens);
    this.db.prepare('INSERT INTO coin_vaults (user_id, vault, owner, created_at) VALUES (?, ?, ?, ?)').run(user.id, vault, getAddress(user.wallet), this.now());
    this.log(`coin vault ${vault} for user ${user.id} (owner ${user.wallet})`);
    const gasTopUpTx = await sendGasTopUp(this.p, user.wallet).catch((e) => { this.log(`gas top-up for ${user.wallet}: ${(e as Error).message}`); return null; });
    return { vault, created: true, gasTopUpTx };
  }

  /** What the Money tab shows: the vault's balances, read from the chain. */
  async status(user: User) {
    const v = user.wallet ? this.vaultOf(user.id) : null;
    if (!v) return null;
    const read = <T>(functionName: 'locked' | 'spentThisWeek' | 'weeklyBudget') => this.p.pub.readContract({ address: v.vault, abi: coinVaultAbi, functionName }) as Promise<T>;
    const [balance, locked, spent, budget] = await Promise.all([
      this.p.pub.readContract({ address: this.p.token, abi: tokenAbi, functionName: 'balanceOf', args: [v.vault] }),
      read<bigint>('locked'), read<bigint>('spentThisWeek'), read<bigint>('weeklyBudget'),
    ]);
    const usd = (x: bigint) => Number(x) / 1e6;
    return {
      vault: v.vault, owner: v.owner, payout: this.p.supplierPayout, token: this.p.token, symbol: this.p.tokenSymbol,
      balance: usd(balance), locked: usd(locked), free: usd(balance - locked), cap: usd(this.capTokens),
      room: usd(this.capTokens > balance ? this.capTokens - balance : 0n),
      spentThisWeek: usd(spent), weeklyBudget: usd(budget),
      naira: { balance: this.p.money.toNaira(balance), free: this.p.money.toNaira(balance - locked) },
    };
  }

  /**
   * A deal paid with coins (self-pickup: the buyer's wallet is the handler). If the seller is not approved in the vault
   * yet, nothing is proposed: the app asks the wallet to approve them (instant through StockRun's payout wallet).
   */
  async recordDeal(user: User, d: ParsedDeal): Promise<CoinDealResult> {
    const v = this.need(user);
    const key = supplierKey(d.s.id) as Hash;
    const status = await this.p.pub.readContract({ address: v.vault, abi: coinVaultAbi, functionName: 'supplierStatus', args: [key] });
    if (status === 3) throw new AuthError(409, 'You blocked this seller in your coin account.');
    if (status !== 1 && status !== 2) {
      return { status: 'needs_seller', seller: { key, name: d.s.name }, payout: this.p.supplierPayout,
        message: `Approve ${d.s.name} in your wallet first. Their payment goes to StockRun's payout wallet, which pays them in naira.` };
    }
    const km = haversineKm({ lat: d.lat, lng: d.lng }, d.s);
    const unitPrice = this.p.money.toToken(d.price);
    if (unitPrice <= 0n) throw new AuthError(400, 'That price is too small to pay in coins.');
    const result = await new VaultClient(v.vault, this.p.pub, this.p.agent).propose({
      supplierKey: key, ordered: d.quantity, unitPrice, cat: CATEGORIES[d.category], dist: distBucket(km), rider: user.wallet!,
    });
    const what = `${d.quantity} ${d.unit}(s) of ${d.item} from ${d.s.name} at ₦${d.price.toLocaleString('en-NG')} each, paid in ${this.p.tokenSymbol}`;
    if (result.status === 'locked' || result.status === 'ask_owner') {
      this.db.prepare(`INSERT INTO coin_orders (user_id, vault, order_id, seller_id, seller_name, item, unit, quantity, lat, lng, address, propose_tx, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, v.vault, Number(result.orderId), d.s.id, d.s.name, d.item, d.unit, d.quantity, d.lat, d.lng, d.address, result.txHash, this.now());
      const orderId = `coin-${result.orderId}`;
      if (result.status === 'locked') return { status: 'locked', orderId, tx: result.txHash, message: `✓ ${what}. RestockGuard approved it inside your vault; the coins are locked (tx ${result.txHash}). ${d.s.name} is paid only when you count the goods at pickup.` };
      return { status: 'ask_owner', orderId, tx: result.txHash, reason: result.reason, message: `? ${what}. RestockGuard wants your OK because ${RESTOCK_REASONS[result.reason] ?? `reason ${result.reason}`}. Approve it from your wallet in Orders.` };
    }
    if (result.status === 'rejected') return { status: 'rejected', reason: result.reason, message: `✗ ${what}. RestockGuard rejected it: ${RESTOCK_REASONS[result.reason] ?? `reason ${result.reason}`}. Nothing was locked.` };
    if (result.status === 'too_large') return { status: 'too_large', message: `✗ ${what}. Too large for one order; split it.` };
    return { status: 'circuit_failed', message: `✗ ${what}. The circuit check failed, so nothing was locked. Try again.` };
  }

  private row(userId: number, orderId: number): Row {
    const v = this.vaultOf(userId);
    const r = v && this.db.prepare('SELECT * FROM coin_orders WHERE vault = ? AND order_id = ? AND user_id = ?').get(v.vault, orderId, userId) as unknown as Row | undefined;
    if (!r) throw new AuthError(404, 'No such order.');
    return r;
  }

  /**
   * After the buyer's wallet signed riderPickup (their count at the seller), run PickupCheck through the vault. The
   * check-service key pays the gas; anyone may call settlePickup, and the vault builds every input itself.
   */
  async settlePickup(user: User, orderId: number) {
    const v = this.need(user), r = this.row(user.id, orderId);
    const o = await this.p.pub.readContract({ address: v.vault, abi: checkAbi, functionName: 'orders', args: [BigInt(orderId)] });
    if (o[7] !== STATUS.Locked) throw new AuthError(409, 'This order is not waiting for pickup.');
    if (!o[10]) throw new AuthError(409, 'Confirm your count from your wallet first.');
    const { request } = await this.p.pub.simulateContract({ address: v.vault, abi: coinVaultAbi, functionName: 'settlePickup', args: [BigInt(orderId)], account: this.p.checker.account });
    const tx = await this.p.checker.writeContract(request);
    const receipt = await this.p.pub.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== 'success') throw new AuthError(502, `PickupCheck's transaction failed (${tx}). The order holds; nothing was paid.`);
    for (const l of parseEventLogs({ abi: coinVaultAbi, logs: receipt.logs })) {
      if (l.eventName === 'SupplierPaid') {
        const owed = this.p.money.toNaira(l.args.amount);
        this.db.prepare('UPDATE coin_orders SET settle_tx = ?, seller_owed_naira = ? WHERE vault = ? AND order_id = ?').run(tx, owed, v.vault, orderId);
        this.log(`coin order ${v.vault}#${orderId}: ${l.args.qty} paid to payout wallet (${tx}); StockRun owes ${r.seller_name} ₦${owed}`);
        return { status: 'settled' as const, outcome: l.args.qty < r.quantity ? 'paid_part' as const : 'paid' as const, qty: l.args.qty, reason: l.args.reason, tx };
      }
      if (l.eventName === 'PickupHeld') return { status: 'settled' as const, outcome: 'held' as const, qty: 0, reason: l.args.reason, tx };
    }
    throw new AuthError(502, 'PickupCheck gave no result; the order holds.');
  }

  /** The buyer's coin orders, read from their vault, in the same shape as naira orders (money: 'coins'). */
  async list(user: User) {
    const v = user.wallet ? this.vaultOf(user.id) : null;
    if (!v) return [];
    const rows = this.db.prepare('SELECT * FROM coin_orders WHERE vault = ? AND user_id = ? ORDER BY created_at DESC').all(v.vault, user.id) as unknown as Row[];
    return Promise.all(rows.map(async (r) => {
      const o = await this.p.pub.readContract({ address: v.vault, abi: checkAbi, functionName: 'orders', args: [BigInt(r.order_id)] });
      return {
        orderId: `coin-${r.order_id}`, coinOrderId: r.order_id, money: 'coins' as const, self: true, vault: v.vault,
        item: r.item, unit: r.unit, quantity: r.quantity, createdAt: r.created_at,
        supplier: { name: r.seller_name, lat: 0, lng: 0 }, shop: { name: r.address, lat: r.lat, lng: r.lng },
        status: STATUS_NAME[o[7]] ?? 'None', ordered: o[3], unitPriceNaira: this.p.money.toNaira(o[6]), courierFeeNaira: null,
        unitPriceToken: Number(o[6]) / 1e6, tokenSymbol: this.p.tokenSymbol,
        pickup: { picked: o[15], riderCount: o[11], riderCounted: o[10] },
        delivery: { delivered: o[19], aiCounted: o[18], ownerOk: o[21] },
        evidence: [], lastCheck: null,
        txs: [{ label: 'RestockGuard locked it', hash: r.propose_tx }, ...(r.settle_tx ? [{ label: 'PickupCheck paid', hash: r.settle_tx }] : [])],
        sellerOwedNaira: r.seller_owed_naira, sellerPaidAt: r.seller_paid_at,
      };
    }));
  }

  /** Admin: coin pickups whose seller still needs their naira from StockRun's payout account. */
  owedSellers() {
    return this.db.prepare('SELECT * FROM coin_orders WHERE seller_owed_naira > 0 AND seller_paid_at IS NULL ORDER BY created_at').all() as unknown as Row[];
  }
  /** Admin: the seller was paid their naira (by hand, while Paystack can't send transfers). */
  markSellerPaid(vault: string, orderId: number) {
    const r = this.db.prepare('UPDATE coin_orders SET seller_paid_at = ? WHERE lower(vault) = lower(?) AND order_id = ? AND seller_owed_naira > 0 AND seller_paid_at IS NULL').run(this.now(), vault, orderId);
    if (!r.changes) throw new AuthError(404, 'Nothing owed on that order.');
  }
}
