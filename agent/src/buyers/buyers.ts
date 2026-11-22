// Buyers and their requests. Anyone in Nigeria types what they want, a budget and where it should go; the agent
// finds verified sellers near that place on the map, negotiates on WhatsApp, and places the order. Money comes from
// the buyer's naira balance (StockRun's ledger) - coins from a connected wallet use the buyer's own vault.
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Address, Hash } from 'viem';
import { handleOrder, type AgentDeps, type DeliveryChoice } from '../agent.ts';
import { JobStore } from '../check/jobs.ts';
import { fixedRate } from '../chain/money.ts';
import type { Platform } from '../chain/platform.ts';
import type { Extractor } from '../llm.ts';
import type { SupplierChannel } from '../tools/negotiate.ts';
import type { PriceBook } from '../prices/priceBook.ts';
import { loadSuppliers, supplierKey } from '../tools/suppliers.ts';
import { CATEGORIES, distBucket, type Category, type OrderLine, type Rider, type Supplier } from '../types.ts';
import { RESTOCK_REASONS } from '../tools/vault.ts';
import { foundSeller } from '../discovery/hunt.ts';
import { haversineKm } from '../tools/suppliers.ts';
import { Dispatcher, type DispatchShop } from '../logistics/dispatch.ts';
import type { DeliveryJob } from '../logistics/carrier.ts';
import type { Ledger } from '../money/ledger.ts';
import { kobo } from '../money/ledger.ts';
import { NairaBackend } from '../orders/backends.ts';
import { NairaOrders, SELF_HANDLER } from '../orders/nairaOrders.ts';
import type { User } from '../accounts/accounts.ts';
import { AuthError, normalisePhone } from '../accounts/accounts.ts';

/** Nigeria (with a little margin): rejects pins dropped by mistake far away (and 0,0). */
export const IN_NIGERIA = (lat: number, lng: number) => lat > 4.0 && lat < 14.0 && lng > 2.6 && lng < 14.7;
export const MAX_BUDGET_NAIRA = 1_275_000;      // the circuits count money in 8 bits of ₦5,000

export interface Place { lat: number; lng: number; address: string }
export interface RequestInput { text: string; budgetNaira: number; place: Place; delivery: DeliveryChoice; contactPhone?: string }
export interface RequestRecord { id: number; text: string; budgetNaira: number; place: Place; delivery: DeliveryChoice; message: string; createdAt: number }

export interface BuyerServices {
  extractor: Extractor; channel: SupplierChannel; prices: PriceBook;
  /** Where found sellers live (the hunt's database), for recording deals with them. */
  foundDb?: DatabaseSync | null;
  /** A registered store that is not live (waiting for approval, unpaid, expired or suspended): no new deals. */
  sellerHidden?: (sellerId: string) => boolean;
  /** Where each buyer's order details are saved (null: memory only, for tests and the local chain). */
  dataDir?: string | null;
  log?: (line: string) => void;
}
/**
 * The vault's DELAY for a new seller (coin vaults always wait this long). Naira buyers wait `sellerDelayMs`, which is 0
 * by default (the buyer records a deal and the money locks at once; SELLER_APPROVAL_DELAY_HOURS turns a wait back on).
 * Blocking is always immediate.
 */
export const SELLER_APPROVAL_DELAY_MS = 24 * 3600_000;
export interface MySeller { sellerId: string; key: Hash; status: 0 | 1 | 3; pendingStatus: 1 | null; effectiveAt: number | null; addedAt: number }
export interface DealInput { sellerId: string; item: string; quantity: number; unit: string; unitPriceNaira: number; category: Category; delivery: DeliveryChoice; place: Place; contactPhone?: string }
export type DealResult = { status: 'locked' | 'ask_owner' | 'rejected' | 'too_large' | 'circuit_failed' | 'no_rider'; orderId?: string; reason?: number; message: string };

export interface BuyerRuntime { jobs: JobStore; naira: NairaBackend; dispatch: DispatchShop }

