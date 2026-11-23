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
  const cols = db.prepare('PRAGMA table_info(deposits)').all() as unknown as { name: string }[];
  if (!cols.some((c) => c.name === 'charge_kobo')) db.exec('ALTER TABLE deposits ADD COLUMN charge_kobo INTEGER NOT NULL DEFAULT 0');
  if (!cols.some((c) => c.name === 'fee_kobo')) db.exec('ALTER TABLE deposits ADD COLUMN fee_kobo INTEGER NOT NULL DEFAULT 0');
}

/** StockRun's fee on a deposit: `bps` of it (150 = 1.5%), rounded down to the kobo. Paid by the buyer on top. */
export const stockrunDepositFee = (amountKobo: number, bps: number) => (bps > 0 && amountKobo > 0 ? Math.floor((amountKobo * bps) / 10_000) : 0);

/**
 * Paystack's fee on a local card payment, which the buyer pays on top of a deposit so their balance gets the full
 * amount: `bps` of the payment plus `flatKobo` (waived under `waiveUnderKobo`), capped at `capKobo`.
 * Defaults follow Paystack's published local pricing (1.5% + ₦100, ₦100 waived under ₦2,500, capped at ₦2,000).
 */
export interface DepositCharge { bps: number; flatKobo: number; waiveUnderKobo: number; capKobo: number }
export const PAYSTACK_LOCAL: DepositCharge = { bps: 150, flatKobo: 100_00, waiveUnderKobo: 2_500_00, capKobo: 2_000_00 };

/** What Paystack keeps from a payment of `grossKobo` (rounded up, so StockRun is never short). */
export const paystackFee = (grossKobo: number, c: DepositCharge) =>
  Math.min(c.capKobo, Math.ceil((grossKobo * c.bps) / 10_000) + (grossKobo >= c.waiveUnderKobo ? c.flatKobo : 0));

/** The charge to add to a deposit of `amountKobo` so that, after Paystack's fee, StockRun receives at least the deposit. */
export function depositCharge(amountKobo: number, c: DepositCharge | null): number {
  if (!c || amountKobo <= 0) return 0;
  let gross = Math.ceil((amountKobo * 10_000) / (10_000 - c.bps));
  if (gross >= c.waiveUnderKobo) gross = Math.ceil(((amountKobo + c.flatKobo) * 10_000) / (10_000 - c.bps));
  if (paystackFee(gross, c) >= c.capKobo) gross = Math.min(gross, amountKobo + c.capKobo);
  while (gross - paystackFee(gross, c) < amountKobo) gross++;               // rounding: never short
  return gross - amountKobo;
}

export interface AdminDeposit { reference: string; userId: number; amountKobo: number; feeKobo: number; chargeKobo: number; status: string; createdAt: number; verifiedAt: number | null }
type DepositRow = { reference: string; user_id: number; amount_kobo: number; fee_kobo: number; charge_kobo: number; status: string; created_at: number; verified_at: number | null };
const toDeposit = (r: DepositRow): AdminDeposit => ({ reference: r.reference, userId: r.user_id, amountKobo: r.amount_kobo, feeKobo: r.fee_kobo ?? 0, chargeKobo: r.charge_kobo, status: r.status, createdAt: r.created_at, verifiedAt: r.verified_at });

/** What a deposit costs the buyer: the deposit, StockRun's fee and Paystack's charge (on deposit + fee). */
export function depositQuote(amountKobo: number, feeBps: number, charge: DepositCharge | null) {
  const feeKobo = stockrunDepositFee(amountKobo, feeBps), chargeKobo = depositCharge(amountKobo + feeKobo, charge);
  return { amountKobo, feeKobo, chargeKobo, totalKobo: amountKobo + feeKobo + chargeKobo };
}

export interface PaystackOptions {
  secretKey: string; callbackUrl: string; fetch?: typeof fetch; depositCharge?: DepositCharge | null;
  /** StockRun's fee on every deposit, in basis points (150 = 1.5%), paid by the buyer on top. 0 or absent: none. */
  depositFeeBps?: number;
}

