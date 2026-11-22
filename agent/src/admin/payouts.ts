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
import { PaystackError, type Paystack } from '../money/paystack.ts';
import { supplierKey } from '../tools/suppliers.ts';

export type PayoutStatus = 'owed' | 'held' | 'paid';
export interface Bank { bankName: string; accountNumber: string; accountName: string; bankCode?: string | null; approved?: boolean; source?: 'admin' | 'seller' }
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
  /** Paystack, for paying sellers automatically; null: payouts are sent by hand and recorded. */
  readonly paystack: Paystack | null;
  private sweeping = false;
  /** True while an admin has paused seller payouts: nothing is sent through Paystack. */
  private paused: () => boolean;
  constructor(o: { db: DatabaseSync; ledger: Ledger; sellerOf: (key: Hash) => { name: string; phone: string | null } | null; now?: () => number; paystack?: Paystack | null; paused?: () => boolean }) {
    this.db = o.db; this.ledger = o.ledger; this.sellerOf = o.sellerOf; this.now = o.now ?? Date.now; this.paystack = o.paystack ?? null; this.paused = o.paused ?? (() => false);
    o.db.exec(`
      CREATE TABLE IF NOT EXISTS seller_payouts (
        order_id INTEGER PRIMARY KEY, status TEXT NOT NULL, reference TEXT, note TEXT, paid_at INTEGER, paid_by TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS seller_banks (
        seller_key TEXT PRIMARY KEY, bank_name TEXT NOT NULL, account_number TEXT NOT NULL, account_name TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_log (id INTEGER PRIMARY KEY, admin TEXT NOT NULL, action TEXT NOT NULL, order_id INTEGER, detail TEXT, at INTEGER NOT NULL);
    `);
    // Paystack payouts: the bank's code, Paystack's recipient, whether an admin approved the account (accounts a
    // seller typed in wait for that), and how many transfers were tried (each attempt needs a new reference).
    const has = (t: string, c: string) => (o.db.prepare(`PRAGMA table_info(${t})`).all() as unknown as { name: string }[]).some((x) => x.name === c);
    for (const [c, def] of [['bank_code', 'TEXT'], ['recipient_code', 'TEXT'], ['approved', 'INTEGER NOT NULL DEFAULT 1'], ['source', "TEXT NOT NULL DEFAULT 'admin'"]] as const)
      if (!has('seller_banks', c)) o.db.exec(`ALTER TABLE seller_banks ADD COLUMN ${c} ${def}`);
    if (!has('seller_payouts', 'attempts')) o.db.exec('ALTER TABLE seller_payouts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  }

  private log(admin: string, action: string, orderId: number | null, detail: string) {
    this.db.prepare('INSERT INTO admin_log (admin, action, order_id, detail, at) VALUES (?, ?, ?, ?, ?)').run(admin, action, orderId, detail, this.now());
  }

  /** Every seller payment PickupCheck approved (naira), newest first, with what the admin has done about it. */
  list(): Payout[] {
    const rows = this.db.prepare(`
      SELECT o.id AS order_id, o.supplier_key, o.user_id, e.amount AS amount, t.created_at AS approved_at,
             p.status, p.reference, p.note, p.paid_at, p.paid_by,
             b.bank_name, b.account_number, b.account_name, b.bank_code, b.approved, b.source,
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
        note: string | null; paid_at: number | null; paid_by: string | null; bank_name: string | null; account_number: string | null; account_name: string | null; bank_code: string | null; approved: number | null; source: 'admin' | 'seller' | null;
        email: string | null; username: string | null; wallet: string | null }[];
    return rows.map((r) => {
      const s = this.sellerOf(r.supplier_key as Hash);
      return {
        orderId: r.order_id, amountKobo: r.amount, approvedAt: r.approved_at, status: r.status ?? 'owed',
        buyer: r.username ? `@${r.username}` : r.email ?? (r.wallet ? `${r.wallet.slice(0, 6)}…${r.wallet.slice(-4)}` : `user ${r.user_id}`),
        seller: { key: r.supplier_key, name: s?.name ?? 'Unknown seller', phone: s?.phone ?? null },
        bank: r.bank_name ? { bankName: r.bank_name, accountNumber: r.account_number!, accountName: r.account_name!, bankCode: r.bank_code, approved: r.approved !== 0, source: r.source ?? 'admin' } : null,
        reference: r.reference, note: r.note, paidAt: r.paid_at, paidBy: r.paid_by,
      };
    });
  }

  private one(orderId: number): Payout {
    const p = this.list().find((x) => x.orderId === orderId);
    if (!p) throw new AdminError(404, 'No seller payment was approved for that order: PickupCheck has not paid it.');
    return p;
  }

  /**
   * The seller's bank account (kept for their next orders too), entered by an admin: approved for payouts.
   * With Paystack and a bank code, the account name comes from the bank, not from what was typed.
   */
  async setBank(admin: string, orderId: number, raw: Partial<Bank>): Promise<Payout> {
    const p = this.one(orderId);
    if (p.status === 'paid') throw new AdminError(409, 'This payout is already paid.');
    const accountNumber = String(raw.accountNumber ?? '').replace(/\D/g, ''), bankCode = String(raw.bankCode ?? '').trim();
    let bankName = String(raw.bankName ?? '').trim(), accountName = String(raw.accountName ?? '').trim();
    if (!/^\d{10}$/.test(accountNumber)) throw new AdminError(400, 'A Nigerian account number has 10 digits (NUBAN).');
    if (this.paystack && bankCode) {
      const bank = (await this.paystackTry(() => this.paystack!.banks())).find((b) => b.code === bankCode);
      if (!bank) throw new AdminError(400, 'Choose the bank from the list.');
      bankName = bank.name;
      accountName = await this.paystackTry(() => this.paystack!.resolveAccount(accountNumber, bankCode));
    }
    if (bankName.length < 2 || bankName.length > 60) throw new AdminError(400, 'Enter the bank name.');
    if (accountName.length < 3 || accountName.length > 80) throw new AdminError(400, 'Enter the account name exactly as the bank shows it.');
    this.saveBank(p.seller.key, { bankName, accountNumber, accountName, bankCode: bankCode || null }, true, 'admin', admin);
    this.log(admin, 'set_bank', orderId, `${bankName} ${accountNumber.slice(0, 3)}****${accountNumber.slice(-3)} ${accountName}`);
    return this.one(orderId);
  }

  private saveBank(sellerKey: string, b: { bankName: string; accountNumber: string; accountName: string; bankCode: string | null }, approved: boolean, source: 'admin' | 'seller', by: string) {
    this.db.prepare(`INSERT INTO seller_banks (seller_key, bank_name, account_number, account_name, bank_code, recipient_code, approved, source, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      ON CONFLICT(seller_key) DO UPDATE SET bank_name = excluded.bank_name, account_number = excluded.account_number, account_name = excluded.account_name,
        bank_code = excluded.bank_code, recipient_code = NULL, approved = excluded.approved, source = excluded.source, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(sellerKey.toLowerCase(), b.bankName, b.accountNumber, b.accountName, b.bankCode, approved ? 1 : 0, source, this.now(), by);
  }

  /**
   * A seller adds their own bank account from the link a buyer forwarded. The name comes from the bank (Paystack).
   * It waits for an admin to approve it before any payout, and the link cannot replace an account already approved:
   * otherwise whoever holds the link could redirect this seller's payments.
   */
  async sellerSubmitBank(sellerId: string, raw: { bankCode?: unknown; accountNumber?: unknown }): Promise<{ accountName: string; bankName: string }> {
    if (!this.paystack) throw new AdminError(503, 'Bank details by link are not switched on yet. Send them to StockRun on WhatsApp.');
    const key = supplierKey(sellerId).toLowerCase();
    const cur = this.db.prepare('SELECT approved FROM seller_banks WHERE seller_key = ?').get(key) as unknown as { approved: number } | undefined;
    if (cur?.approved) throw new AdminError(409, 'Your bank account is already set up. To change it, contact StockRun.');
    const accountNumber = String(raw.accountNumber ?? '').replace(/\D/g, ''), bankCode = String(raw.bankCode ?? '').trim();
    const bank = (await this.paystackTry(() => this.paystack!.banks())).find((b) => b.code === bankCode);
    if (!bank) throw new AdminError(400, 'Choose your bank from the list.');
    const accountName = await this.paystackTry(() => this.paystack!.resolveAccount(accountNumber, bankCode));
    this.saveBank(key, { bankName: bank.name, accountNumber, accountName, bankCode }, false, 'seller', `seller ${sellerId}`);
    this.log('seller link', 'seller_bank', null, `${this.sellerName(key)}: ${bank.name} ****${accountNumber.slice(-4)} ${accountName} (waiting for approval)`);
    return { accountName, bankName: bank.name };
  }

  /** The bank account on file for a seller (any order), or null. */
  bankFor(sellerId: string): Bank | null {
    const r = this.db.prepare('SELECT bank_name, account_number, account_name, bank_code, approved, source FROM seller_banks WHERE seller_key = ?').get(supplierKey(sellerId).toLowerCase()) as unknown as
      { bank_name: string; account_number: string; account_name: string; bank_code: string | null; approved: number; source: 'admin' | 'seller' } | undefined;
    return r ? { bankName: r.bank_name, accountNumber: r.account_number, accountName: r.account_name, bankCode: r.bank_code, approved: !!r.approved, source: r.source } : null;
  }
  approveBankFor(sellerId: string, by: string) {
    this.db.prepare('UPDATE seller_banks SET approved = 1, updated_at = ?, updated_by = ? WHERE seller_key = ?').run(this.now(), by, supplierKey(sellerId).toLowerCase());
  }

  /** An admin checked the name on a seller-submitted account against the business: payouts may go there now. */
  approveBank(admin: string, orderId: number): Payout {
    const p = this.one(orderId);
    if (!p.bank) throw new AdminError(409, 'There is no bank account to approve.');
    this.db.prepare('UPDATE seller_banks SET approved = 1, updated_at = ?, updated_by = ? WHERE seller_key = ?').run(this.now(), admin, p.seller.key.toLowerCase());
    this.log(admin, 'approve_bank', orderId, `${p.bank.bankName} ****${p.bank.accountNumber.slice(-4)} ${p.bank.accountName}`);
    return this.one(orderId);
  }

  private async paystackTry<T>(f: () => Promise<T>): Promise<T> {
    try { return await f(); } catch (e) { if (e instanceof PaystackError) throw new AdminError(e.status >= 500 ? 502 : e.status, e.message.replace(/^Paystack: /, 'Paystack: ')); throw e; }
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

  /**
   * Pay one approved payout through Paystack, if everything is in place: Paystack on, the payout owed (not held or
   * paid), and the seller's bank account approved by an admin. Exactly the amount PickupCheck approved, once.
   */
  async autoPay(orderId: number): Promise<'paid' | 'skipped' | 'failed'> {
    const ps = this.paystack;
    if (!ps || this.paused()) return 'skipped';
    const p = this.list().find((x) => x.orderId === orderId);
    if (!p || p.status !== 'owed' || !p.bank?.approved || !p.bank.bankCode) return 'skipped';
    const key = p.seller.key.toLowerCase();
    try {
      let recipient = (this.db.prepare('SELECT recipient_code FROM seller_banks WHERE seller_key = ?').get(key) as unknown as { recipient_code: string | null }).recipient_code;
      if (!recipient) {
        recipient = await ps.createRecipient(p.bank.accountName, p.bank.accountNumber, p.bank.bankCode);
        this.db.prepare('UPDATE seller_banks SET recipient_code = ? WHERE seller_key = ?').run(recipient, key);
      }
      const attempts = Number((this.db.prepare('SELECT attempts FROM seller_payouts WHERE order_id = ?').get(orderId) as unknown as { attempts: number } | undefined)?.attempts ?? 0);
      const reference = `stockrun-payout-${orderId}-${attempts + 1}`;
      // Marked before sending: if the server stops mid-way, the automatic sweep leaves this one for an admin to check
      // in Paystack (so a transfer that did go out is never sent twice).
      this.upsert(orderId, 'owed', { note: `Sending through Paystack (ref ${reference}). If this stays, check Paystack before paying again.` });
      this.db.prepare('UPDATE seller_payouts SET attempts = ? WHERE order_id = ?').run(attempts + 1, orderId);
      const r = await ps.transfer({ amountKobo: p.amountKobo, recipient, reference, reason: `StockRun order #${orderId}` });
      if (r.status === 'success' || r.status === 'pending') {
        this.ledger.recordSellerPayout(`order:${orderId}`, p.amountKobo, reference);
        this.upsert(orderId, 'paid', { reference, paid_at: this.now(), paid_by: 'paystack' });
        if (r.status === 'pending') this.db.prepare('UPDATE seller_payouts SET note = ? WHERE order_id = ?').run('Paystack is processing the transfer.', orderId);
        this.log('paystack', 'paid', orderId, `${p.amountKobo / 100} NGN to ${p.bank.bankName} ****${p.bank.accountNumber.slice(-4)} ref ${reference}${ps.test ? ' (test mode)' : ''}`);
        return 'paid';
      }
      this.upsert(orderId, 'owed', { note: r.status === 'otp'
        ? 'Paystack asks for an OTP for each transfer. Turn off OTP for transfers in Paystack settings, or pay by hand.'
        : 'Paystack did not accept the transfer. Try again, or pay by hand.' });
      return 'failed';
    } catch (e) {
      this.upsert(orderId, 'owed', { note: `Paystack transfer not sent: ${(e as Error).message.replace(/^Paystack: /, '')}` });
      return 'failed';
    }
  }

  /** Pay every payout that is ready (called after each pickup and every few seconds). One sweep at a time. */
  async sweep(): Promise<number> {
    if (!this.paystack || this.sweeping || this.paused()) return 0;
    this.sweeping = true;
    let paid = 0;
    try {
      for (const p of this.list().filter((x) => x.status === 'owed' && x.bank?.approved && x.bank.bankCode && !x.note)) {
        if (await this.autoPay(p.orderId) === 'paid') paid++;
      }
    } finally { this.sweeping = false; }
    return paid;
  }

  /** Paystack says a payout transfer failed or was reversed: the seller is owed again, and an admin should look. */
  transferFailed(reference: string, event: string): boolean {
    const row = this.db.prepare("SELECT order_id FROM seller_payouts WHERE reference = ? AND status = 'paid' AND paid_by = 'paystack'").get(reference) as unknown as { order_id: number } | undefined;
    if (!row) return false;
    const p = this.one(row.order_id);
    this.ledger.reverseSellerPayout(`order:${row.order_id}`, p.amountKobo, `${event} ${reference}`);
    this.db.prepare("UPDATE seller_payouts SET status = 'owed', paid_at = NULL, paid_by = NULL, note = ?, updated_at = ? WHERE order_id = ?")
      .run(`Paystack reported the transfer ${event.replace('transfer.', '')}. Check the bank account, then pay again.`, this.now(), row.order_id);
    this.log('paystack', event, row.order_id, reference);
    return true;
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
