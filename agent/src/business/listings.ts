// Businesses that register their store on StockRun: name, kind, area, WhatsApp number and products with prices.
// A store goes live once an admin has approved it AND its monthly listing fee is paid (from the owner's StockRun
// balance), and stays live while paid and not suspended. The fee can only be paid after approval. Live stores show first in seller search, marked "Registered on StockRun". A registered store is also a
// found seller (same id rule: "found-" + hash of its phone), so messaging, deals, pickup and payouts work unchanged.
// Its bank account still needs an admin's approval before payouts: anyone could type a real shop's number.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { normalisePhone } from '../accounts/accounts.ts';
import { foundTable } from '../discovery/hunt.ts';
import { OSM_SHOP_TYPES } from '../discovery/osm.ts';
import type { Geocoder } from '../discovery/geocode.ts';
import type { Ledger } from '../money/ledger.ts';
import { supplierKey } from '../tools/suppliers.ts';
const keccakKey = (sellerId: string) => supplierKey(sellerId).toLowerCase();

export class BusinessError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = 'BusinessError'; this.status = status; }
}

export interface Product { item: string; unit: string; priceNaira: number }
export interface Business {
  sellerId: string; name: string; kind: string; address: string; lat: number; lng: number; phone: string;
  products: Product[]; paidUntil: number; live: boolean; suspended: boolean; suspendedNote: string | null; createdAt: number;
  /** pending: waiting for an admin; approved; rejected (with the reason in reviewNote). */
  review: 'pending' | 'approved' | 'rejected'; reviewNote: string | null;
  owner?: { id: number; label: string };
}

const idFor = (phone: string) => `found-${createHash('sha256').update(phone).digest('hex').slice(0, 16)}`;

export class Listings {
  private db: DatabaseSync; private ledger: Ledger; private geocoder: Geocoder | null; private now: () => number;
  readonly feeKobo: number; readonly periodMs: number;
  constructor(o: { db: DatabaseSync; ledger: Ledger; geocoder?: Geocoder | null; now?: () => number; feeNaira?: number; periodDays?: number }) {
    this.db = o.db; this.ledger = o.ledger; this.geocoder = o.geocoder ?? null; this.now = o.now ?? Date.now;
    this.feeKobo = Math.round((o.feeNaira ?? 1_000) * 100); this.periodMs = (o.periodDays ?? 30) * 24 * 3600_000;
    foundTable(o.db);
    o.db.exec(`
      CREATE TABLE IF NOT EXISTS business_listings (
        seller_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL UNIQUE, paid_until INTEGER NOT NULL DEFAULT 0,
        suspended INTEGER NOT NULL DEFAULT 0, suspended_note TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS business_products (
        id INTEGER PRIMARY KEY, seller_id TEXT NOT NULL, item TEXT NOT NULL, unit TEXT NOT NULL, price_kobo INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS business_products_seller ON business_products(seller_id);
    `);
    const cols = (o.db.prepare('PRAGMA table_info(business_listings)').all() as unknown as { name: string }[]).map((c) => c.name);
    if (!cols.includes('review')) o.db.exec("ALTER TABLE business_listings ADD COLUMN review TEXT NOT NULL DEFAULT 'pending'");
    if (!cols.includes('review_note')) o.db.exec('ALTER TABLE business_listings ADD COLUMN review_note TEXT');
  }

