// Store posts and the buyers' feed. The owner of a LIVE registered store (approved by an admin and paid up) can post
// what they have in stock: text, an optional price and an optional photo. Every signed-in buyer sees posts from live
// stores, newest first, and can open the store's page or message it in the app (chat.ts). A store that stops being
// live (unpaid, suspended) drops off the feed at once; its posts come back if it goes live again.
import type { DatabaseSync } from 'node:sqlite';
import type { Listings, Product } from './listings.ts';

export class PostError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = 'PostError'; this.status = status; }
}

export interface Post {
  id: number; text: string; priceNaira: number | null; unit: string | null; hasPhoto: boolean; at: number;
  store: { sellerId: string; name: string; kind: string; address: string; lat: number; lng: number };
  mine: boolean;
}
export interface StorePage {
  sellerId: string; name: string; kind: string; address: string; lat: number; lng: number;
  products: Product[]; posts: Post[]; mine: boolean;
}

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTO = 400_000;          // bytes; the app shrinks photos before sending
const POSTS_PER_DAY = 20;

type Row = { id: number; seller_id: string; text: string; price_kobo: number | null; unit: string | null; photo_type: string | null; at: number };

export class Posts {
  private db: DatabaseSync; private listings: Listings; private now: () => number;
  constructor(o: { db: DatabaseSync; listings: Listings; now?: () => number }) {
    this.db = o.db; this.listings = o.listings; this.now = o.now ?? Date.now;
    o.db.exec(`
      CREATE TABLE IF NOT EXISTS store_posts (
        id INTEGER PRIMARY KEY, seller_id TEXT NOT NULL, text TEXT NOT NULL, price_kobo INTEGER, unit TEXT,
        photo BLOB, photo_type TEXT, at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS store_posts_feed ON store_posts(deleted, id);
      CREATE INDEX IF NOT EXISTS store_posts_store ON store_posts(seller_id, id);
    `);
  }

