// Shops (one per owner, each with its own vault) and rider profiles, plus the per-shop services the server runs:
// the agent proposing to that shop's vault, the photo check attesting to it, and that shop's jobs.
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Dispatcher, type DispatchShop } from '../logistics/dispatch.ts';
import type { DeliveryJob } from '../logistics/carrier.ts';
import { getAddress, type Address, type Hex } from 'viem';
import { deployVault, sendGasTopUp, type Platform } from '../chain/platform.ts';
import { VaultClient } from '../tools/vault.ts';
import { CheckService } from '../check/checkService.ts';
import { JobStore } from '../check/jobs.ts';
import { NoPhotoCounter, type PhotoCounter } from '../check/photoCount.ts';
import type { AgentDeps } from '../agent.ts';
import type { Extractor } from '../llm.ts';
import type { SupplierChannel } from '../tools/negotiate.ts';
import type { PriceBook } from '../prices/priceBook.ts';
import type { Rider } from '../types.ts';
import { AuthError, type User } from './accounts.ts';

export interface Shop { id: number; ownerId: number; name: string; lat: number; lng: number; vault: Address; weeklyBudgetNaira: number; limitNaira: number; createdAt: number }
export interface RiderProfile { userId: number; name: string; lat: number; lng: number; address: Address }

/** Lagos and its surroundings: rejects a pin dropped by mistake far away (and 0,0). */
const IN_LAGOS = (lat: number, lng: number) => lat > 6.2 && lat < 6.9 && lng > 2.7 && lng < 4.4;

