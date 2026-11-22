// Admin controls that STOP money or speech; none of them moves money.
// - Pause switches: deposits, new orders, withdrawals, seller payouts. A pause refuses new actions at once and says why;
//   money already in the ledger stays where it is, and a deposit Paystack already took is still credited.
// - Per user: frozen (no deposits, orders, withdrawals or store fees; the balance stays visible and untouched) and
//   muted (no posts, no chat messages). Both carry the admin's reason and are recorded in the admin log.
// Every payment decision is still a circuit's (rule 1): freezing and pausing only hold money where it is.
import type { DatabaseSync } from 'node:sqlite';
import { AdminError } from './payouts.ts';

export const SWITCHES = ['deposits', 'orders', 'withdrawals', 'payouts'] as const;
export type Switch = typeof SWITCHES[number];
export interface SwitchState { paused: boolean; note: string | null; by: string | null; at: number | null }
export interface UserFlags { frozen: boolean; muted: boolean; note: string | null; by: string | null; at: number | null }
export interface UserRow { id: number; email: string | null; username: string | null; displayName: string | null; wallet: string | null; phone: string | null; role: string; createdAt: number }

const PAUSED_MESSAGE: Record<Switch, string> = {
  deposits: 'Deposits are paused for a short while. Your balance is safe; try again later.',
  orders: 'New orders are paused for a short while. Your balance is safe; try again later.',
  withdrawals: 'Withdrawals are paused for a short while. Your balance is safe; try again later.',
  payouts: 'Seller payouts are paused by an admin.',
};
const NO_FLAGS: UserFlags = { frozen: false, muted: false, note: null, by: null, at: null };