export function validateRequest(i: Partial<RequestInput> & { place?: Partial<Place> }): RequestInput {
  const text = typeof i.text === 'string' ? i.text.trim() : '';
  if (text.length < 3 || text.length > 2000) throw new AuthError(400, 'Say what you want (up to 2,000 characters).');
  const budget = Math.round(Number(i.budgetNaira));
  if (!(budget >= 1_000 && budget <= MAX_BUDGET_NAIRA)) throw new AuthError(400, `Set a budget from ₦1,000 to ₦${MAX_BUDGET_NAIRA.toLocaleString('en-NG')}.`);
  const lat = Number(i.place?.lat), lng = Number(i.place?.lng), address = String(i.place?.address ?? '').trim();
  if (!IN_NIGERIA(lat, lng)) throw new AuthError(400, 'Put the delivery pin on the map, in Nigeria.');
  if (address.length < 2 || address.length > 200) throw new AuthError(400, 'Type where it should go: your area is enough, e.g. Ikeja.');
  const delivery: DeliveryChoice = i.delivery === 'self' ? 'self' : 'logistics';
  return { text, budgetNaira: budget, place: { lat, lng, address }, delivery, contactPhone: typeof i.contactPhone === 'string' ? i.contactPhone.trim() : undefined };
}

export class Buyers {
  readonly dispatcher: Dispatcher;
  readonly orders: NairaOrders;
  private db: DatabaseSync; private p: Platform; private services: BuyerServices; private ledger: Ledger;
  private runtimes = new Map<number, BuyerRuntime>();
  private verified = new Set<string>(loadSuppliers().map((s) => supplierKey(s.id).toLowerCase()));

  private now: () => number; private sellerDelayMs: number;
  constructor(db: DatabaseSync, p: Platform, ledger: Ledger, orders: NairaOrders, services: BuyerServices & { now?: () => number; sellerDelayMs?: number }) {
    this.now = services.now ?? Date.now;
    this.sellerDelayMs = Math.max(0, services.sellerDelayMs ?? 0);
    this.db = db; this.p = p; this.ledger = ledger; this.orders = orders; this.services = services;
    this.dispatcher = new Dispatcher({ entries: p.carriers, log: services.log });
    db.exec(`CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, text TEXT NOT NULL, budget_naira INTEGER NOT NULL,
      lat REAL NOT NULL, lng REAL NOT NULL, address TEXT NOT NULL, delivery TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS buyer_sellers (
      user_id INTEGER NOT NULL, seller_key TEXT NOT NULL, seller_id TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 0,
      pending_status INTEGER, effective_at INTEGER, added_at INTEGER NOT NULL, PRIMARY KEY (user_id, seller_key))`);
  }

  /**
   * A seller's status for RestockGuard: 1 for sellers StockRun verified (the demo sellers), otherwise what this buyer set
   * in their own list. An approval the buyer queued takes effect only after SELLER_APPROVAL_DELAY_MS; blocked is 3.
   */
  sellerStatus = (key: Hash, userId?: number): number => {
    if (userId !== undefined) {
      const r = this.sellerRow(userId, key);
      if (r?.status === 3) return 3;
      // A queued approval takes effect at its time, or sooner if the server's wait was shortened since (0: at once).
      if (r && r.pending_status !== null && r.effective_at !== null && Math.min(r.effective_at, r.added_at + this.sellerDelayMs) <= this.now()) {
        this.db.prepare('UPDATE buyer_sellers SET status = pending_status, pending_status = NULL, effective_at = NULL WHERE user_id = ? AND seller_key = ?').run(userId, key.toLowerCase());
        return r.pending_status;
      }
      if (r?.status === 1) return 1;
    }
    return this.verified.has(key.toLowerCase()) ? 1 : 0;
  };
  private sellerRow(userId: number, key: Hash) {
    return this.db.prepare('SELECT * FROM buyer_sellers WHERE user_id = ? AND seller_key = ?').get(userId, key.toLowerCase()) as unknown as
      { seller_id: string; seller_key: string; status: number; pending_status: number | null; effective_at: number | null; added_at: number } | undefined;
  }
  private mine(userId: number, sellerId: string): MySeller {
    const key = supplierKey(sellerId);
    const status = this.sellerStatus(key, userId), r = this.sellerRow(userId, key);
    return { sellerId, key, status: (status === 3 ? 3 : status >= 1 ? 1 : 0), pendingStatus: r?.pending_status === 1 ? 1 : null, effectiveAt: r?.effective_at ?? null, addedAt: r?.added_at ?? 0 };
  }

