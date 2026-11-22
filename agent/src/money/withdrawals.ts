// Buyers take naira back out of StockRun to their own bank, through Paystack Transfers.
// The money leaves the buyer's balance BEFORE the transfer is asked for (so it cannot be spent twice), and comes back
// once if Paystack refuses or later fails or reverses the transfer. The account name comes from the bank.
// Limits: at most `dailyLimitKobo` per person in 24 hours, and anything over `reviewOverKobo` waits for an admin to
// approve it (the money is already out of the balance, so it cannot be spent meanwhile; a rejection returns it).
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LedgerError, type Ledger } from './ledger.ts';
import { PaystackError, type Paystack } from './paystack.ts';

export const MIN_WITHDRAW_KOBO = 100_00, MAX_WITHDRAW_KOBO = 1_000_000_00;
export type WithdrawalStatus = 'review' | 'sending' | 'sent' | 'failed';
export interface Withdrawal { reference: string; amountKobo: number; bankName: string; accountNumber: string; accountName: string; status: WithdrawalStatus; note: string | null; at: number }
export interface AdminWithdrawal extends Withdrawal { userId: number; updatedAt: number }
export interface WithdrawalLimits { dailyLimitKobo: number; reviewOverKobo: number }
export const DEFAULT_LIMITS: WithdrawalLimits = { dailyLimitKobo: 500_000_00, reviewOverKobo: 200_000_00 };

const naira = (k: number) => `₦${(k / 100).toLocaleString('en-NG')}`;

