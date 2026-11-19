// Shops (one per owner, each with its own vault) and rider profiles, plus the per-shop services the server runs:
// the agent proposing to that shop's vault, the photo check attesting to it, and that shop's jobs.
import type { DatabaseSync } from 'node:sqlite';
import { getAddress, type Address } from 'viem';
import { deployVault, type Platform } from '../chain/platform.ts';
import { VaultClient } from '../tools/vault.ts';
import { CheckService } from '../check/checkService.ts';
import { JobStore } from '../check/jobs.ts';
import type { PhotoCounter } from '../check/photoCount.ts';
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

export interface ShopServices { extractor: Extractor; channel: SupplierChannel; counter: PhotoCounter | null; prices: PriceBook }
export interface ShopRuntime { shop: Shop; vault: VaultClient; jobs: JobStore; check: CheckService | null; agent: AgentDeps }

export class Shops {
  private db: DatabaseSync;
  private p: Platform;
  private services: ShopServices;
  private runtimes = new Map<number, ShopRuntime>();
  constructor(db: DatabaseSync, platform: Platform, services: ShopServices) {
    this.db = db; this.p = platform; this.services = services;
    migrateShops(db);
  }

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
    return this.forOwner(user.id)!;
  }

  setRider(user: User, input: { name?: unknown; lat?: unknown; lng?: unknown }): RiderProfile {
    if (user.role !== 'rider') throw new AuthError(403, 'Only rider accounts have a rider profile.');
    if (!user.address) throw new AuthError(409, 'Set up the key on your phone first.');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const lat = Number(input.lat), lng = Number(input.lng);
    if (name.length < 2 || name.length > 60) throw new AuthError(400, 'Enter your name (2 to 60 characters).');
    if (!IN_LAGOS(lat, lng)) throw new AuthError(400, 'Set where you usually start from, in Lagos.');
    this.db.prepare('INSERT INTO riders (user_id, name, lat, lng) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, lat = excluded.lat, lng = excluded.lng').run(user.id, name, lat, lng);
    return { userId: user.id, name, lat, lng, address: user.address };
  }

  rider(userId: number): RiderProfile | null {
    const r = this.db.prepare('SELECT r.user_id, r.name, r.lat, r.lng, u.address FROM riders r JOIN users u ON u.id = r.user_id WHERE r.user_id = ?').get(userId) as unknown as
      { user_id: number; name: string; lat: number; lng: number; address: string } | undefined;
    return r ? { userId: r.user_id, name: r.name, lat: r.lat, lng: r.lng, address: getAddress(r.address) } : null;
  }

  /** Every rider with a key. Bonds live in each shop's vault, so booking still checks the bond there. */
  riderPool(): Rider[] {
    return (this.db.prepare('SELECT r.user_id, r.name, r.lat, r.lng, u.address FROM riders r JOIN users u ON u.id = r.user_id WHERE u.address IS NOT NULL').all() as unknown as
      { user_id: number; name: string; lat: number; lng: number; address: string }[])
      .map((r) => ({ id: `u${r.user_id}`, name: r.name, address: getAddress(r.address), lat: r.lat, lng: r.lng }));
  }

  /** The services running for one shop (created on first use). */
  runtime(shop: Shop): ShopRuntime {
    const existing = this.runtimes.get(shop.id);
    if (existing) return existing;
    const vault = new VaultClient(shop.vault, this.p.pub, this.p.agent);
    const jobs = new JobStore();
    const check = this.services.counter ? new CheckService(shop.vault, this.p.pub, this.p.checker, this.services.counter, jobs) : null;
    const self = this;
    const agent: AgentDeps = {
      extractor: this.services.extractor, channel: this.services.channel, vault, shop: { name: shop.name, lat: shop.lat, lng: shop.lng },
      tokenPerNaira: this.p.tokenPerNaira, jobs, prices: this.services.prices,
      get riders() { return self.riderPool(); },
    };
    const rt = { shop, vault, jobs, check, agent };
    this.runtimes.set(shop.id, rt);
    return rt;
  }
}
