// In-app chat between a buyer and a store registered on StockRun (its owner's account). Only the two of them can read
// a conversation. Stores found on maps have no StockRun account, so buyers reach those on WhatsApp instead.
// Messages are plain text, kept in the database; the app asks for new ones every few seconds while a chat is open.
import type { DatabaseSync } from 'node:sqlite';
import type { Listings } from './listings.ts';

export class ChatError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = 'ChatError'; this.status = status; }
}

export interface ChatSummary {
  id: number; role: 'buyer' | 'shop'; store: { sellerId: string; name: string }; buyer: { id: number; label: string };
  last: { text: string; from: 'buyer' | 'shop'; at: number } | null; unread: number; updatedAt: number;
}
export interface ChatMessage { id: number; from: 'buyer' | 'shop'; text: string; at: number }

export class Chats {
  private db: DatabaseSync; private listings: Listings; private now: () => number;
  private sent = new Map<number, number[]>();
  constructor(o: { db: DatabaseSync; listings: Listings; now?: () => number }) {
    this.db = o.db; this.listings = o.listings; this.now = o.now ?? Date.now;
    o.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY, buyer_user_id INTEGER NOT NULL, seller_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        buyer_read_at INTEGER NOT NULL DEFAULT 0, shop_read_at INTEGER NOT NULL DEFAULT 0, UNIQUE(buyer_user_id, seller_id));
      CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, from_role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages(chat_id, id);
    `);
  }

  /** The buyer's chat with this store (created the first time). Only live registered stores, and not your own. */
  open(userId: number, sellerId: string): ChatSummary {
    const store = this.listings.get(sellerId);
    if (!store || !store.live) throw new ChatError(404, 'This store does not take chats on StockRun. Message it on WhatsApp instead.');
    if (store.owner?.id === userId) throw new ChatError(409, 'This is your own store.');
    const t = this.now();
    this.db.prepare('INSERT INTO chats (buyer_user_id, seller_id, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(buyer_user_id, seller_id) DO NOTHING').run(userId, sellerId, t, t);
    const id = (this.db.prepare('SELECT id FROM chats WHERE buyer_user_id = ? AND seller_id = ?').get(userId, sellerId) as unknown as { id: number }).id;
    return this.summary(userId, id)!;
  }

  /** Which side `userId` is on in a chat, or an error if they are on neither. */
  private side(userId: number, chatId: number): { role: 'buyer' | 'shop'; chat: { id: number; buyer_user_id: number; seller_id: string; buyer_read_at: number; shop_read_at: number; updated_at: number } } {
    const chat = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId) as unknown as { id: number; buyer_user_id: number; seller_id: string; buyer_read_at: number; shop_read_at: number; updated_at: number } | undefined;
    if (!chat) throw new ChatError(404, 'No such chat.');
    if (chat.buyer_user_id === userId) return { role: 'buyer', chat };
    if (this.listings.get(chat.seller_id)?.owner?.id === userId) return { role: 'shop', chat };
    throw new ChatError(404, 'No such chat.');
  }

  private summary(userId: number, chatId: number): ChatSummary | null {
    let s; try { s = this.side(userId, chatId); } catch { return null; }
    const store = this.listings.get(s.chat.seller_id);
    const buyer = this.db.prepare('SELECT username, email, wallet FROM users WHERE id = ?').get(s.chat.buyer_user_id) as unknown as { username: string | null; email: string | null; wallet: string | null } | undefined;
    const last = this.db.prepare('SELECT from_role, text, at FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(chatId) as unknown as { from_role: 'buyer' | 'shop'; text: string; at: number } | undefined;
    const readAt = s.role === 'buyer' ? s.chat.buyer_read_at : s.chat.shop_read_at, other = s.role === 'buyer' ? 'shop' : 'buyer';
    const unread = Number((this.db.prepare('SELECT COUNT(*) n FROM chat_messages WHERE chat_id = ? AND from_role = ? AND at > ?').get(chatId, other, readAt) as unknown as { n: number }).n);
    return {
      id: chatId, role: s.role, store: { sellerId: s.chat.seller_id, name: store?.name ?? 'Store' },
      buyer: { id: s.chat.buyer_user_id, label: buyer?.username ? `@${buyer.username}` : buyer?.email?.replace(/@.*/, '') ?? 'Buyer' },
      last: last ? { text: last.text.slice(0, 120), from: last.from_role, at: last.at } : null, unread, updatedAt: s.chat.updated_at,
    };
  }

  /** Every chat this person is in: as a buyer, and as the owner of their store. Newest first. */
  list(userId: number): ChatSummary[] {
    const mine = this.listings.mine(userId);
    const ids = (this.db.prepare('SELECT id FROM chats WHERE buyer_user_id = ? OR seller_id = ? ORDER BY updated_at DESC LIMIT 100').all(userId, mine?.sellerId ?? '') as unknown as { id: number }[]).map((r) => r.id);
    return ids.flatMap((id) => { const s = this.summary(userId, id); return s ? [s] : []; });
  }

  /** Messages after `afterId` (all, the first time), oldest first; reading marks them read for this side. */
  messages(userId: number, chatId: number, afterId = 0): ChatMessage[] {
    const s = this.side(userId, chatId);
    const rows = this.db.prepare('SELECT id, from_role, text, at FROM chat_messages WHERE chat_id = ? AND id > ? ORDER BY id LIMIT 200').all(chatId, afterId) as unknown as { id: number; from_role: 'buyer' | 'shop'; text: string; at: number }[];
    this.db.prepare(`UPDATE chats SET ${s.role === 'buyer' ? 'buyer_read_at' : 'shop_read_at'} = ? WHERE id = ?`).run(this.now(), chatId);
    return rows.map((r) => ({ id: r.id, from: r.from_role, text: r.text, at: r.at }));
  }

  send(userId: number, chatId: number, raw: unknown): ChatMessage {
    const s = this.side(userId, chatId);
    const text = String(raw ?? '').replace(/\r\n/g, '\n').trim();
    if (!text) throw new ChatError(400, 'Type a message.');
    if (text.length > 1000) throw new ChatError(400, 'Keep messages under 1,000 characters.');
    if (s.role === 'buyer' && !this.listings.get(s.chat.seller_id)?.live) throw new ChatError(409, 'This store is not on StockRun right now.');
    const t = this.now(), recent = (this.sent.get(userId) ?? []).filter((x) => x > t - 3600_000);
    if (recent.length >= 120) throw new ChatError(429, 'Too many messages. Try again in a while.');
    this.sent.set(userId, [...recent, t]);
    const id = Number(this.db.prepare('INSERT INTO chat_messages (chat_id, from_role, text, at) VALUES (?, ?, ?, ?)').run(chatId, s.role, text, t).lastInsertRowid);
    this.db.prepare(`UPDATE chats SET updated_at = ?, ${s.role === 'buyer' ? 'buyer_read_at' : 'shop_read_at'} = ? WHERE id = ?`).run(t, t, chatId);
    return { id, from: s.role, text, at: t };
  }

  /** Unread messages across all of this person's chats (for the tab badge). */
  unread(userId: number): number { return this.list(userId).reduce((n, c) => n + c.unread, 0); }
}
