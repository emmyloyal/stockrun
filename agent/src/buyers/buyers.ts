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
import type { OrderLine, Rider, Supplier } from '../types.ts';
import { Dispatcher, type DispatchShop } from '../logistics/dispatch.ts';
import type { DeliveryJob } from '../logistics/carrier.ts';
import type { Ledger } from '../money/ledger.ts';
import { kobo } from '../money/ledger.ts';
import { NairaBackend } from '../orders/backends.ts';
import { NairaOrders, SELF_HANDLER } from '../orders/nairaOrders.ts';
import type { User } from '../accounts/accounts.ts';
import { AuthError } from '../accounts/accounts.ts';

/** Nigeria (with a little margin): rejects pins dropped by mistake far away (and 0,0). */
export const IN_NIGERIA = (lat: number, lng: number) => lat > 4.0 && lat < 14.0 && lng > 2.6 && lng < 14.7;
export const MAX_BUDGET_NAIRA = 1_275_000;      // the circuits count money in 8 bits of ₦5,000

export interface Place { lat: number; lng: number; address: string }
export interface RequestInput { text: string; budgetNaira: number; place: Place; delivery: DeliveryChoice; contactPhone?: string }
export interface RequestRecord { id: number; text: string; budgetNaira: number; place: Place; delivery: DeliveryChoice; message: string; createdAt: number }

export interface BuyerServices {
  extractor: Extractor; channel: SupplierChannel; prices: PriceBook;
  /** Where each buyer's order details are saved (null: memory only, for tests and the local chain). */
  dataDir?: string | null;
  log?: (line: string) => void;
}
export interface BuyerRuntime { jobs: JobStore; naira: NairaBackend; dispatch: DispatchShop }

export function validateRequest(i: Partial<RequestInput> & { place?: Partial<Place> }): RequestInput {
  const text = typeof i.text === 'string' ? i.text.trim() : '';
  if (text.length < 3 || text.length > 2000) throw new AuthError(400, 'Say what you want (up to 2,000 characters).');
  const budget = Math.round(Number(i.budgetNaira));
  if (!(budget >= 1_000 && budget <= MAX_BUDGET_NAIRA)) throw new AuthError(400, `Set a budget from ₦1,000 to ₦${MAX_BUDGET_NAIRA.toLocaleString('en-NG')}.`);
  const lat = Number(i.place?.lat), lng = Number(i.place?.lng), address = String(i.place?.address ?? '').trim();
  if (!IN_NIGERIA(lat, lng)) throw new AuthError(400, 'Put the delivery pin on the map, in Nigeria.');
  if (address.length < 3 || address.length > 200) throw new AuthError(400, 'Type the delivery address (street, area, city).');
  const delivery: DeliveryChoice = i.delivery === 'self' ? 'self' : 'logistics';
  return { text, budgetNaira: budget, place: { lat, lng, address }, delivery, contactPhone: typeof i.contactPhone === 'string' ? i.contactPhone.trim() : undefined };
}

export class Buyers {
  readonly dispatcher: Dispatcher;
  readonly orders: NairaOrders;
  private db: DatabaseSync; private p: Platform; private services: BuyerServices; private ledger: Ledger;
  private runtimes = new Map<number, BuyerRuntime>();
  private verified = new Set<string>(loadSuppliers().map((s) => supplierKey(s.id).toLowerCase()));

  constructor(db: DatabaseSync, p: Platform, ledger: Ledger, orders: NairaOrders, services: BuyerServices) {
    this.db = db; this.p = p; this.ledger = ledger; this.orders = orders; this.services = services;
    this.dispatcher = new Dispatcher({ entries: p.carriers, log: services.log });
    db.exec(`CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, text TEXT NOT NULL, budget_naira INTEGER NOT NULL,
      lat REAL NOT NULL, lng REAL NOT NULL, address TEXT NOT NULL, delivery TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  }

  /** Sellers StockRun has verified (status 1 in RestockGuard's terms); anyone else is rejected by the circuit. */
  sellerStatus = (key: Hash) => (this.verified.has(key.toLowerCase()) ? 1 : 0);
  /** Logistics companies' desk keys: the only handlers (besides the buyer) a naira order accepts. */
  carrierKeys = (): Address[] => this.p.carriers.map((c) => c.wallet.account.address);

  runtime(userId: number): BuyerRuntime {
    const have = this.runtimes.get(userId);
    if (have) return have;
    const dir = this.services.dataDir;
    const jobs = new JobStore(dir ? join(dir, `jobs-user${userId}.json`) : null);
    const naira = new NairaBackend(this.orders, userId, this.sellerStatus);
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
    const contactPhone = i.contactPhone || user.phone;
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