  /** A post from the signed-in owner's store. Only live stores can post. */
  create(userId: number, raw: { text?: unknown; priceNaira?: unknown; unit?: unknown; photo?: unknown }): Post {
    const store = this.listings.mine(userId);
    if (!store) throw new PostError(404, 'Register your store first (Me → My store).');
    if (!store.live) throw new PostError(409, store.review !== 'approved' ? 'Your store can post once StockRun has approved it.'
      : store.suspended ? 'Your store is suspended, so it cannot post.' : 'Pay this month\'s listing fee to post on the feed.');
    const text = String(raw.text ?? '').replace(/\r\n/g, '\n').trim();
    if (text.length < 2) throw new PostError(400, 'Write what you have in stock.');
    if (text.length > 500) throw new PostError(400, 'Keep a post under 500 characters.');
    let priceKobo: number | null = null, unit: string | null = null;
    if (raw.priceNaira !== undefined && raw.priceNaira !== null && raw.priceNaira !== '') {
      const p = Number(raw.priceNaira);
      if (!Number.isInteger(p) || p < 1 || p > 10_000_000) throw new PostError(400, 'Price in whole naira.');
      priceKobo = p * 100;
      unit = String(raw.unit ?? '').trim().toLowerCase() || 'unit';
      if (!/^[a-z ]{2,20}$/.test(unit)) throw new PostError(400, 'The unit is a word like carton, bag or piece.');
    }
    const photo = raw.photo ? this.photoFrom(raw.photo) : null;
    const today = Number((this.db.prepare('SELECT COUNT(*) n FROM store_posts WHERE seller_id = ? AND at > ?').get(store.sellerId, this.now() - 86_400_000) as unknown as { n: number }).n);
    if (today >= POSTS_PER_DAY) throw new PostError(429, `Up to ${POSTS_PER_DAY} posts a day.`);
    const id = Number(this.db.prepare('INSERT INTO store_posts (seller_id, text, price_kobo, unit, photo, photo_type, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(store.sellerId, text, priceKobo, unit, photo?.data ?? null, photo?.type ?? null, this.now()).lastInsertRowid);
    return this.byId(id, userId)!;
  }

  /** JPEG, PNG or WebP, checked by its first bytes, not by what the caller says it is. */
  private photoFrom(raw: unknown): { type: string; data: Buffer } {
    const p = raw as { mediaType?: unknown; data?: unknown };
    const data = Buffer.from(String(p?.data ?? ''), 'base64');
    if (!data.length) throw new PostError(400, 'That photo could not be read.');
    if (data.length > MAX_PHOTO) throw new PostError(400, 'That photo is too large.');
    const magic = data.subarray(0, 12).toString('hex');
    const type = magic.startsWith('ffd8ff') ? 'image/jpeg' : magic.startsWith('89504e47') ? 'image/png'
      : magic.startsWith('52494646') && magic.slice(16, 24) === '57454250' ? 'image/webp' : null;
    if (!type || !PHOTO_TYPES.includes(type)) throw new PostError(400, 'Use a JPEG, PNG or WebP photo.');
    return { type, data };
  }

  /** The owner deletes one of their store's posts. */
  remove(userId: number, id: number): void {
    const store = this.listings.mine(userId);
    const r = this.db.prepare('SELECT seller_id FROM store_posts WHERE id = ? AND deleted = 0').get(id) as unknown as { seller_id: string } | undefined;
    if (!r || !store || r.seller_id !== store.sellerId) throw new PostError(404, 'No such post.');
    this.db.prepare('UPDATE store_posts SET deleted = 1, photo = NULL WHERE id = ?').run(id);
  }

  /** Posts from live stores, newest first; `before` (a post id) loads the next page. */
  feed(userId: number, before = 0, limit = 20): Post[] {
    const out: Post[] = [];
    let cursor = before > 0 ? before : Number.MAX_SAFE_INTEGER;
    const live = new Map<string, boolean>();
    // Scan in pages so posts from stores that are no longer live are skipped without leaving the page short.
    for (let pages = 0; out.length < limit && pages < 10; pages++) {
      const rows = this.db.prepare('SELECT id, seller_id, text, price_kobo, unit, photo_type, at FROM store_posts WHERE deleted = 0 AND id < ? ORDER BY id DESC LIMIT 50').all(cursor) as unknown as Row[];
      if (!rows.length) break;
      for (const r of rows) {
        if (!live.has(r.seller_id)) live.set(r.seller_id, !!this.listings.get(r.seller_id)?.live);
        if (live.get(r.seller_id)) { const p = this.toPost(r, userId); if (p) out.push(p); }
        if (out.length >= limit) break;
      }
      cursor = rows[rows.length - 1].id;
    }
    return out;
  }

  /** A store's page: its details, price list and latest posts. Live stores only, except for the owner. */
  store(userId: number, sellerId: string): StorePage {
    const b = this.listings.get(sellerId);
    const mine = !!b && b.owner?.id === userId;
    if (!b || (!b.live && !mine)) throw new PostError(404, 'This store is not on StockRun right now.');
    const rows = this.db.prepare('SELECT id, seller_id, text, price_kobo, unit, photo_type, at FROM store_posts WHERE seller_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 30').all(sellerId) as unknown as Row[];
    return { sellerId, name: b.name, kind: b.kind, address: b.address, lat: b.lat, lng: b.lng, products: b.products, mine,
      posts: rows.flatMap((r) => { const p = this.toPost(r, userId); return p ? [p] : []; }) };
  }

  /** A post's photo, for anyone who can see the post. */
  photo(id: number): { type: string; data: Buffer } | null {
    const r = this.db.prepare('SELECT seller_id, photo, photo_type FROM store_posts WHERE id = ? AND deleted = 0').get(id) as unknown as { seller_id: string; photo: Uint8Array | null; photo_type: string | null } | undefined;
    if (!r?.photo || !r.photo_type || !this.listings.get(r.seller_id)?.live) return null;
    return { type: r.photo_type, data: Buffer.from(r.photo) };
  }

  private byId(id: number, userId: number): Post | null {
    const r = this.db.prepare('SELECT id, seller_id, text, price_kobo, unit, photo_type, at FROM store_posts WHERE id = ?').get(id) as unknown as Row | undefined;
    return r ? this.toPost(r, userId) : null;
  }
  private toPost(r: Row, userId: number): Post | null {
    const b = this.listings.get(r.seller_id);
    if (!b) return null;
    return {
      id: r.id, text: r.text, priceNaira: r.price_kobo === null ? null : r.price_kobo / 100, unit: r.unit, hasPhoto: !!r.photo_type, at: r.at,
      store: { sellerId: b.sellerId, name: b.name, kind: b.kind, address: b.address, lat: b.lat, lng: b.lng }, mine: b.owner?.id === userId,
    };
  }
}