  /** Create or update the signed-in owner's store. It is not live until the first month is paid. */
  async save(userId: number, raw: { name?: unknown; kind?: unknown; address?: unknown; phone?: unknown; products?: unknown }): Promise<Business> {
    const name = String(raw.name ?? '').trim().replace(/\s+/g, ' '), kind = String(raw.kind ?? '').trim(), address = String(raw.address ?? '').trim();
    if (name.length < 2 || name.length > 60) throw new BusinessError(400, 'Give your store a name (up to 60 characters).');
    if (!(OSM_SHOP_TYPES as readonly string[]).includes(kind)) throw new BusinessError(400, 'Choose what kind of store it is.');
    if (address.length < 2 || address.length > 200) throw new BusinessError(400, 'Type where your store is: the area is enough, e.g. Mile 12.');
    let phone: string;
    try { phone = normalisePhone(String(raw.phone ?? '')); } catch { throw new BusinessError(400, 'Enter your WhatsApp number like 0803 123 4567.'); }
    if (!/^\+234[789][01]\d{8}$/.test(phone)) throw new BusinessError(400, 'Use a Nigerian mobile number (the one on WhatsApp).');
    const products = this.products(raw.products);

    const mine = this.db.prepare('SELECT seller_id FROM business_listings WHERE owner_user_id = ?').get(userId) as unknown as { seller_id: string } | undefined;
    const sellerId = idFor(phone);
    if (mine && mine.seller_id !== sellerId) throw new BusinessError(409, 'Your store is registered with another WhatsApp number. Contact StockRun to change it.');
    const taken = this.db.prepare('SELECT owner_user_id FROM business_listings WHERE seller_id = ?').get(sellerId) as unknown as { owner_user_id: number } | undefined;
    if (taken && taken.owner_user_id !== userId) throw new BusinessError(409, 'A store with this WhatsApp number is already registered.');

    if (!this.geocoder) throw new BusinessError(503, 'Store registration is not switched on yet.');
    let hit = (await this.geocoder.search(address).catch(() => []))[0];
    if (!hit && !/lagos/i.test(address)) hit = (await this.geocoder.search(`${address}, Lagos`).catch(() => []))[0];
    if (!hit) throw new BusinessError(400, 'We could not find that place. Try your area name, e.g. "Mile 12" or "Ikeja".');

    const t = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // The same phone may already be on the map from OpenStreetMap: registering claims that entry for this store.
      this.db.prepare(`INSERT INTO found_sellers (id, name, address, lat, lng, phone, source, source_url, found_at, kind) VALUES (?, ?, ?, ?, ?, ?, 'listed', NULL, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET name = excluded.name, address = excluded.address, lat = excluded.lat, lng = excluded.lng, source = 'listed', source_url = NULL, kind = excluded.kind`)
        .run(sellerId, name, address, hit.lat, hit.lng, phone, t, kind);
      if (!mine) this.db.prepare('INSERT INTO business_listings (seller_id, owner_user_id, created_at) VALUES (?, ?, ?)').run(sellerId, userId, t);
      else this.db.prepare("UPDATE business_listings SET review = 'pending', review_note = NULL WHERE seller_id = ? AND review = 'rejected'").run(sellerId);
      this.db.prepare('DELETE FROM business_products WHERE seller_id = ?').run(sellerId);
      const add = this.db.prepare('INSERT INTO business_products (seller_id, item, unit, price_kobo) VALUES (?, ?, ?, ?)');
      for (const p of products) add.run(sellerId, p.item, p.unit, Math.round(p.priceNaira * 100));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return this.mine(userId)!;
  }

  private products(raw: unknown): Product[] {
    if (!Array.isArray(raw) || raw.length < 1) throw new BusinessError(400, 'Add at least one product with its price.');
    if (raw.length > 50) throw new BusinessError(400, 'Up to 50 products.');
    return raw.map((p: { item?: unknown; unit?: unknown; priceNaira?: unknown }, i) => {
      const item = String(p?.item ?? '').trim().replace(/\s+/g, ' '), unit = String(p?.unit ?? '').trim().toLowerCase() || 'unit', price = Number(p?.priceNaira);
      if (item.length < 2 || item.length > 80) throw new BusinessError(400, `Product ${i + 1}: give it a name.`);
      if (!/^[a-z ]{2,20}$/.test(unit)) throw new BusinessError(400, `Product ${i + 1}: the unit is a word like carton, bag or piece.`);
      if (!Number.isInteger(price) || price < 1 || price > 10_000_000) throw new BusinessError(400, `Product ${i + 1}: price in whole naira.`);
      return { item, unit, priceNaira: price };
    });
  }