export class Paystack {
  readonly test: boolean;
  /** Paystack's fee the buyer pays on top of a deposit; null: StockRun absorbs it. */
  readonly charge: DepositCharge | null;
  /** StockRun's fee on every deposit (basis points), paid by the buyer on top; it goes to StockRun's income. */
  readonly feeBps: number;
  private key: string; private callbackUrl: string; private fetch: typeof fetch;
  private db: DatabaseSync; private ledger: Ledger;
  constructor(db: DatabaseSync, ledger: Ledger, o: PaystackOptions) {
    if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(o.secretKey)) throw new Error('PAYSTACK_SECRET_KEY does not look like a Paystack secret key (sk_test_... or sk_live_...)');
    this.key = o.secretKey; this.test = o.secretKey.startsWith('sk_test_'); this.callbackUrl = o.callbackUrl;
    this.fetch = o.fetch ?? fetch; this.db = db; this.ledger = ledger; this.charge = o.depositCharge ?? null;
    this.feeBps = Math.max(0, Math.round(o.depositFeeBps ?? 0));
    if (this.feeBps > 1_000) throw new Error('The deposit fee must be 10% or less.');
    migratePaystack(db);
  }
  quote(amountKobo: number) { return depositQuote(amountKobo, this.feeBps, this.charge); }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.fetch(API + path, { method, headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
    const j = await r.json().catch(() => ({})) as { status?: boolean; message?: string; data?: T };
    if (!r.ok || !j.status) throw new PaystackError(r.status === 200 ? 502 : r.status, `Paystack: ${j.message ?? `HTTP ${r.status}`}`);
    return j.data as T;
  }

  /** Start a deposit: a reference only this person can complete, and Paystack's checkout link. */
  async start(userId: number, amountKobo: number, email: string): Promise<{ reference: string; checkoutUrl: string; chargeKobo: number; feeKobo: number; totalKobo: number }> {
    if (!Number.isSafeInteger(amountKobo) || amountKobo < MIN_DEPOSIT_KOBO || amountKobo > MAX_DEPOSIT_KOBO) throw new PaystackError(400, 'Deposit between ₦100 and ₦5,000,000.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new PaystackError(400, 'Enter your email: Paystack sends the receipt there.');
    const reference = `sr_${userId}_${randomBytes(9).toString('hex')}`;
    const q = this.quote(amountKobo);
    this.db.prepare('INSERT INTO deposits (reference, user_id, amount_kobo, fee_kobo, charge_kobo, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(reference, userId, amountKobo, q.feeKobo, q.chargeKobo, 'started', Date.now());
    const d = await this.call<{ authorization_url: string }>('POST', '/transaction/initialize', {
      email, amount: q.totalKobo, currency: 'NGN', reference, callback_url: this.callbackUrl,
      metadata: { userId, purpose: 'StockRun naira balance', depositKobo: amountKobo, stockrunFeeKobo: q.feeKobo, paystackChargeKobo: q.chargeKobo },
    });
    return { reference, checkoutUrl: d.authorization_url, chargeKobo: q.chargeKobo, feeKobo: q.feeKobo, totalKobo: q.totalKobo };
  }

  /**
   * Verify with Paystack and credit the ledger once. Only references we issued, to the person who started them,
   * successful, in NGN, for the amount we asked. Safe to call any number of times (redirect, webhook, retries).
   */
  async confirm(reference: string, userId?: number): Promise<{ status: 'credited' | 'already' | 'pending' | 'failed'; amountKobo: number }> {
    const dep = this.db.prepare('SELECT user_id, amount_kobo, fee_kobo, charge_kobo, status FROM deposits WHERE reference = ?').get(reference) as unknown as { user_id: number; amount_kobo: number; fee_kobo: number; charge_kobo: number; status: string } | undefined;
    if (!dep || (userId !== undefined && dep.user_id !== userId)) throw new PaystackError(404, 'No such deposit.');
    if (dep.status === 'credited') return { status: 'already', amountKobo: dep.amount_kobo };
    // An admin settles these by hand (resolveMismatch); a webhook or redirect must not touch them.
    if (dep.status === 'mismatch' || dep.status === 'resolving') throw new PaystackError(409, 'This payment does not match the deposit we started. StockRun will check it by hand.');
    if (dep.status === 'refunded') return { status: 'failed', amountKobo: dep.amount_kobo };
    const d = await this.call<{ status: string; amount: number; currency: string; reference: string; metadata?: { userId?: number | string } }>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    if (d.reference !== reference) throw new PaystackError(502, 'Paystack answered for a different payment.');
    if (d.status !== 'success') {
      // 'abandoned' only means the checkout was opened and not finished yet: the buyer can still pay, so it is pending.
      const final = d.status === 'failed' || d.status === 'reversed';
      if (final) this.db.prepare('UPDATE deposits SET status = ? WHERE reference = ?').run(d.status, reference);
      return { status: final ? 'failed' : 'pending', amountKobo: dep.amount_kobo };
    }
    // Paystack must have taken the deposit plus StockRun's fee plus the charge we asked for; the buyer's balance gets
    // the deposit and StockRun's income gets the fee.
    if (d.currency !== 'NGN' || d.amount !== dep.amount_kobo + dep.fee_kobo + dep.charge_kobo || Number(d.metadata?.userId) !== dep.user_id) {
      this.db.prepare('UPDATE deposits SET status = ? WHERE reference = ?').run('mismatch', reference);
      throw new PaystackError(409, 'This payment does not match the deposit we started. StockRun will check it by hand.');
    }
    const fresh = this.ledger.deposit(dep.user_id, reference, dep.amount_kobo);
    if (dep.fee_kobo > 0) this.ledger.depositFee(dep.user_id, reference, dep.fee_kobo);       // once per reference
    this.db.prepare('UPDATE deposits SET status = ?, verified_at = ? WHERE reference = ?').run('credited', Date.now(), reference);
    return { status: fresh ? 'credited' : 'already', amountKobo: dep.amount_kobo };
  }

  // ---------------------------------------------------------------- admin: deposits to check, the books
  /** StockRun's NGN balance at Paystack, in kobo (read only). */
  async balanceKobo(): Promise<number> {
    const rows = await this.call<{ currency: string; balance: number }[]>('GET', '/balance');
    return rows.filter((r) => r.currency === 'NGN').reduce((s, r) => s + r.balance, 0);
  }

  /** Deposits, newest first: one status, or all. */
  deposits(status?: string, limit = 100): AdminDeposit[] {
    const rows = (status
      ? this.db.prepare('SELECT * FROM deposits WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
      : this.db.prepare('SELECT * FROM deposits ORDER BY created_at DESC LIMIT ?').all(limit)) as unknown as DepositRow[];
    return rows.map(toDeposit);
  }
  depositsFor(userId: number, limit = 20): AdminDeposit[] {
    return (this.db.prepare('SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit) as unknown as DepositRow[]).map(toDeposit);
  }

  /**
   * Admin: settle a deposit that did not match what we started (status 'mismatch'), following what Paystack says
   * was really paid. 'credit': the buyer's balance gets what Paystack received minus the charge we asked for (never
   * more than was paid), once, under the same reference. 'refund': Paystack sends the payment back to the payer and
   * nothing is credited. Neither is possible unless Paystack confirms a successful NGN payment for this reference.
   */
  async resolveMismatch(reference: string, action: 'credit' | 'refund'): Promise<AdminDeposit & { creditedKobo?: number }> {
    const dep = this.db.prepare('SELECT * FROM deposits WHERE reference = ?').get(reference) as unknown as DepositRow | undefined;
    if (!dep) throw new PaystackError(404, 'No such deposit.');
    if (dep.status !== 'mismatch') throw new PaystackError(409, 'Only a deposit marked "does not match" can be settled here.');
    // Claimed first, so two admins (or a double click) cannot both credit, or credit and refund, the same payment.
    if (Number(this.db.prepare("UPDATE deposits SET status = 'resolving' WHERE reference = ? AND status = 'mismatch'").run(reference).changes) !== 1)
      throw new PaystackError(409, 'Someone else is already settling this deposit.');
    try {
      const d = await this.call<{ status: string; amount: number; currency: string; reference: string }>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
      if (d.reference !== reference || d.status !== 'success') throw new PaystackError(409, `Paystack says this payment is "${d.status}", so there is nothing to credit or refund.`);
      if (action === 'refund') {
        await this.call('POST', '/refund', { transaction: reference });
        this.db.prepare('UPDATE deposits SET status = ? WHERE reference = ?').run('refunded', reference);
        return toDeposit({ ...dep, status: 'refunded' });
      }
      if (d.currency !== 'NGN') throw new PaystackError(409, `This payment was in ${d.currency}, not naira. Refund it instead.`);
      // The buyer gets what was paid minus Paystack's charge and StockRun's fee (both as quoted when they started).
      const credit = d.amount - dep.charge_kobo - (dep.fee_kobo ?? 0);
      if (!Number.isSafeInteger(credit) || credit <= 0) throw new PaystackError(409, 'What was paid does not cover the charges. Refund it instead.');
      this.ledger.deposit(dep.user_id, reference, credit);
      if (dep.fee_kobo > 0) this.ledger.depositFee(dep.user_id, reference, dep.fee_kobo);
      this.db.prepare('UPDATE deposits SET status = ?, verified_at = ? WHERE reference = ?').run('credited', Date.now(), reference);
      return { ...toDeposit({ ...dep, status: 'credited', verified_at: Date.now() }), creditedKobo: credit };
    } catch (e) {
      this.db.prepare("UPDATE deposits SET status = 'mismatch' WHERE reference = ? AND status = 'resolving'").run(reference);
      throw e;
    }
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
