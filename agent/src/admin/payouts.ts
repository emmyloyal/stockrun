// The admin's view of naira orders and seller payouts.
//
// Naira sellers are paid by StockRun from its own bank account: PickupCheck decides how much (the ledger moves that
// amount from the buyer's locked money into the system "sellers" account), and an admin then sends the bank transfer
// and records its reference here. The admin can hold a payout for review (not paying is always safe) but can never
// create one, change its amount, or pay before PickupCheck approved it: amounts come only from the ledger entry the
// circuit decision created. Coin orders never come here: the vault contract pays those sellers itself.
import type { DatabaseSync } from 'node:sqlite';
import type { Hash } from 'viem';
import { LedgerError, type Ledger } from '../money/ledger.ts';

export type PayoutStatus = 'owed' | 'held' | 'paid';
export interface Bank { bankName: string; accountNumber: string; accountName: string }
export interface Payout {
  orderId: number; amountKobo: number; approvedAt: number; status: PayoutStatus;
  buyer: string; seller: { key: string; name: string; phone: string | null };
  bank: Bank | null; reference: string | null; note: string | null; paidAt: number | null; paidBy: string | null;
}

export class AdminError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = 'AdminError'; this.status = status; }
}

/** Who may use the admin page: signed-in email accounts listed in ADMIN_EMAILS. */
export const adminList = (raw: string | undefined) => new Set((raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@')));

export class Payouts {
  private db: DatabaseSync; private ledger: Ledger; private sellerOf: (key: Hash) => { name: string; phone: string | null } | null; private now: () => number;
  constructor(o: { db: DatabaseSync; ledger: Ledger; sellerOf: (key: Hash) => { name: string; phone: string | null } | null; now?: () => number }) {
    this.db = o.db; this.ledger = o.ledger; this.sellerOf = o.sellerOf; this.now = o.now ?? Date.now;
    o.db.exec(`
      CREATE TABLE IF NOT EXISTS seller_payouts (
        order_id INTEGER PRIMARY KEY, status TEXT NOT NULL, reference TEXT, note TEXT, paid_at INTEGER, paid_by TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS seller_banks (
        seller_key TEXT PRIMARY KEY, bank_name TEXT NOT NULL, account_number TEXT NOT NULL, account_name TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_log (id INTEGER PRIMARY KEY, admin TEXT NOT NULL, action TEXT NOT NULL, order_id INTEGER, detail TEXT, at INTEGER NOT NULL);
    `);
  }

  private log(admin: string, action: string, orderId: number | null, detail: string) {
    this.db.prepare('INSERT INTO admin_log (admin, action, order_id, detail, at) VALUES (?, ?, ?, ?, ?)').run(admin, action, orderId, detail, this.now());
  }

  /** Every seller payment PickupCheck approved (naira), newest first, with what the admin has done about it. */
  list(): Payout[] {
    const rows = this.db.prepare(`
      SELECT o.id AS order_id, o.supplier_key, o.user_id, e.amount AS amount, t.created_at AS approved_at,
             p.status, p.reference, p.note, p.paid_at, p.paid_by,
             b.bank_name, b.account_number, b.account_name,
             u.email, u.username, u.wallet
      FROM ledger_tx t
      JOIN ledger_entries e ON e.tx_id = t.id
      JOIN ledger_accounts a ON a.id = e.account_id AND a.owner = 'system' AND a.kind = 'sellers'
      JOIN naira_orders o ON t.key = 'seller:order:' || o.id
      LEFT JOIN seller_payouts p ON p.order_id = o.id
      LEFT JOIN seller_banks b ON b.seller_key = lower(o.supplier_key)
      LEFT JOIN users u ON u.id = o.user_id
      WHERE t.type = 'pay_seller'
      ORDER BY t.id DESC LIMIT 500`).all() as unknown as {
        order_id: number; supplier_key: string; user_id: number; amount: number; approved_at: number; status: PayoutStatus | null; reference: string | null;
        note: string | null; paid_at: number | null; paid_by: string | null; bank_name: string | null; account_number: string | null; account_name: string | null;
        email: string | null; username: string | null; wallet: string | null }[];
    return rows.map((r) => {
      const s = this.sellerOf(r.supplier_key as Hash);
      return {
        orderId: r.order_id, amountKobo: r.amount, approvedAt: r.approved_at, status: r.status ?? 'owed',
        buyer: r.username ? `@${r.username}` : r.email ?? (r.wallet ? `${r.wallet.slice(0, 6)}…${r.wallet.slice(-4)}` : `user ${r.user_id}`),
        seller: { key: r.supplier_key, name: s?.name ?? 'Unknown seller', phone: s?.phone ?? null },
        bank: r.bank_name ? { bankName: r.bank_name, accountNumber: r.account_number!, accountName: r.account_name! } : null,
        reference: r.reference, note: r.note, paidAt: r.paid_at, paidBy: r.paid_by,
      };
    });
  }

  private one(orderId: number): Payout {
    const p = this.list().find((x) => x.orderId === orderId);
    if (!p) throw new AdminError(404, 'No seller payment was approved for that order: PickupCheck has not paid it.');
    return p;
  }

  /** The seller's bank account (kept for their next orders too). */
  setBank(admin: string, orderId: number, raw: Partial<Bank>): Payout {
    const p = this.one(orderId);
    if (p.status === 'paid') throw new AdminError(409, 'This payout is already paid.');
    const bankName = String(raw.bankName ?? '').trim(), accountNumber = String(raw.accountNumber ?? '').replace(/\D/g, ''), accountName = String(raw.accountName ?? '').trim();
    if (bankName.length < 2 || bankName.length > 60) throw new AdminError(400, 'Enter the bank name.');
    if (!/^\d{10}$/.test(accountNumber)) throw new AdminError(400, 'A Nigerian account number has 10 digits (NUBAN).');
    if (accountName.length < 3 || accountName.length > 80) throw new AdminError(400, 'Enter the account name exactly as the bank shows it.');
    this.db.prepare(`INSERT INTO seller_banks (seller_key, bank_name, account_number, account_name, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(seller_key) DO UPDATE SET bank_name = excluded.bank_name, account_number = excluded.account_number, account_name = excluded.account_name, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(p.seller.key.toLowerCase(), bankName, accountNumber, accountName, this.now(), admin);
    this.log(admin, 'set_bank', orderId, `${bankName} ${accountNumber.slice(0, 3)}****${accountNumber.slice(-3)} ${accountName}`);
    return this.one(orderId);
  }

  /** Hold for review (safe: nothing is paid), or put back in the queue. */
  hold(admin: string, orderId: number, hold: boolean, note: string): Payout {
    const p = this.one(orderId);
    if (p.status === 'paid') throw new AdminError(409, 'This payout is already paid.');
    const n = String(note ?? '').trim().slice(0, 300);
    if (hold && n.length < 3) throw new AdminError(400, 'Say why the payout is held.');
    this.upsert(orderId, hold ? 'held' : 'owed', { note: hold ? n : null });
    this.log(admin, hold ? 'hold' : 'release_hold', orderId, n);
    return this.one(orderId);
  }

  /**
   * The admin has sent the bank transfer: record its reference. The ledger moves exactly the approved amount from
   * "sellers" (owed) to "paid_out", once per order. Needs the seller's bank account on file and no hold.
   */
  markPaid(admin: string, orderId: number, reference: string): Payout {
    const p = this.one(orderId);
    if (p.status === 'paid') throw new AdminError(409, 'This payout is already recorded as paid.');
    if (p.status === 'held') throw new AdminError(409, 'This payout is held. Release the hold first.');
    if (!p.bank) throw new AdminError(409, "Add the seller's bank account first.");
    const ref = String(reference ?? '').trim();
    if (!/^[A-Za-z0-9\-_/.]{4,60}$/.test(ref)) throw new AdminError(400, "Enter the bank transfer reference (4 to 60 letters, numbers, - _ / .).");
    try { this.ledger.recordSellerPayout(`order:${orderId}`, p.amountKobo, ref); }
    catch (e) { if (e instanceof LedgerError) throw new AdminError(e.status, e.message); throw e; }
    this.upsert(orderId, 'paid', { reference: ref, paid_at: this.now(), paid_by: admin });
    this.log(admin, 'paid', orderId, `${p.amountKobo / 100} NGN to ${p.bank.bankName} ****${p.bank.accountNumber.slice(-4)} ref ${ref}`);
    return this.one(orderId);
  }

  private upsert(orderId: number, status: PayoutStatus, f: { note?: string | null; reference?: string; paid_at?: number; paid_by?: string }) {
    this.db.prepare(`INSERT INTO seller_payouts (order_id, status, reference, note, paid_at, paid_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(order_id) DO UPDATE SET status = excluded.status, reference = COALESCE(excluded.reference, reference),
        note = CASE WHEN excluded.status = 'paid' THEN note ELSE excluded.note END, paid_at = COALESCE(excluded.paid_at, paid_at), paid_by = COALESCE(excluded.paid_by, paid_by), updated_at = excluded.updated_at`)
      .run(orderId, status, f.reference ?? null, f.note ?? null, f.paid_at ?? null, f.paid_by ?? null, this.now());
  }

  sellerName(key: string): string { return this.sellerOf(key as Hash)?.name ?? 'Unknown seller'; }
  sellerPhone(key: string): string | null { return this.sellerOf(key as Hash)?.phone ?? null; }
  buyerLabel(userId: number): string {
    const u = this.db.prepare('SELECT email, username, wallet FROM users WHERE id = ?').get(userId) as unknown as { email: string | null; username: string | null; wallet: string | null } | undefined;
    return u?.username ? `@${u.username}` : u?.email ?? (u?.wallet ? `${u.wallet.slice(0, 6)}…${u.wallet.slice(-4)}` : `user ${userId}`);
  }

  /** Totals for the admin page, in kobo. */
  totals() {
    const sum = (sql: string) => Number((this.db.prepare(sql).get() as unknown as { s: number | null }).s ?? 0);
    return {
      lockedKobo: sum("SELECT SUM(balance) s FROM ledger_accounts WHERE owner LIKE 'user:%' AND kind = 'held'"),
      buyersAvailableKobo: sum("SELECT SUM(balance) s FROM ledger_accounts WHERE owner LIKE 'user:%' AND kind = 'available'"),
      owedSellersKobo: this.ledger.system('sellers'),
      owedLogisticsKobo: this.ledger.system('logistics'),
      paidOutKobo: this.ledger.system('paid_out'),
      heldPayouts: sum("SELECT COUNT(*) s FROM seller_payouts WHERE status = 'held'"),
    };
  }

  recentLog(limit = 50) {
    return this.db.prepare('SELECT admin, action, order_id AS orderId, detail, at FROM admin_log ORDER BY id DESC LIMIT ?').all(limit);
  }
}
