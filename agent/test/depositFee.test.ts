// StockRun's 1.5% on every naira deposit: the buyer pays it on top (with Paystack's charge), their balance gets the
// full deposit, StockRun's income gets the fee, once, and only after Paystack confirms the whole payment.
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/accounts/accounts.ts';
import { Ledger, kobo } from '../src/money/ledger.ts';
import { Paystack, PAYSTACK_LOCAL, depositCharge, depositQuote, stockrunDepositFee } from '../src/money/paystack.ts';

const json = (data: unknown) => new Response(JSON.stringify({ status: true, message: 'ok', data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

function setup() {
  const db = openDb(), ledger = new Ledger(db);
  const init: any[] = [], paid: Record<string, number> = {};
  const f = (async (url: string, req: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === '/transaction/initialize') { const b = JSON.parse(String(req.body)); init.push(b); return json({ authorization_url: 'https://checkout.example/x' }); }
    const m = u.pathname.match(/^\/transaction\/verify\/(.+)$/);
    if (m) { const ref = decodeURIComponent(m[1]), b = init.find((x) => x.reference === ref); return json({ status: 'success', amount: paid[ref] ?? b.amount, currency: 'NGN', reference: ref, metadata: { userId: b.metadata.userId } }); }
    throw new Error(`unexpected ${u.pathname}`);
  }) as unknown as typeof fetch;
  const paystack = new Paystack(db, ledger, { secretKey: 'sk_test_abc123', callbackUrl: 'https://x.example', fetch: f, depositCharge: PAYSTACK_LOCAL, depositFeeBps: 150 });
  const user = Number(db.prepare('INSERT INTO users (email, created_at) VALUES (?, 0)').run('ada@x.com').lastInsertRowid);
  return { db, ledger, paystack, init, paid, user };
}

describe('StockRun deposit fee (1.5%)', () => {
  it('is 1.5% rounded down to the kobo, and Paystack\'s charge is worked out on deposit + fee', () => {
    expect(stockrunDepositFee(kobo(10_000), 150)).toBe(kobo(150));
    expect(stockrunDepositFee(kobo(101), 150)).toBe(151);                  // ₦1.515 -> ₦1.51
    expect(stockrunDepositFee(kobo(10_000), 0)).toBe(0);
    const q = depositQuote(kobo(10_000), 150, PAYSTACK_LOCAL);
    expect(q).toEqual({ amountKobo: kobo(10_000), feeKobo: kobo(150), chargeKobo: depositCharge(kobo(10_150), PAYSTACK_LOCAL), totalKobo: kobo(10_150) + depositCharge(kobo(10_150), PAYSTACK_LOCAL) });
  });

  it('the buyer pays deposit + fee + charge; the balance gets the deposit; the fee is StockRun\'s income, once', async () => {
    const { ledger, paystack, init, user } = setup();
    const r = await paystack.start(user, kobo(10_000), 'ada@x.com');
    expect(r.feeKobo).toBe(kobo(150));
    expect(init[0]).toMatchObject({ amount: r.totalKobo, metadata: { depositKobo: kobo(10_000), stockrunFeeKobo: kobo(150) } });
    expect(await paystack.confirm(r.reference, user)).toMatchObject({ status: 'credited', amountKobo: kobo(10_000) });
    expect(ledger.balance(user).availableKobo).toBe(kobo(10_000));
    expect(ledger.system('fees')).toBe(kobo(150));
    expect(await paystack.confirm(r.reference)).toMatchObject({ status: 'already' });   // webhook after the redirect
    expect(ledger.system('fees')).toBe(kobo(150));
    expect(ledger.history(user).map((m) => m.type)).toEqual(['deposit']);           // the fee never touches the balance
    expect(ledger.check().ok).toBe(true);
  });

  it('a payment that left out the fee is not credited; an admin credit takes the fee and the charge out', async () => {
    const { ledger, paystack, paid, user } = setup();
    const r = await paystack.start(user, kobo(10_000), 'ada@x.com');
    paid[r.reference] = r.totalKobo - r.feeKobo;                                     // someone paid without StockRun's fee
    await expect(paystack.confirm(r.reference, user)).rejects.toThrow(/check it by hand/);
    expect(ledger.balance(user).availableKobo).toBe(0);
    const s = await paystack.resolveMismatch(r.reference, 'credit');
    expect(s.creditedKobo).toBe(kobo(10_000) - r.feeKobo);
    expect(ledger.system('fees')).toBe(r.feeKobo);
    expect(ledger.check().ok).toBe(true);
  });
});