export class Withdrawals {
  private db: DatabaseSync; private ledger: Ledger; readonly paystack: Paystack; private now: () => number;
  readonly limits: WithdrawalLimits;
  constructor(db: DatabaseSync, ledger: Ledger, paystack: Paystack, now: () => number = Date.now, limits: Partial<WithdrawalLimits> = {}) {
    this.db = db; this.ledger = ledger; this.paystack = paystack; this.now = now;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    db.exec(`CREATE TABLE IF NOT EXISTS withdrawals (
      reference TEXT PRIMARY KEY, user_id INTEGER NOT NULL, amount_kobo INTEGER NOT NULL, bank_name TEXT NOT NULL, account_number TEXT NOT NULL,
      account_name TEXT NOT NULL, status TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    if (!(db.prepare('PRAGMA table_info(withdrawals)').all() as unknown as { name: string }[]).some((c) => c.name === 'bank_code'))
      db.exec('ALTER TABLE withdrawals ADD COLUMN bank_code TEXT');
  }

  private set(reference: string, status: WithdrawalStatus, note: string | null) {
    this.db.prepare('UPDATE withdrawals SET status = ?, note = ?, updated_at = ? WHERE reference = ?').run(status, note, this.now(), reference);
  }

  /** What this person withdrew (or is withdrawing) in the last 24 hours. Failed ones do not count. */
  usedToday(userId: number): number {
    return Number((this.db.prepare("SELECT COALESCE(SUM(amount_kobo), 0) s FROM withdrawals WHERE user_id = ? AND status <> 'failed' AND created_at > ?")
      .get(userId, this.now() - 24 * 3600_000) as unknown as { s: number }).s);
  }

  /** Send `amountKobo` of the buyer's spendable naira to their bank account (or queue it for an admin if large). */
  async start(userId: number, amountKobo: number, bankCode: string, accountNumberRaw: string): Promise<Withdrawal> {
    if (!Number.isSafeInteger(amountKobo) || amountKobo < MIN_WITHDRAW_KOBO || amountKobo > MAX_WITHDRAW_KOBO) throw new LedgerError(400, 'Withdraw from ₦100 to ₦1,000,000 at a time.');
    const left = this.limits.dailyLimitKobo - this.usedToday(userId);
    if (amountKobo > left) throw new LedgerError(429, left > 0 ? `You can withdraw up to ${naira(left)} more today (${naira(this.limits.dailyLimitKobo)} a day).` : `That is the most you can withdraw today (${naira(this.limits.dailyLimitKobo)} a day). Try again tomorrow.`);
    if (this.ledger.balance(userId).availableKobo < amountKobo) throw new LedgerError(409, 'That is more than your spendable balance.');
    const accountNumber = String(accountNumberRaw ?? '').replace(/\D/g, '');
    const bank = (await this.paystack.banks()).find((b) => b.code === bankCode);
    if (!bank) throw new PaystackError(400, 'Choose your bank from the list.');
    const accountName = await this.paystack.resolveAccount(accountNumber, bankCode);
    const reference = `stockrun-wd-${userId}-${this.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    this.ledger.withdraw(userId, reference, amountKobo);                // money leaves first; throws if it is not there
    const review = amountKobo > this.limits.reviewOverKobo;
    this.db.prepare(`INSERT INTO withdrawals (reference, user_id, amount_kobo, bank_name, bank_code, account_number, account_name, status, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(reference, userId, amountKobo, bank.name, bankCode, accountNumber, accountName,
      review ? 'review' : 'sending', review ? `StockRun checks withdrawals over ${naira(this.limits.reviewOverKobo)} before sending them, usually within a day.` : null, this.now(), this.now());
    if (!review) await this.send(reference);
    return this.get(reference)!;
  }

  /** Ask Paystack to send a withdrawal that is 'sending'. Any refusal returns the money to the buyer once. */
  private async send(reference: string) {
    const w = this.row(reference)!;
    try {
      const recipient = await this.paystack.createRecipient(w.account_name, w.account_number, w.bank_code ?? '');
      const r = await this.paystack.transfer({ amountKobo: w.amount_kobo, recipient, reference, reason: 'StockRun withdrawal' });
      if (r.status === 'success' || r.status === 'pending') { this.set(reference, 'sent', r.status === 'pending' ? 'Paystack is processing it; it usually arrives within minutes.' : null); }
      else { this.giveBack(w.user_id, reference, w.amount_kobo, r.status === 'otp' ? 'Withdrawals need a setting changed at StockRun. Your money is back in your balance.' : 'Paystack did not accept the transfer. Your money is back in your balance.'); }
    } catch (e) {
      this.giveBack(w.user_id, reference, w.amount_kobo, `The transfer could not be sent (${(e as Error).message.replace(/^Paystack: /, '')}). Your money is back in your balance.`);
    }
  }

  private giveBack(userId: number, reference: string, amountKobo: number, note: string) {
    this.ledger.withdrawFailed(userId, reference, amountKobo);          // once per reference, whatever calls it
    this.set(reference, 'failed', note);
  }

  /** Admin: send a withdrawal that was waiting for review. */
  async approve(reference: string): Promise<AdminWithdrawal> {
    const w = this.row(reference);
    if (!w) throw new LedgerError(404, 'No such withdrawal.');
    if (w.status !== 'review') throw new LedgerError(409, 'This withdrawal is not waiting for review.');
    if (!w.bank_code) throw new LedgerError(409, 'This withdrawal has no bank code; reject it and ask the buyer to withdraw again.');
    // Claimed before sending, so a double click cannot send twice.
    const claimed = this.db.prepare("UPDATE withdrawals SET status = 'sending', note = NULL, updated_at = ? WHERE reference = ? AND status = 'review'").run(this.now(), reference);
    if (Number(claimed.changes) !== 1) throw new LedgerError(409, 'Someone else is already handling this withdrawal.');
    await this.send(reference);
    return this.adminGet(reference)!;
  }
  /** Admin: do not send a withdrawal under review; the money goes back to the buyer's balance. */
  reject(reference: string, reason: string): AdminWithdrawal {
    const w = this.row(reference);
    if (!w) throw new LedgerError(404, 'No such withdrawal.');
    if (w.status !== 'review') throw new LedgerError(409, 'Only a withdrawal waiting for review can be stopped here.');
    const why = String(reason ?? '').trim().slice(0, 200);
    if (why.length < 3) throw new LedgerError(400, 'Say why (the buyer sees this).');
    this.giveBack(w.user_id, reference, w.amount_kobo, `StockRun did not send this withdrawal: ${why}. Your money is back in your balance.`);
    return this.adminGet(reference)!;
  }

  /** Paystack says a withdrawal failed or was reversed: the money comes back to the buyer (once). */
  failed(reference: string, event: string): boolean {
    const w = this.row(reference);
    if (!w || w.status === 'failed') return false;
    this.giveBack(w.user_id, reference, w.amount_kobo, `Paystack reported the transfer ${event.replace('transfer.', '')}. Your money is back in your balance.`);
    return true;
  }
  succeeded(reference: string) { this.db.prepare("UPDATE withdrawals SET note = NULL, updated_at = ? WHERE reference = ? AND status = 'sent'").run(this.now(), reference); }

  private row(reference: string) { return this.db.prepare('SELECT * FROM withdrawals WHERE reference = ?').get(reference) as unknown as Row | undefined; }
  get(reference: string): Withdrawal | null { const r = this.row(reference); return r ? toW(r) : null; }
  adminGet(reference: string): AdminWithdrawal | null { const r = this.row(reference); return r ? toA(r) : null; }
  forUser(userId: number): Withdrawal[] {
    return (this.db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(userId) as unknown as Row[]).map(toW);
  }
  /** Admin: newest first, optionally one status. */
  all(status?: WithdrawalStatus, limit = 100): AdminWithdrawal[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM withdrawals WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
      : this.db.prepare('SELECT * FROM withdrawals ORDER BY created_at DESC LIMIT ?').all(limit);
    return (rows as unknown as Row[]).map(toA);
  }
  /** Money already out of buyers' balances but not yet confirmed sent (waiting for review, or being sent). */
  pendingKobo(): number {
    return Number((this.db.prepare("SELECT COALESCE(SUM(amount_kobo), 0) s FROM withdrawals WHERE status IN ('review', 'sending')").get() as unknown as { s: number }).s);
  }
}

interface Row { reference: string; user_id: number; amount_kobo: number; bank_name: string; bank_code: string | null; account_number: string; account_name: string; status: WithdrawalStatus; note: string | null; created_at: number; updated_at: number }
const toW = (r: Row): Withdrawal => ({ reference: r.reference, amountKobo: r.amount_kobo, bankName: r.bank_name, accountNumber: r.account_number, accountName: r.account_name, status: r.status, note: r.note, at: r.created_at });
const toA = (r: Row): AdminWithdrawal => ({ ...toW(r), userId: r.user_id, updatedAt: r.updated_at });
