// Naira held by StockRun for people who deposit with Paystack. NOT on-chain: the app must say so.
//
// Double entry in whole kobo (never floats). Every transaction's entries sum to zero, and each account's balance is
// the sum of its entries. Only the system "paystack" account may go negative: it is where deposited money enters.
// Every transaction has a unique key, so repeating a request (a retried webhook, a double click) changes nothing
// and returns the original result.
//
// Per person: `available` (can be spent) and `held` (locked for open orders). System: `paystack` (money in),
// `sellers` and `logistics` (what StockRun owes them and pays out by bank transfer), `paid_out` (seller payouts an admin
// sent by bank transfer and recorded with its reference), `fees` (StockRun's fee: 1.5% paid on top of each deposit,
// and any order fee the server is set to charge on completed pickups).
import type { DatabaseSync } from 'node:sqlite';

export type Kind = 'available' | 'held';
export type SystemAccount = 'paystack' | 'sellers' | 'logistics' | 'paid_out' | 'fees' | 'listings';
export class LedgerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = 'LedgerError'; this.status = status; }
}

export function migrateLedger(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_accounts (
      id INTEGER PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0,
      allow_negative INTEGER NOT NULL DEFAULT 0, UNIQUE(owner, kind),
      CHECK (allow_negative = 1 OR balance >= 0));
    CREATE TABLE IF NOT EXISTS ledger_tx (
      id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, type TEXT NOT NULL, user_id INTEGER, memo TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY, tx_id INTEGER NOT NULL REFERENCES ledger_tx(id), account_id INTEGER NOT NULL REFERENCES ledger_accounts(id),
      amount INTEGER NOT NULL, balance_after INTEGER NOT NULL);
    INSERT OR IGNORE INTO ledger_accounts (owner, kind, allow_negative) VALUES ('system', 'paystack', 1), ('system', 'sellers', 0), ('system', 'logistics', 0), ('system', 'paid_out', 0), ('system', 'fees', 0), ('system', 'listings', 0);
  `);
}

export interface Balance { availableKobo: number; heldKobo: number }
export interface Movement { key: string; type: string; amountKobo: number; memo: string | null; at: number }

export class Ledger {
  private db: DatabaseSync; private now: () => number;
  constructor(db: DatabaseSync, now: () => number = Date.now) { this.db = db; this.now = now; migrateLedger(db); }

  private account(owner: string, kind: string): { id: number; balance: number; allow_negative: number } {
    this.db.prepare('INSERT OR IGNORE INTO ledger_accounts (owner, kind) VALUES (?, ?)').run(owner, kind);
    return this.db.prepare('SELECT id, balance, allow_negative FROM ledger_accounts WHERE owner = ? AND kind = ?').get(owner, kind) as unknown as { id: number; balance: number; allow_negative: number };
  }

  /**
   * Post one transaction: `from` loses `amount`, `to` gains it, atomically. Debits are applied before credits and
   * a non-negative account can never go below zero. Same key again: nothing changes; returns false.
   */
  private post(key: string, type: string, userId: number | null, amount: number, from: [string, string], to: [string, string], memo: string | null = null): boolean {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new LedgerError(400, 'Amounts are whole kobo above zero.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT 1 FROM ledger_tx WHERE key = ?').get(key)) { this.db.exec('ROLLBACK'); return false; }
      const a = this.account(...from), b = this.account(...to);
      if (!a.allow_negative && a.balance < amount) throw new LedgerError(409, 'Not enough money.');
      const tx = Number(this.db.prepare('INSERT INTO ledger_tx (key, type, user_id, memo, created_at) VALUES (?, ?, ?, ?, ?)').run(key, type, userId, memo, this.now()).lastInsertRowid);
      for (const [acct, delta] of [[a, -amount], [b, amount]] as const) {
        const after = acct.balance + delta;
        this.db.prepare('UPDATE ledger_accounts SET balance = ? WHERE id = ?').run(after, acct.id);
        this.db.prepare('INSERT INTO ledger_entries (tx_id, account_id, amount, balance_after) VALUES (?, ?, ?, ?)').run(tx, acct.id, delta, after);
      }
      this.db.exec('COMMIT');
      return true;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  balance(userId: number): Balance {
    const r = (kind: Kind) => (this.db.prepare('SELECT balance FROM ledger_accounts WHERE owner = ? AND kind = ?').get(`user:${userId}`, kind) as unknown as { balance: number } | undefined)?.balance ?? 0;
    return { availableKobo: r('available'), heldKobo: r('held') };
  }
  system(name: SystemAccount): number { return this.account('system', name).balance; }

  /** A verified Paystack payment. Credited once per reference. */
  deposit(userId: number, reference: string, kobo: number): boolean {
    return this.post(`paystack:${reference}`, 'deposit', userId, kobo, ['system', 'paystack'], [`user:${userId}`, 'available'], `Paystack ${reference}`);
  }
  /** StockRun's fee on a verified deposit: the buyer paid it on top at Paystack, so it goes straight to StockRun's
   *  income and never touches the buyer's balance. Once per reference. */
  depositFee(userId: number, reference: string, kobo: number): boolean {
    return this.post(`depfee:${reference}`, 'deposit_fee', userId, kobo, ['system', 'paystack'], ['system', 'fees'], `StockRun fee on Paystack ${reference}`);
  }
  /** Demo naira for trying StockRun without money: NOT real money, labelled as such, from the same system account. */
  demoCredit(userId: number, key: string, kobo: number): boolean {
    return this.post(`demo:${key}`, 'demo', userId, kobo, ['system', 'paystack'], [`user:${userId}`, 'available'], 'Demo naira (not real money)');
  }
  /** Demo naira a person received since `sinceMs` (for the daily cap). */
  demoSince(userId: number, sinceMs: number): number {
    const r = this.db.prepare(`SELECT COALESCE(SUM(e.amount), 0) s FROM ledger_tx t JOIN ledger_entries e ON e.tx_id = t.id JOIN ledger_accounts a ON a.id = e.account_id
      WHERE t.type = 'demo' AND t.user_id = ? AND t.created_at >= ? AND a.owner = ? AND a.kind = 'available'`).get(userId, sinceMs, `user:${userId}`) as unknown as { s: number };
    return r.s;
  }
  /** Lock money for an order (goods + delivery). Fails if the person has not got it. */
  hold(userId: number, orderKey: string, kobo: number): boolean {
    return this.post(`hold:${orderKey}`, 'hold', userId, kobo, [`user:${userId}`, 'available'], [`user:${userId}`, 'held'], orderKey);
  }
  /** Give back locked money that will not be spent (part not picked up, delivery fee withheld, refund). */
  release(userId: number, key: string, kobo: number): boolean {
    return this.post(`release:${key}`, 'release', userId, kobo, [`user:${userId}`, 'held'], [`user:${userId}`, 'available'], key);
  }
  /** Locked money now owed to the seller (a circuit decided). */
  paySeller(userId: number, key: string, kobo: number): boolean {
    return this.post(`seller:${key}`, 'pay_seller', userId, kobo, [`user:${userId}`, 'held'], ['system', 'sellers'], key);
  }
  /** An admin sent a seller's money by bank transfer: it leaves "sellers" (owed) for "paid_out", once per order. */
  recordSellerPayout(orderKey: string, kobo: number, reference: string): boolean {
    return this.post(`payout:${orderKey}`, 'seller_payout', null, kobo, ['system', 'sellers'], ['system', 'paid_out'], reference);
  }
  /** Paystack reported a seller transfer failed or reversed: the money is owed to the seller again. */
  reverseSellerPayout(orderKey: string, kobo: number, reason: string): boolean {
    return this.post(`payout-reversed:${orderKey}:${this.now()}`, 'seller_payout_reversed', null, kobo, ['system', 'paid_out'], ['system', 'sellers'], reason);
  }
  /** A buyer withdraws to their bank: the money leaves their balance before the transfer is asked for. */
  withdraw(userId: number, reference: string, kobo: number): boolean {
    return this.post(`withdraw:${reference}`, 'withdraw', userId, kobo, [`user:${userId}`, 'available'], ['system', 'paystack'], reference);
  }
  /** The withdrawal transfer failed: the money comes back to the buyer, once. */
  withdrawFailed(userId: number, reference: string, kobo: number): boolean {
    return this.post(`withdraw-failed:${reference}`, 'withdraw_failed', userId, kobo, ['system', 'paystack'], [`user:${userId}`, 'available'], reference);
  }
  /** A business pays its monthly store listing from its StockRun balance (StockRun's income). Once per key. */
  payListing(userId: number, key: string, kobo: number): boolean {
    return this.post(`listing:${key}`, 'listing_fee', userId, kobo, [`user:${userId}`, 'available'], ['system', 'listings'], key);
  }
  /** StockRun's service fee for a completed pickup, from the buyer's locked money (the seller's payment is untouched). */
  payFee(userId: number, key: string, kobo: number): boolean {
    return this.post(`fee:${key}`, 'service_fee', userId, kobo, [`user:${userId}`, 'held'], ['system', 'fees'], key);
  }

  /** A person's own history, newest first (what they see in the app). */
  history(userId: number, limit = 50): Movement[] {
    return (this.db.prepare(`SELECT t.key, t.type, e.amount, t.memo, t.created_at FROM ledger_tx t JOIN ledger_entries e ON e.tx_id = t.id
      JOIN ledger_accounts a ON a.id = e.account_id WHERE a.owner = ? AND a.kind = 'available' ORDER BY t.id DESC LIMIT ?`).all(`user:${userId}`, limit) as unknown as
      { key: string; type: string; amount: number; memo: string | null; created_at: number }[])
      .map((r) => ({ key: r.key, type: r.type, amountKobo: r.amount, memo: r.memo, at: r.created_at }));
  }

  /** Invariants, for tests and a health check: entries sum to zero per transaction; balances equal summed entries. */
  check(): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    for (const r of this.db.prepare('SELECT tx_id, SUM(amount) s FROM ledger_entries GROUP BY tx_id HAVING s <> 0').all() as unknown as { tx_id: number }[]) problems.push(`tx ${r.tx_id} does not balance`);
    for (const r of this.db.prepare('SELECT a.id, a.balance, COALESCE(SUM(e.amount), 0) s FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id GROUP BY a.id HAVING a.balance <> s').all() as unknown as { id: number }[]) problems.push(`account ${r.id} balance differs from its entries`);
    return { ok: problems.length === 0, problems };
  }
}

export const kobo = (naira: number) => Math.round(naira * 100);
export const toNaira = (k: number) => k / 100;