  /**
   * Pay one month from the owner's StockRun balance. Paying early adds a month after the current end. The money goes to
   * StockRun's "listings" account; the key makes a double click charge once.
   */
  payMonth(userId: number, requestKey: string): Business {
    const b = this.mine(userId);
    if (!b) throw new BusinessError(404, 'Register your store first.');
    if (b.suspended) throw new BusinessError(409, `Your store is suspended${b.suspendedNote ? `: ${b.suspendedNote}` : ''}. Contact StockRun.`);
    if (b.review !== 'approved') throw new BusinessError(409, b.review === 'rejected'
      ? `StockRun did not approve your store${b.reviewNote ? `: ${b.reviewNote}` : ''}. Update it and it will be checked again.`
      : 'StockRun is checking your store. You can pay once it is approved.');
    if (this.ledger.balance(userId).availableKobo < this.feeKobo) throw new BusinessError(409, `The monthly fee is ₦${(this.feeKobo / 100).toLocaleString('en-NG')}. Deposit naira first.`);
    const key = String(requestKey ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (key.length < 8) throw new BusinessError(400, 'Missing request key.');
    const fresh = this.ledger.payListing(userId, `${b.sellerId}:${key}`, this.feeKobo);
    if (fresh) {
      const from = Math.max(this.now(), b.paidUntil);
      this.db.prepare('UPDATE business_listings SET paid_until = ? WHERE seller_id = ?').run(from + this.periodMs, b.sellerId);
    }
    return this.mine(userId)!;
  }

  private row(where: string, arg: string | number): Business | null {
    const r = this.db.prepare(`SELECT l.*, f.name, f.kind, f.address, f.lat, f.lng, f.phone, u.email, u.username FROM business_listings l
      JOIN found_sellers f ON f.id = l.seller_id LEFT JOIN users u ON u.id = l.owner_user_id WHERE ${where}`).get(arg) as unknown as
      { seller_id: string; owner_user_id: number; paid_until: number; suspended: number; suspended_note: string | null; created_at: number; review: Business['review']; review_note: string | null;
        name: string; kind: string; address: string; lat: number; lng: number; phone: string; email: string | null; username: string | null } | undefined;
    return r ? this.toBusiness(r) : null;
  }
  private toBusiness(r: { seller_id: string; owner_user_id: number; paid_until: number; suspended: number; suspended_note: string | null; created_at: number; review: Business['review']; review_note: string | null;
    name: string; kind: string; address: string; lat: number; lng: number; phone: string; email: string | null; username: string | null }): Business {
    return {
      sellerId: r.seller_id, name: r.name, kind: r.kind, address: r.address, lat: r.lat, lng: r.lng, phone: r.phone,
      products: this.productsOf(r.seller_id), paidUntil: r.paid_until, suspended: !!r.suspended, suspendedNote: r.suspended_note,
      live: r.review === 'approved' && !r.suspended && r.paid_until > this.now(), createdAt: r.created_at, review: r.review, reviewNote: r.review_note,
      owner: { id: r.owner_user_id, label: r.username ? `@${r.username}` : r.email ?? `user ${r.owner_user_id}` },
    };
  }
  productsOf(sellerId: string): Product[] {
    return (this.db.prepare('SELECT item, unit, price_kobo FROM business_products WHERE seller_id = ? ORDER BY id').all(sellerId) as unknown as { item: string; unit: string; price_kobo: number }[])
      .map((p) => ({ item: p.item, unit: p.unit, priceNaira: p.price_kobo / 100 }));
  }
  mine(userId: number): Business | null { return this.row('l.owner_user_id = ?', userId); }
  get(sellerId: string): Business | null { return this.row('l.seller_id = ?', sellerId); }
  /** Registered and not live (unpaid, expired or suspended): kept off search, the map and new deals. */
  hidden(sellerId: string): boolean { const b = this.get(sellerId); return !!b && !b.live; }

  /** Every store, newest first (the admin page). */
  all(): Business[] {
    return (this.db.prepare(`SELECT l.*, f.name, f.kind, f.address, f.lat, f.lng, f.phone, u.email, u.username FROM business_listings l
      JOIN found_sellers f ON f.id = l.seller_id LEFT JOIN users u ON u.id = l.owner_user_id ORDER BY l.created_at DESC LIMIT 500`).all() as unknown as Parameters<Listings['toBusiness']>[0][])
      .map((r) => this.toBusiness(r));
  }

  /**
   * An admin approves a store (it can then pay and go live), or rejects it with a reason the owner sees. Approving also
   * approves the bank account the business entered: the admin has vetted the business at this point.
   */
  review(sellerId: string, approve: boolean, note: string, admin: string): Business {
    const b = this.get(sellerId);
    if (!b) throw new BusinessError(404, 'No such store.');
    const n = String(note ?? '').trim().slice(0, 300);
    if (!approve && n.length < 3) throw new BusinessError(400, 'Say why the store is not approved.');
    this.db.prepare('UPDATE business_listings SET review = ?, review_note = ? WHERE seller_id = ?').run(approve ? 'approved' : 'rejected', approve ? null : n, sellerId);
    if (approve) {
      const key = this.sellerKey(sellerId);
      const banks = this.db.prepare('PRAGMA table_info(seller_banks)').all() as unknown as { name: string }[];   // payouts may be off
      if (banks.some((c) => c.name === 'approved')) this.db.prepare("UPDATE seller_banks SET approved = 1, updated_at = ?, updated_by = ? WHERE seller_key = ? AND approved = 0").run(this.now(), admin, key);
    }
    return this.get(sellerId)!;
  }
  private sellerKey = (sellerId: string) => keccakKey(sellerId);

  suspend(sellerId: string, suspended: boolean, note: string): Business {
    const b = this.get(sellerId);
    if (!b) throw new BusinessError(404, 'No such store.');
    const n = String(note ?? '').trim().slice(0, 300);
    if (suspended && n.length < 3) throw new BusinessError(400, 'Say why the store is suspended.');
    this.db.prepare('UPDATE business_listings SET suspended = ?, suspended_note = ? WHERE seller_id = ?').run(suspended ? 1 : 0, suspended ? n : null, sellerId);
    return this.get(sellerId)!;
  }

  /** Live stores near a point whose products match the request, best match first, with their matching products. */
  matching(text: string, near: { lat: number; lng: number }, radiusKm: number, kinds: string[]): { sellerId: string; score: number; products: Product[] }[] {
    const words = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
    const km = (a: { lat: number; lng: number }) => {
      const R = 6371, rad = (d: number) => (d * Math.PI) / 180, dLat = rad(a.lat - near.lat), dLng = rad(a.lng - near.lng);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(near.lat)) * Math.cos(rad(a.lat)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };
    return this.all().filter((b) => b.live && km(b) <= radiusKm).flatMap((b) => {
      const hits = b.products.filter((p) => p.item.toLowerCase().split(/[^a-z0-9]+/).some((w) => words.has(w)));
      const score = hits.length * 10 + (kinds.includes(b.kind) ? 1 : 0);
      return score > 0 ? [{ sellerId: b.sellerId, score, products: hits.length ? hits : b.products.slice(0, 3) }] : [];
    }).sort((a, z) => z.score - a.score);
  }
}

const STOP = new Set(['and', 'the', 'for', 'with', 'under', 'cartons', 'carton', 'bags', 'bag', 'pieces', 'piece', 'packs', 'pack', 'crate', 'crates', 'want', 'need', 'buy', 'some']);
