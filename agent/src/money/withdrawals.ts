// Buyers take naira back out of StockRun to their own bank, through Paystack Transfers.
// The money leaves the buyer's balance BEFORE the transfer is asked for (so it cannot be spent twice), and comes back
// once if Paystack refuses or later fails or reverses the transfer. The account name comes from the bank.
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LedgerError, type Ledger } from './ledger.ts';
import { PaystackError, type Paystack } from './paystack.ts';

export const MIN_WITHDRAW_KOBO = 100_00, MAX_WITHDRAW_KOBO = 1_000_000_00;
export interface Withdrawal { reference: string; amountKobo: number; bankName: string; accountNumber: string; accountName: string; status: 'sending' | 'sent' | 'failed'; note: string | null; at: number }

export class Withdrawals {
  private db: DatabaseSync; private ledger: Ledger; readonly paystack: Paystack; private now: () => number;
  constructor(db: DatabaseSync, ledger: Ledger, paystack: Paystack, now: () => number = Date.now) {
    this.db = db; this.ledger = ledger; this.paystack = paystack; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS withdrawals (
      reference TEXT PRIMARY KEY, user_id INTEGER NOT NULL, amount_kobo INTEGER NOT NULL, bank_name TEXT NOT NULL, account_number TEXT NOT NULL,
      account_name TEXT NOT NULL, status TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  }

  private set(reference: string, status: Withdrawal['status'], note: string | null) {
    this.db.prepare('UPDATE withdrawals SET status = ?, note = ?, updated_at = ? WHERE reference = ?').run(status, note, this.now(), reference);
  }

  /** Send `amountKobo` of the buyer's spendable naira to their bank account. */
  async start(userId: number, amountKobo: number, bankCode: string, accountNumberRaw: string): Promise<Withdrawal> {
    if (!Number.isSafeInteger(amountKobo) || amountKobo < MIN_WITHDRAW_KOBO || amountKobo > MAX_WITHDRAW_KOBO) throw new LedgerError(400, 'Withdraw from ₦100 to ₦1,000,000 at a time.');
    if (this.ledger.balance(userId).availableKobo < amountKobo) throw new LedgerError(409, 'That is more than your spendable balance.');
    const accountNumber = String(accountNumberRaw ?? '').replace(/\D/g, '');
    const bank = (await this.paystack.banks()).find((b) => b.code === bankCode);
    if (!bank) throw new PaystackError(400, 'Choose your bank from the list.');
    const accountName = await this.paystack.resolveAccount(accountNumber, bankCode);
    const reference = `stockrun-wd-${userId}-${this.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    this.ledger.withdraw(userId, reference, amountKobo);                // money leaves first; throws if it is not there
    this.db.prepare(`INSERT INTO withdrawals (reference, user_id, amount_kobo, bank_name, account_number, account_name, status, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'sending', NULL, ?, ?)`).run(reference, userId, amountKobo, bank.name, accountNumber, accountName, this.now(), this.now());
    try {
      const recipient = await this.paystack.createRecipient(accountName, accountNumber, bankCode);
      const r = await this.paystack.transfer({ amountKobo, recipient, reference, reason: 'StockRun withdrawal' });
      if (r.status === 'success' || r.status === 'pending') { this.set(reference, 'sent', r.status === 'pending' ? 'Paystack is processing it; it usually arrives within minutes.' : null); }
      else { this.giveBack(userId, reference, amountKobo, r.status === 'otp' ? 'Withdrawals need a setting changed at StockRun. Your money is back in your balance.' : 'Paystack did not accept the transfer. Your money is back in your balance.'); }
    } catch (e) {
      this.giveBack(userId, reference, amountKobo, `The transfer could not be sent (${(e as Error).message.replace(/^Paystack: /, '')}). Your money is back in your balance.`);
    }
    return this.get(reference)!;
  }

  private giveBack(userId: number, reference: string, amountKobo: number, note: string) {
    this.ledger.withdrawFailed(userId, reference, amountKobo);          // once per reference, whatever calls it
    this.set(reference, 'failed', note);
  }

  /** Paystack says a withdrawal failed or was reversed: the money comes back to the buyer (once). */
  failed(reference: string, event: string): boolean {
    const w = this.db.prepare("SELECT user_id, amount_kobo, status FROM withdrawals WHERE reference = ?").get(reference) as unknown as { user_id: number; amount_kobo: number; status: string } | undefined;
    if (!w || w.status === 'failed') return false;
    this.giveBack(w.user_id, reference, w.amount_kobo, `Paystack reported the transfer ${event.replace('transfer.', '')}. Your money is back in your balance.`);
    return true;
  }
  succeeded(reference: string) { this.db.prepare("UPDATE withdrawals SET note = NULL, updated_at = ? WHERE reference = ? AND status = 'sent'").run(this.now(), reference); }

  get(reference: string): Withdrawal | null {
    const r = this.db.prepare('SELECT * FROM withdrawals WHERE reference = ?').get(reference) as unknown as Row | undefined;
    return r ? toW(r) : null;
  }
  forUser(userId: number): Withdrawal[] {
    return (this.db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(userId) as unknown as Row[]).map(toW);
  }
}

interface Row { reference: string; amount_kobo: number; bank_name: string; account_number: string; account_name: string; status: Withdrawal['status']; note: string | null; created_at: number }
const toW = (r: Row): Withdrawal => ({ reference: r.reference, amountKobo: r.amount_kobo, bankName: r.bank_name, accountNumber: r.account_number, accountName: r.account_name, status: r.status, note: r.note, at: r.created_at });
