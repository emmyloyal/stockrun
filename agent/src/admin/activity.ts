// What buyers did with the sellers they found, for the admin: asked the AI for a message, opened the WhatsApp chat,
// recorded a deal. Kept so the admin can see which real sellers buyers engage with and follow up on payouts.
import type { DatabaseSync } from 'node:sqlite';
import { foundTable } from '../discovery/hunt.ts';

export type ContactAction = 'drafted_message' | 'opened_whatsapp' | 'recorded_deal' | 'deal_refused';
export interface ContactRow {
  at: number; action: ContactAction; detail: string | null;
  buyer: { id: number; label: string };
  seller: { id: string; name: string; phone: string | null; address: string | null; kind: string | null; source: string | null; sourceUrl: string | null };
}

export class Activity {
  private db: DatabaseSync; private now: () => number;
  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db; this.now = now;
    foundTable(db);
    db.exec(`CREATE TABLE IF NOT EXISTS seller_contacts (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, seller_id TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL)`);
  }

  record(userId: number, sellerId: string, action: ContactAction, detail: string | null = null) {
    this.db.prepare('INSERT INTO seller_contacts (user_id, seller_id, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(userId, sellerId, action, detail?.slice(0, 300) ?? null, this.now());
  }

  /** Newest first, with the buyer and the seller's details as found. */
  list(limit = 200): ContactRow[] {
    const rows = this.db.prepare(`
      SELECT c.at, c.action, c.detail, c.user_id, u.email, u.username, u.wallet,
             c.seller_id, f.name, f.phone, f.address, f.kind, f.source, f.source_url
      FROM seller_contacts c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN found_sellers f ON f.id = c.seller_id
      ORDER BY c.id DESC LIMIT ?`).all(limit) as unknown as {
        at: number; action: ContactAction; detail: string | null; user_id: number; email: string | null; username: string | null; wallet: string | null;
        seller_id: string; name: string | null; phone: string | null; address: string | null; kind: string | null; source: string | null; source_url: string | null }[];
    return rows.map((r) => ({
      at: r.at, action: r.action, detail: r.detail,
      buyer: { id: r.user_id, label: r.username ? `@${r.username}` : r.email ?? (r.wallet ? `${r.wallet.slice(0, 6)}…${r.wallet.slice(-4)}` : `user ${r.user_id}`) },
      seller: { id: r.seller_id, name: r.name ?? 'Seller no longer on the map', phone: r.phone, address: r.address, kind: r.kind, source: r.source, sourceUrl: r.source_url },
    }));
  }
}
