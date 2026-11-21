// Paystack naira deposits (https://paystack.com/docs/api/transaction). Server side only; the secret key never reaches
// a browser. Test keys (sk_test_...) move no money.
//
// Flow: the app asks for a deposit -> we create a reference tied to that person and Paystack gives a checkout link ->
// they pay -> Paystack sends them back (and calls our webhook) -> we ask Paystack to verify the reference and credit
// the ledger once, only if Paystack says it succeeded, in NGN, for the amount we asked, for that person.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Ledger } from './ledger.ts';

const API = 'https://api.paystack.co';
export const MIN_DEPOSIT_KOBO = 100_00;          // ₦100
export const MAX_DEPOSIT_KOBO = 5_000_000_00;    // ₦5,000,000 per deposit

export class PaystackError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = 'PaystackError'; this.status = status; }
}

export function migratePaystack(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS deposits (
    reference TEXT PRIMARY KEY, user_id INTEGER NOT NULL, amount_kobo INTEGER NOT NULL, status TEXT NOT NULL,
    created_at INTEGER NOT NULL, verified_at INTEGER)`);
}

export interface PaystackOptions { secretKey: string; callbackUrl: string; fetch?: typeof fetch }

export class Paystack {
  readonly test: boolean;
  private key: string; private callbackUrl: string; private fetch: typeof fetch;
  private db: DatabaseSync; private ledger: Ledger;
  constructor(db: DatabaseSync, ledger: Ledger, o: PaystackOptions) {
    if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(o.secretKey)) throw new Error('PAYSTACK_SECRET_KEY does not look like a Paystack secret key (sk_test_... or sk_live_...)');
    this.key = o.secretKey; this.test = o.secretKey.startsWith('sk_test_'); this.callbackUrl = o.callbackUrl;
    this.fetch = o.fetch ?? fetch; this.db = db; this.ledger = ledger;
    migratePaystack(db);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.fetch(API + path, { method, headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
    const j = await r.json().catch(() => ({})) as { status?: boolean; message?: string; data?: T };
    if (!r.ok || !j.status) throw new PaystackError(r.status === 200 ? 502 : r.status, `Paystack: ${j.message ?? `HTTP ${r.status}`}`);
    return j.data as T;
  }

  /** Start a deposit: a reference only this person can complete, and Paystack's checkout link. */
  async start(userId: number, amountKobo: number, email: string): Promise<{ reference: string; checkoutUrl: string }> {
    if (!Number.isSafeInteger(amountKobo) || amountKobo < MIN_DEPOSIT_KOBO || amountKobo > MAX_DEPOSIT_KOBO) throw new PaystackError(400, 'Deposit between ₦100 and ₦5,000,000.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new PaystackError(400, 'Enter your email: Paystack sends the receipt there.');
    const reference = `sr_${userId}_${randomBytes(9).toString('hex')}`;
    this.db.prepare('INSERT INTO deposits (reference, user_id, amount_kobo, status, created_at) VALUES (?, ?, ?, ?, ?)').run(reference, userId, amountKobo, 'started', Date.now());
    const d = await this.call<{ authorization_url: string }>('POST', '/transaction/initialize', {
      email, amount: amountKobo, currency: 'NGN', reference, callback_url: this.callbackUrl,
      metadata: { userId, purpose: 'StockRun naira balance' },
    });
    return { reference, checkoutUrl: d.authorization_url };
  }

  /**
   * Verify with Paystack and credit the ledger once. Only references we issued, to the person who started them,
   * successful, in NGN, for the amount we asked. Safe to call any number of times (redirect, webhook, retries).
   */
  async confirm(reference: string, userId?: number): Promise<{ status: 'credited' | 'already' | 'pending' | 'failed'; amountKobo: number }> {
    const dep = this.db.prepare('SELECT user_id, amount_kobo, status FROM deposits WHERE reference = ?').get(reference) as unknown as { user_id: number; amount_kobo: number; status: string } | undefined;
    if (!dep || (userId !== undefined && dep.user_id !== userId)) throw new PaystackError(404, 'No such deposit.');
    if (dep.status === 'credited') return { status: 'already', amountKobo: dep.amount_kobo };
    const d = await this.call<{ status: string; amount: number; currency: string; reference: string; metadata?: { userId?: number | string } }>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    if (d.reference !== reference) throw new PaystackError(502, 'Paystack answered for a different payment.');
    if (d.status !== 'success') {
      // 'abandoned' only means the checkout was opened and not finished yet: the buyer can still pay, so it is pending.
      const final = d.status === 'failed' || d.status === 'reversed';
      if (final) this.db.prepare('UPDATE deposits SET status = ? WHERE reference = ?').run(d.status, reference);
      return { status: final ? 'failed' : 'pending', amountKobo: dep.amount_kobo };
    }
    if (d.currency !== 'NGN' || d.amount !== dep.amount_kobo || Number(d.metadata?.userId) !== dep.user_id) {
      this.db.prepare('UPDATE deposits SET status = ? WHERE reference = ?').run('mismatch', reference);
      throw new PaystackError(409, 'This payment does not match the deposit we started. StockRun will check it by hand.');
    }
    const fresh = this.ledger.deposit(dep.user_id, reference, dep.amount_kobo);
    this.db.prepare('UPDATE deposits SET status = ?, verified_at = ? WHERE reference = ?').run('credited', Date.now(), reference);
    return { status: fresh ? 'credited' : 'already', amountKobo: dep.amount_kobo };
  }

  /** Paystack webhook signature: HMAC-SHA512 of the raw body with the secret key, hex, in x-paystack-signature. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): { event: string; reference?: string } {
    const want = createHmac('sha512', this.key).update(rawBody).digest();
    const got = Buffer.from(String(signature ?? ''), 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new PaystackError(401, 'bad signature');
    const j = JSON.parse(rawBody.toString('utf8')) as { event?: string; data?: { reference?: string } };
    return { event: String(j.event), reference: j.data?.reference };
  }

  // ---------------------------------------------------------------- transfers (paying sellers, buyer withdrawals)
  // https://paystack.com/docs/transfers/single-transfers . Money leaves StockRun's Paystack balance. Test keys move none.
  private bankCache: { at: number; banks: { name: string; code: string }[] } | null = null;

  /** Nigerian banks Paystack can pay into (cached for a day). */
  async banks(): Promise<{ name: string; code: string }[]> {
    if (this.bankCache && Date.now() - this.bankCache.at < 24 * 3600_000) return this.bankCache.banks;
    const rows = await this.call<{ name: string; code: string; active?: boolean; is_deleted?: boolean; currency?: string }[]>('GET', '/bank?country=nigeria&currency=NGN&perPage=200');
    const banks = rows.filter((b) => b.active !== false && !b.is_deleted).map((b) => ({ name: b.name, code: b.code })).sort((a, b) => a.name.localeCompare(b.name));
    // Test mode checks only 3 real accounts a day; Paystack's test bank (code 001, any 10 digits) has no limit.
    if (this.test && !banks.some((b) => b.code === '001')) banks.unshift({ name: 'Paystack test bank (test mode only)', code: '001' });
    this.bankCache = { at: Date.now(), banks };
    return banks;
  }

  /** The account holder's name as the bank has it (checks the account exists). */
  async resolveAccount(accountNumber: string, bankCode: string): Promise<string> {
    if (!/^\d{10}$/.test(accountNumber)) throw new PaystackError(400, 'A Nigerian account number has 10 digits.');
    if (!/^[0-9A-Za-z-]{2,10}$/.test(bankCode)) throw new PaystackError(400, 'Choose the bank.');
    const d = await this.call<{ account_name?: string }>('GET', `/bank/resolve?account_number=${accountNumber}&bank_code=${encodeURIComponent(bankCode)}`)
      .catch((e: PaystackError) => { throw new PaystackError(400, `That account could not be found at this bank (${e.message.replace(/^Paystack: /, '')}).`); });
    if (!d.account_name) throw new PaystackError(400, 'That account could not be found at this bank.');
    return d.account_name;
  }

  /** Register a bank account to pay (Paystack's "transfer recipient"). */
  async createRecipient(name: string, accountNumber: string, bankCode: string): Promise<string> {
    const d = await this.call<{ recipient_code: string }>('POST', '/transferrecipient', { type: 'nuban', name, account_number: accountNumber, bank_code: bankCode, currency: 'NGN' });
    return d.recipient_code;
  }

  /**
   * Send money from the Paystack balance. `reference` makes it idempotent: Paystack refuses a second transfer with the
   * same reference. 'otp' means transfers need an OTP in the Paystack dashboard (turn it off for API transfers).
   */
  async transfer(o: { amountKobo: number; recipient: string; reference: string; reason: string }): Promise<{ status: 'success' | 'pending' | 'otp' | 'failed'; code: string | null }> {
    if (!Number.isSafeInteger(o.amountKobo) || o.amountKobo < 100) throw new PaystackError(400, 'Transfers are whole kobo, at least ₦1.');
    const d = await this.call<{ status?: string; transfer_code?: string }>('POST', '/transfer', { source: 'balance', amount: o.amountKobo, recipient: o.recipient, reference: o.reference, reason: o.reason.slice(0, 100), currency: 'NGN' });
    const s = d.status === 'success' || d.status === 'otp' ? d.status : ['pending', 'received', 'queued', 'processing'].includes(String(d.status)) ? 'pending' : 'failed';
    return { status: s, code: d.transfer_code ?? null };
  }
}