  /** The buyer adds a seller they found to their list: at once, or after `sellerDelayMs` when a wait is set. Adding twice changes nothing. */
  addSeller(userId: number, sellerId: string): MySeller {
    const s = this.services.foundDb ? foundSeller(this.services.foundDb, sellerId) : null;
    if (!s) throw new AuthError(404, 'That seller is not on the map any more.');
    const cur = this.mine(userId, sellerId);
    if (cur.status === 1 || cur.pendingStatus === 1) return cur;
    const t = this.now();
    if (this.sellerDelayMs === 0) {
      this.db.prepare(`INSERT INTO buyer_sellers (user_id, seller_key, seller_id, status, added_at) VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(user_id, seller_key) DO UPDATE SET status = 1, pending_status = NULL, effective_at = NULL`).run(userId, cur.key.toLowerCase(), sellerId, t);
      return this.mine(userId, sellerId);
    }
    this.db.prepare(`INSERT INTO buyer_sellers (user_id, seller_key, seller_id, status, pending_status, effective_at, added_at) VALUES (?, ?, ?, 0, 1, ?, ?)
      ON CONFLICT(user_id, seller_key) DO UPDATE SET pending_status = 1, effective_at = excluded.effective_at`).run(userId, cur.key.toLowerCase(), sellerId, t + this.sellerDelayMs, t);
    return this.mine(userId, sellerId);
  }
  /** Blocking is immediate (and cancels a queued approval). */
  blockSeller(userId: number, sellerId: string): MySeller {
    const key = supplierKey(sellerId).toLowerCase();
    this.db.prepare(`INSERT INTO buyer_sellers (user_id, seller_key, seller_id, status, added_at) VALUES (?, ?, ?, 3, ?)
      ON CONFLICT(user_id, seller_key) DO UPDATE SET status = 3, pending_status = NULL, effective_at = NULL`).run(userId, key, sellerId, this.now());
    return this.mine(userId, sellerId);
  }
  sellerFor(userId: number, sellerId: string): MySeller { return this.mine(userId, sellerId); }

  /**
   * The buyer records a deal they agreed with a found seller (on WhatsApp). It becomes an order exactly like the
   * agent's: RestockGuard decides from the buyer's list, balance, the kind of goods and the distance; the seller is
   * paid only at pickup for what the handler counts. Budget and auto-approve limit are the buyer's available balance.
   */
  async recordDeal(user: User, raw: Partial<DealInput>): Promise<DealResult> {
    return this.recordNairaDeal(user, raw, this.parseDeal(user, raw));
  }