export class Controls {
  private db: DatabaseSync; private now: () => number;
  constructor(o: { db: DatabaseSync; now?: () => number }) {
    this.db = o.db; this.now = o.now ?? Date.now;
    o.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_switches (name TEXT PRIMARY KEY, paused INTEGER NOT NULL, note TEXT, by TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS user_flags (user_id INTEGER PRIMARY KEY, frozen INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0, note TEXT, by TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_log (id INTEGER PRIMARY KEY, admin TEXT NOT NULL, action TEXT NOT NULL, order_id INTEGER, detail TEXT, at INTEGER NOT NULL);
    `);
  }

  /** Record an admin action (same log as payouts, shown on the admin page). */
  log(admin: string, action: string, detail: string) {
    this.db.prepare('INSERT INTO admin_log (admin, action, order_id, detail, at) VALUES (?, ?, NULL, ?, ?)').run(admin, action, detail.slice(0, 500), this.now());
  }

  // ---------------------------------------------------------------- pause switches
  switches(): Record<Switch, SwitchState> {
    const rows = this.db.prepare('SELECT name, paused, note, by, at FROM admin_switches').all() as unknown as { name: Switch; paused: number; note: string | null; by: string | null; at: number }[];
    const out = Object.fromEntries(SWITCHES.map((s) => [s, { paused: false, note: null, by: null, at: null }])) as Record<Switch, SwitchState>;
    for (const r of rows) if (SWITCHES.includes(r.name)) out[r.name] = { paused: !!r.paused, note: r.note, by: r.by, at: r.at };
    return out;
  }
  paused(name: Switch): boolean {
    return !!(this.db.prepare('SELECT paused FROM admin_switches WHERE name = ?').get(name) as unknown as { paused: number } | undefined)?.paused;
  }
  /** Throws a 503 with a plain message when `name` is paused. */
  guard(name: Switch) { if (this.paused(name)) throw new AdminError(503, PAUSED_MESSAGE[name]); }
  setSwitch(admin: string, name: string, paused: boolean, note: string): Record<Switch, SwitchState> {
    if (!SWITCHES.includes(name as Switch)) throw new AdminError(400, 'No such switch.');
    const why = String(note ?? '').trim().slice(0, 300);
    if (paused && why.length < 3) throw new AdminError(400, 'Say why you are pausing it (other admins see this).');
    this.db.prepare(`INSERT INTO admin_switches (name, paused, note, by, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET paused = excluded.paused, note = excluded.note, by = excluded.by, at = excluded.at`).run(name, paused ? 1 : 0, why || null, admin, this.now());
    this.log(admin, paused ? 'paused' : 'resumed', `${name}${why ? `: ${why}` : ''}`);
    return this.switches();
  }

  // ---------------------------------------------------------------- users
  flags(userId: number): UserFlags {
    const r = this.db.prepare('SELECT frozen, muted, note, by, at FROM user_flags WHERE user_id = ?').get(userId) as unknown as { frozen: number; muted: number; note: string | null; by: string | null; at: number } | undefined;
    return r ? { frozen: !!r.frozen, muted: !!r.muted, note: r.note, by: r.by, at: r.at } : { ...NO_FLAGS };
  }
  /** A frozen account cannot move money in or out, or start orders. Throws 403. */
  guardMoney(userId: number) {
    if (this.flags(userId).frozen) throw new AdminError(403, `Your account is on hold while StockRun checks something. Your balance is safe. Email support if you need help.`);
  }
  /** A muted (or frozen) account cannot post or send messages. Throws 403. */
  guardSpeech(userId: number) {
    const f = this.flags(userId);
    if (f.muted || f.frozen) throw new AdminError(403, 'Your account cannot post or send messages right now. Email support if you think this is a mistake.');
  }
  setFlags(admin: string, userId: number, change: { frozen?: unknown; muted?: unknown }, note: string): UserFlags {
    if (!this.user(userId)) throw new AdminError(404, 'No such user.');
    const cur = this.flags(userId);
    const frozen = typeof change.frozen === 'boolean' ? change.frozen : cur.frozen, muted = typeof change.muted === 'boolean' ? change.muted : cur.muted;
    const why = String(note ?? '').trim().slice(0, 300);
    if ((frozen && !cur.frozen) || (muted && !cur.muted)) { if (why.length < 3) throw new AdminError(400, 'Say why (other admins see this).'); }
    this.db.prepare(`INSERT INTO user_flags (user_id, frozen, muted, note, by, at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET frozen = excluded.frozen, muted = excluded.muted, note = excluded.note, by = excluded.by, at = excluded.at`)
      .run(userId, frozen ? 1 : 0, muted ? 1 : 0, why || cur.note, admin, this.now());
    const what = [frozen !== cur.frozen ? (frozen ? 'froze' : 'unfroze') : '', muted !== cur.muted ? (muted ? 'muted' : 'unmuted') : ''].filter(Boolean).join(' and ') || 'updated';
    this.log(admin, 'user', `${what} user ${userId}${why ? `: ${why}` : ''}`);
    return this.flags(userId);
  }

  user(id: number): UserRow | null {
    const r = this.db.prepare('SELECT id, email, username, display_name, wallet, phone, role, created_at FROM users WHERE id = ?').get(id) as unknown as Raw | undefined;
    return r ? toRow(r) : null;
  }
  /** Find people by id, email, username, name, wallet or phone (newest first). Empty query: the newest accounts. */
  findUsers(q: string, limit = 30): (UserRow & { flags: UserFlags })[] {
    const s = String(q ?? '').trim().slice(0, 80).replace(/^@/, '');
    const rows = (s === ''
      ? this.db.prepare('SELECT id, email, username, display_name, wallet, phone, role, created_at FROM users ORDER BY id DESC LIMIT ?').all(limit)
      : /^\d+$/.test(s) && s.length < 9
        ? this.db.prepare('SELECT id, email, username, display_name, wallet, phone, role, created_at FROM users WHERE id = ?').all(Number(s))
        : this.db.prepare(`SELECT id, email, username, display_name, wallet, phone, role, created_at FROM users
            WHERE lower(email) LIKE ? OR lower(username) LIKE ? OR lower(display_name) LIKE ? OR lower(wallet) LIKE ? OR phone LIKE ? ORDER BY id DESC LIMIT ?`)
          .all(...Array(5).fill(`%${s.toLowerCase().replace(/[%_]/g, '')}%`), limit)) as unknown as Raw[];
    return rows.map((r) => ({ ...toRow(r), flags: this.flags(r.id) }));
  }
}

type Raw = { id: number; email: string | null; username: string | null; display_name: string | null; wallet: string | null; phone: string | null; role: string | null; created_at: number };
const toRow = (r: Raw): UserRow => ({ id: r.id, email: r.email, username: r.username, displayName: r.display_name, wallet: r.wallet, phone: r.phone, role: r.role === 'shop' ? 'shop' : 'buyer', createdAt: r.created_at });