export function migrateShops(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shops (
      id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL UNIQUE REFERENCES users(id), name TEXT NOT NULL,
      lat REAL NOT NULL, lng REAL NOT NULL, vault TEXT NOT NULL UNIQUE, weekly_budget_naira INTEGER NOT NULL,
      limit_naira INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS riders (
      user_id INTEGER PRIMARY KEY REFERENCES users(id), name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS gas_topups (
      user_id INTEGER PRIMARY KEY REFERENCES users(id), tx TEXT, created_at INTEGER NOT NULL);
  `);
}

interface ShopRow { id: number; owner_id: number; name: string; lat: number; lng: number; vault: string; weekly_budget_naira: number; limit_naira: number; created_at: number }
const toShop = (r: ShopRow): Shop => ({ id: r.id, ownerId: r.owner_id, name: r.name, lat: r.lat, lng: r.lng, vault: getAddress(r.vault), weeklyBudgetNaira: r.weekly_budget_naira, limitNaira: r.limit_naira, createdAt: r.created_at });

export interface ShopInput { name: string; lat: number; lng: number; weeklyBudgetNaira: number; limitNaira: number }

export function validateShop(i: Partial<ShopInput>): ShopInput {
  const name = typeof i.name === 'string' ? i.name.trim() : '';
  if (name.length < 2 || name.length > 80) throw new AuthError(400, 'Give your shop a name (2 to 80 characters).');
  const lat = Number(i.lat), lng = Number(i.lng);
  if (!IN_LAGOS(lat, lng)) throw new AuthError(400, 'Put your shop pin on the map in Lagos.');
  const budget = Math.round(Number(i.weeklyBudgetNaira)), limit = Math.round(Number(i.limitNaira));
  if (!(budget >= 5000 && budget <= 1_275_000)) throw new AuthError(400, 'Weekly budget must be between ₦5,000 and ₦1,275,000.');
  if (!(limit >= 5000 && limit <= budget)) throw new AuthError(400, 'Auto-approve limit must be at least ₦5,000 and not more than the weekly budget.');
  return { name, lat, lng, weeklyBudgetNaira: budget, limitNaira: limit };
}

export interface ShopServices {
  extractor: Extractor; channel: SupplierChannel; counter: PhotoCounter | null; prices: PriceBook;
  /** Where each shop's order details are saved (null: memory only, for tests and the local chain). */
  dataDir?: string | null;
  log?: (line: string) => void;
}
/** `check` is null when no photo model is configured; `settler` always works (settling needs no photo). */
export interface ShopRuntime { shop: Shop; vault: VaultClient; jobs: JobStore; check: CheckService | null; settler: CheckService; agent: AgentDeps; dispatch: DispatchShop }

export class Shops {
  private db: DatabaseSync;
  private p: Platform;
  private services: ShopServices;
  private runtimes = new Map<number, ShopRuntime>();
  /** Books logistics companies and turns their status into vault steps, for every shop. */
  readonly dispatcher: Dispatcher;
  constructor(db: DatabaseSync, platform: Platform, services: ShopServices) {
    this.db = db; this.p = platform; this.services = services;
    this.dispatcher = new Dispatcher({ pub: platform.pub, money: platform.money, entries: platform.carriers, log: services.log });
    migrateShops(db);
  }

  /** Every shop's dispatch side (for status polling and webhooks). */
  dispatchShops(): DispatchShop[] { return this.all().map((s) => this.runtime(s).dispatch); }

  get photoCheckOn(): boolean { return !!this.services.counter; }

  forOwner(userId: number): Shop | null {
    const r = this.db.prepare('SELECT * FROM shops WHERE owner_id = ?').get(userId) as unknown as ShopRow | undefined;
    return r ? toShop(r) : null;
  }
  all(): Shop[] { return (this.db.prepare('SELECT * FROM shops').all() as unknown as ShopRow[]).map(toShop); }

  /** Create the owner's shop and deploy their vault (owned by their phone key). One shop per owner. */
  async create(user: User, input: Partial<ShopInput>): Promise<Shop> {
    if (user.role !== 'owner') throw new AuthError(403, 'Only shop owner accounts can set up a shop.');
    if (!user.address) throw new AuthError(409, 'Set up the key on your phone first.');
    if (this.forOwner(user.id)) throw new AuthError(409, 'You already have a shop.');
    const s = validateShop(input);
    const vault = await deployVault(this.p, user.address, s.weeklyBudgetNaira, s.limitNaira);
    this.db.prepare('INSERT INTO shops (owner_id, name, lat, lng, vault, weekly_budget_naira, limit_naira, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, s.name, s.lat, s.lng, vault.toLowerCase(), s.weeklyBudgetNaira, s.limitNaira, Date.now());
    await this.ensureGas(user).catch(() => null);   // the owner can retry with POST /api/me/gas
    return this.forOwner(user.id)!;
  }

  /**
   * Send this person's phone key its one-off gas allowance, so it can sign deposits, pickups and confirmations.
   * Once per account (recorded before sending, so concurrent requests cannot both send); a failed send is cleared so
   * it can be retried. Returns the transaction, or null if nothing was sent now.
   */
  async ensureGas(user: User): Promise<{ tx: Hex | null; already: boolean }> {
    if (!user.address) throw new AuthError(409, 'Set up the key on your phone first.');
    const claimed = this.db.prepare('INSERT OR IGNORE INTO gas_topups (user_id, created_at) VALUES (?, ?)').run(user.id, Date.now()).changes === 1;
    if (!claimed) return { tx: null, already: true };
    try {
      const tx = await sendGasTopUp(this.p, user.address);
      this.db.prepare('UPDATE gas_topups SET tx = ? WHERE user_id = ?').run(tx ?? 'not needed', user.id);
      return { tx, already: false };
    } catch (e) {
      this.db.prepare('DELETE FROM gas_topups WHERE user_id = ?').run(user.id);
      throw e;
    }
  }

  async setRider(user: User, input: { name?: unknown; lat?: unknown; lng?: unknown }): Promise<RiderProfile> {
    if (user.role !== 'rider') throw new AuthError(403, 'Only rider accounts have a rider profile.');
    if (!user.address) throw new AuthError(409, 'Set up the key on your phone first.');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const lat = Number(input.lat), lng = Number(input.lng);
    if (name.length < 2 || name.length > 60) throw new AuthError(400, 'Enter your name (2 to 60 characters).');
    if (!IN_LAGOS(lat, lng)) throw new AuthError(400, 'Set where you usually start from, in Lagos.');
    this.db.prepare('INSERT INTO riders (user_id, name, lat, lng) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, lat = excluded.lat, lng = excluded.lng').run(user.id, name, lat, lng);
    await this.ensureGas(user).catch(() => null);
    return { userId: user.id, name, lat, lng, address: user.address };
  }

  rider(userId: number): RiderProfile | null {
    const r = this.db.prepare('SELECT r.user_id, r.name, r.lat, r.lng, u.address FROM riders r JOIN users u ON u.id = r.user_id WHERE r.user_id = ?').get(userId) as unknown as
      { user_id: number; name: string; lat: number; lng: number; address: string } | undefined;
    return r ? { userId: r.user_id, name: r.name, lat: r.lat, lng: r.lng, address: getAddress(r.address) } : null;
  }

  /** Companies without a booking API (the local simulated one). Booking still asks each vault whether it trusts them. */
  riderPool(): Rider[] {
    return this.p.carriers.filter((c) => !c.connector).map((c) => ({ id: c.id, name: c.name, address: c.wallet.account.address, lat: 6.55, lng: 3.37 }));
  }

  private owner(shop: Shop): { address?: Address; phone: string } {
    const r = this.db.prepare('SELECT address, phone FROM users WHERE id = ?').get(shop.ownerId) as unknown as { address: string | null; phone: string } | undefined;
    return { address: r?.address ? getAddress(r.address) : undefined, phone: r?.phone ?? '' };
  }

  /** The services running for one shop (created on first use). */
  runtime(shop: Shop): ShopRuntime {
    const existing = this.runtimes.get(shop.id);
    if (existing) return existing;
    const vault = new VaultClient(shop.vault, this.p.pub, this.p.agent);
    const dir = this.services.dataDir;
    const jobs = new JobStore(dir ? join(dir, `jobs-shop${shop.id}.json`) : null);
    const check = this.services.counter ? new CheckService(shop.vault, this.p.pub, this.p.checker, this.services.counter, jobs) : null;
    const settler = check ?? new CheckService(shop.vault, this.p.pub, this.p.checker, new NoPhotoCounter(), jobs);
    const self = this;
    const agent: AgentDeps = {
      extractor: this.services.extractor, channel: this.services.channel, vault, shop: { name: shop.name, lat: shop.lat, lng: shop.lng },
      money: this.p.money, jobs, prices: this.services.prices, ownerAddress: this.owner(shop).address,
      logistics: this.p.carriers.some((c) => c.connector) ? (supplier, line, goodsNaira) => this.quoteDelivery(shop, vault, supplier, line, goodsNaira) : undefined,
      get riders() { return self.riderPool(); },
    };
    const rt = { shop, vault, jobs, check, settler, agent, dispatch: { vault: shop.vault, jobs, settler } };
    this.runtimes.set(shop.id, rt);
    return rt;
  }

  /** Quote the logistics companies this shop trusts for one deal; the cheapest becomes the order's delivery. */
  private async quoteDelivery(shop: Shop, vault: VaultClient, supplier: import('../types.ts').Supplier, line: import('../types.ts').OrderLine, goodsNaira: number) {
    const job: DeliveryJob = {
      ref: `shop${shop.id}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      pickup: { name: supplier.name, lat: supplier.lat, lng: supplier.lng, address: `${supplier.name}, ${supplier.market}, Lagos`, contactName: supplier.name, contactPhone: supplier.whatsapp },
      dropoff: { name: shop.name, lat: shop.lat, lng: shop.lng, address: `${shop.name}, Lagos`, contactName: shop.name, contactPhone: this.owner(shop).phone },
      item: { name: line.item, quantity: line.quantity, unit: line.unit, valueNaira: goodsNaira },
      load: line.quantity <= 5 ? 'standard' : line.quantity <= 20 ? 'heavy' : 'freight',
    };
    const r = await this.dispatcher.quote(job, (a) => vault.trustedHandler(a));
    if (!r) return null;
    return {
      rider: { id: r.entry.id, name: r.entry.name, address: r.entry.wallet.account.address, lat: shop.lat, lng: shop.lng },
      feeNaira: r.quote.priceNaira,
      delivery: { carrier: r.entry.id, carrierName: r.entry.name, job, quote: r.quote, test: r.quote.test },
    };
  }
}