  /** The checks every recorded deal passes, whichever money pays for it. Throws AuthError with words for the buyer. */
  parseDeal(user: User, raw: Partial<DealInput>) {
    const foundDb = this.services.foundDb;
    const s = foundDb && typeof raw.sellerId === 'string' ? foundSeller(foundDb, raw.sellerId) : null;
    if (!s) throw new AuthError(404, 'That seller is not on the map any more.');
    if (this.services.sellerHidden?.(s.id)) throw new AuthError(409, `${s.name} is not taking orders on StockRun right now.`);
    const item = String(raw.item ?? '').trim().replace(/\s+/g, ' '), unit = String(raw.unit ?? '').trim().toLowerCase() || 'unit';
    const quantity = Number(raw.quantity), price = Number(raw.unitPriceNaira);
    if (item.length < 2 || item.length > 80) throw new AuthError(400, 'Say what you agreed to buy (up to 80 characters).');
    if (!/^[a-z ]{2,20}$/.test(unit)) throw new AuthError(400, 'The unit is a word like carton, bag or piece.');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 255) throw new AuthError(400, 'Quantity is a whole number from 1 to 255.');
    if (!Number.isInteger(price) || price < 1 || price * quantity > MAX_BUDGET_NAIRA) throw new AuthError(400, `Price per ${unit} in whole naira; the total can be up to ₦${MAX_BUDGET_NAIRA.toLocaleString('en-NG')}.`);
    if (!raw.category || !(raw.category in CATEGORIES)) throw new AuthError(400, 'Choose what kind of goods these are.');
    const lat = Number(raw.place?.lat), lng = Number(raw.place?.lng), address = String(raw.place?.address ?? '').trim();
    if (!IN_NIGERIA(lat, lng) || address.length < 2) throw new AuthError(400, 'Type your area and tap Find sellers first, so the distance can be checked.');
    const delivery: DeliveryChoice = raw.delivery === 'self' ? 'self' : 'logistics';
    let contactPhone = user.phone ?? undefined;
    if (raw.contactPhone) { try { contactPhone = normalisePhone(String(raw.contactPhone)); } catch { throw new AuthError(400, 'Enter the rider contact number like 0803 123 4567.'); } }
    if (delivery === 'logistics' && !contactPhone) throw new AuthError(400, 'Add a phone number so the logistics rider can reach you, or collect it yourself.');
    return { s, item, unit, quantity, price, category: raw.category as Category, lat, lng, address, delivery, contactPhone };
  }

  private async recordNairaDeal(user: User, raw: Partial<DealInput>, d: ReturnType<Buyers['parseDeal']>): Promise<DealResult> {
    const { s, item, unit, quantity, price, lat, lng, address, delivery, contactPhone } = d;
    let mine = this.mine(user.id, s.id);
    if (mine.status === 3) throw new AuthError(409, 'You blocked this seller.');
    if (mine.status === 0 && mine.pendingStatus) {
      throw new AuthError(409, `${s.name} joins your sellers at ${new Date(mine.effectiveAt!).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' })}. Record the deal then.`);
    }
    const available = this.ledger.balance(user.id).availableKobo;
    const fee = this.orders.feeFor(kobo(price * quantity));
    if (available < kobo(price * quantity) + fee) throw new AuthError(409, `Your balance is too low for this deal (₦${((kobo(price * quantity) + fee) / 100).toLocaleString('en-NG')} with StockRun's fee). Deposit naira first.`);
    // Recording a deal is the buyer choosing this seller: it joins their list now (or starts the wait, if one is set).
    if (mine.status === 0) {
      mine = this.addSeller(user.id, s.id);
      if (mine.status !== 1) throw new AuthError(409, `${s.name} joins your sellers at ${new Date(mine.effectiveAt!).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' })}. Record the deal then.`);
    }

    const rt = this.runtime(user.id);
    rt.naira.budgetKobo = available;
    const supplier: Supplier = { id: s.id, name: s.name, market: s.address || 'Lagos', lat: s.lat, lng: s.lng, whatsapp: s.phone, simulated: false, stocks: [] };
    const line: OrderLine = { item, quantity, unit, category: d.category, maxUnitPriceNaira: price };
    const place = { lat, lng, address };
    const i: RequestInput = { text: `${quantity} ${unit} ${item}`, budgetNaira: Math.round(available / 100), place, delivery, contactPhone };
    const booked = delivery === 'self'
      ? { rider: { id: 'self', name: 'you (self-pickup)', address: SELF_HANDLER, lat, lng } as Rider, feeNaira: 0, delivery: undefined }
      : await this.quoteDelivery(user, i, contactPhone ?? '', supplier, line, price * quantity, (a) => rt.naira.trustedHandler(a)).catch(() => null);
    if (!booked) return { status: 'no_rider', message: 'No logistics company can take this order right now. Choose "I\'ll collect it" instead.' };

    const km = haversineKm(place, s);
    const result = await rt.naira.propose({ supplierKey: supplierKey(s.id), ordered: quantity, unitPrice: BigInt(price) * 100n,
      cat: CATEGORIES[d.category], dist: distBucket(km), rider: booked.rider.address });
    if (result.status === 'locked' || result.status === 'ask_owner') {
      rt.jobs.add({ orderId: String(result.orderId), item, unit, quantity, rider: booked.rider.address,
        supplier: { name: `${s.name}, ${s.address || 'Lagos'}`, lat: s.lat, lng: s.lng }, shop: { name: address, lat, lng }, createdAt: this.now(),
        ...(booked.delivery ? { logistics: booked.delivery } : {}), ...(booked.feeNaira ? { courierFeeNaira: booked.feeNaira } : {}) });
      if (delivery === 'logistics') await this.dispatcher.bookPending(rt.dispatch).catch((e) => this.services.log?.(`booking: ${(e as Error).message}`));
    }
    const ngn = (n: number) => `₦${n.toLocaleString('en-NG')}`;
    const what = `${quantity} ${unit}(s) of ${item} from ${s.name} at ${ngn(price)} each (${ngn(price * quantity)}${fee ? ` + ${ngn(fee / 100)} StockRun fee` : ''}${booked.feeNaira ? `; delivery ${ngn(booked.feeNaira)}, paid to the courier directly` : ', you collect it'})`;
    if (result.status === 'locked') return { status: 'locked', orderId: String(result.orderId), message: `✓ ${what}. RestockGuard approved it; the money is locked. ${s.name} is paid only when ${delivery === 'self' ? 'you count the goods at pickup' : 'the logistics company checks the goods at pickup'}.` };
    if (result.status === 'ask_owner') return { status: 'ask_owner', orderId: String(result.orderId), reason: result.reason, message: `? ${what}. RestockGuard wants your OK because ${RESTOCK_REASONS[result.reason] ?? `reason ${result.reason}`}. Approve it in Orders.` };
    if (result.status === 'rejected') return { status: 'rejected', reason: result.reason, message: `✗ ${what}. RestockGuard rejected it: ${RESTOCK_REASONS[result.reason] ?? `reason ${result.reason}`}. Nothing was charged.` };
    if (result.status === 'too_large') return { status: 'too_large', message: `✗ ${what}. Too large for one order; split it.` };
    return { status: 'circuit_failed', message: `✗ ${what}. The circuit check failed, so nothing was locked or charged. Try again.` };
  }
  /** Logistics companies' desk keys: the only handlers (besides the buyer) a naira order accepts. */
  carrierKeys = (): Address[] => this.p.carriers.map((c) => c.wallet.account.address);

  runtime(userId: number): BuyerRuntime {
    const have = this.runtimes.get(userId);
    if (have) return have;
    const dir = this.services.dataDir;
    const jobs = new JobStore(dir ? join(dir, `jobs-user${userId}.json`) : null);
    const naira = new NairaBackend(this.orders, userId, (k) => this.sellerStatus(k, userId));
    const rt = { jobs, naira, dispatch: { backend: naira, jobs } };
    this.runtimes.set(userId, rt);
    return rt;
  }

  /** Every buyer's orders that may need moving along (status polling and webhooks). */
  dispatchSets(): DispatchShop[] {
    const ids = (this.db.prepare('SELECT DISTINCT user_id FROM naira_orders').all() as unknown as { user_id: number }[]).map((r) => r.user_id);
    return ids.map((id) => this.runtime(id).dispatch);
  }

  /** Run a request: find sellers near the place, negotiate, and place orders within the budget (naira). */
  async request(user: User, raw: unknown): Promise<{ id: number; message: string; problems: string[] }> {
    const i = validateRequest(raw as Partial<RequestInput>);
    // The rider's number: typed by the buyer (checked and written as +234...), else the account's own phone.
    let contactPhone = user.phone ?? undefined;
    if (i.contactPhone) {
      try { contactPhone = normalisePhone(i.contactPhone); } catch { throw new AuthError(400, 'Enter the rider contact number like 0803 123 4567.'); }
    }
    if (i.delivery === 'logistics' && !contactPhone) throw new AuthError(400, 'Add a phone number so the logistics rider can reach you, or collect it yourself.');
    const budgetKobo = Math.min(kobo(i.budgetNaira), this.ledger.balance(user.id).availableKobo);
    if (budgetKobo < kobo(1_000)) throw new AuthError(409, 'Deposit naira first: your balance pays for the order.');
    const rt = this.runtime(user.id);
    rt.naira.budgetKobo = kobo(i.budgetNaira);
    const place = { name: i.place.address, lat: i.place.lat, lng: i.place.lng };
    const deps: AgentDeps = {
      extractor: this.services.extractor, channel: this.services.channel, prices: this.services.prices,
      vault: rt.naira, money: fixedRate(100n), jobs: rt.jobs, shop: place, ownerAddress: SELF_HANDLER,
      riders: this.p.carriers.filter((c) => !c.connector).map((c): Rider => ({ id: c.id, name: c.name, address: c.wallet.account.address, lat: place.lat, lng: place.lng })),
      logistics: this.p.carriers.some((c) => c.connector)
        ? (supplier, line, goodsNaira) => this.quoteDelivery(user, i, contactPhone ?? '', supplier, line, goodsNaira, (a) => rt.naira.trustedHandler(a))
        : undefined,
    };
    const report = await handleOrder(i.text, deps, { delivery: i.delivery });
    await this.dispatcher.bookPending(rt.dispatch).catch((e) => this.services.log?.(`booking: ${(e as Error).message}`));
    const id = Number(this.db.prepare('INSERT INTO requests (user_id, text, budget_naira, lat, lng, address, delivery, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, i.text, i.budgetNaira, i.place.lat, i.place.lng, i.place.address, i.delivery, report.message, Date.now()).lastInsertRowid);
    return { id, message: report.message, problems: report.problems };
  }

  requests(userId: number): RequestRecord[] {
    return (this.db.prepare('SELECT * FROM requests WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(userId) as unknown as
      { id: number; text: string; budget_naira: number; lat: number; lng: number; address: string; delivery: DeliveryChoice; message: string; created_at: number }[])
      .map((r) => ({ id: r.id, text: r.text, budgetNaira: r.budget_naira, place: { lat: r.lat, lng: r.lng, address: r.address }, delivery: r.delivery, message: r.message, createdAt: r.created_at }));
  }

  /** Quote the logistics companies the order trusts for one deal; the cheapest becomes the order's delivery. */
  private async quoteDelivery(user: User, i: RequestInput, phone: string, supplier: Supplier, line: OrderLine, goodsNaira: number, trusted: (a: Address) => Promise<boolean>) {
    const job: DeliveryJob = {
      ref: `u${user.id}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      pickup: { name: supplier.name, lat: supplier.lat, lng: supplier.lng, address: `${supplier.name}, ${supplier.market}`, contactName: supplier.name, contactPhone: supplier.whatsapp },
      dropoff: { name: user.displayName || user.username || 'StockRun buyer', lat: i.place.lat, lng: i.place.lng, address: i.place.address, contactName: user.displayName || user.username || 'Buyer', contactPhone: phone },
      item: { name: line.item, quantity: line.quantity, unit: line.unit, valueNaira: goodsNaira },
      load: line.quantity <= 5 ? 'standard' : line.quantity <= 20 ? 'heavy' : 'freight',
    };
    const r = await this.dispatcher.quote(job, trusted);
    if (!r) return null;
    return {
      rider: { id: r.entry.id, name: r.entry.name, address: r.entry.wallet.account.address, lat: i.place.lat, lng: i.place.lng },
      feeNaira: r.quote.priceNaira,
      delivery: { carrier: r.entry.id, carrierName: r.entry.name, job, quote: r.quote, test: r.quote.test },
    };
  }
}
