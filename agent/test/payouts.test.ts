import { describe, expect, it } from 'vitest';
import { openDb } from '../src/accounts/accounts.ts';
import { Ledger, kobo } from '../src/money/ledger.ts';
import { Paystack } from '../src/money/paystack.ts';
import { Withdrawals } from '../src/money/withdrawals.ts';
import { Payouts } from '../src/admin/payouts.ts';
import { NairaOrders } from '../src/orders/nairaOrders.ts';
import { supplierKey } from '../src/tools/suppliers.ts';

const json = (data: unknown, status = 200, ok = true) => new Response(JSON.stringify({ status: ok, message: ok ? 'ok' : 'nope', data }), { status, headers: { 'Content-Type': 'application/json' } });

/** A stand-in for Paystack's transfer API. `transferStatus` decides what each transfer returns. */
function fakePaystack() {
  const transfers: { reference: string; amount: number; recipient: string }[] = [];
  const state = { transferStatus: 'success' as string, throwOnTransfer: false };
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url), body = init.body ? JSON.parse(String(init.body)) : null;
    if (u.pathname === '/bank') return json([{ name: 'GTBank', code: '058' }, { name: 'Access Bank', code: '044' }]);
    if (u.pathname === '/bank/resolve') return u.searchParams.get('account_number') === '0000000000' ? json(null, 422, false) : json({ account_name: 'AGORA MARKETPLACE LTD' });
    if (u.pathname === '/transferrecipient') return json({ recipient_code: `RCP_${body.account_number}` });
    if (u.pathname === '/transfer') {
      if (state.throwOnTransfer) return json(null, 400, false);
      transfers.push({ reference: body.reference, amount: body.amount, recipient: body.recipient });
      return json({ status: state.transferStatus, transfer_code: 'TRF_x' });
    }
    return json(null, 404, false);
  }) as unknown as typeof fetch;
  return { f, transfers, state };
}

const SELLER = 'found-00000000000000a1';
function setup() {
  const db = openDb(), ledger = new Ledger(db);
  new NairaOrders({ db, ledger, evalCircuit: async () => { throw new Error('unused'); }, supplierStatus: () => 1, carriers: () => [] });
  const ps = fakePaystack();
  const paystack = new Paystack(db, ledger, { secretKey: 'sk_test_abc123', callbackUrl: 'https://x.example', fetch: ps.f });
  const payouts = new Payouts({ db, ledger, paystack, sellerOf: () => ({ name: 'Agora Marketplace', phone: '+2349079579400' }) });
  /** An order whose pickup PickupCheck approved for `naira`: the ledger moved it to "owed to sellers". */
  const approved = (naira: number) => {
    const user = Number(db.prepare("INSERT INTO users (email, created_at) VALUES (?, 0)").run(`b${Math.random()}@x.com`).lastInsertRowid);
    ledger.deposit(user, `dep-${user}`, kobo(naira));
    const id = Number(db.prepare(`INSERT INTO naira_orders (user_id, supplier_key, rider, ordered, cat, dist, unit_price, rider_fee, budget, status, created_at)
      VALUES (?, ?, '0x0000000000000000000000000000000000000001', 1, 0, 0, ?, 0, ?, 3, 0)`).run(user, supplierKey(SELLER), kobo(naira), kobo(naira)).lastInsertRowid);
    ledger.hold(user, `order:${id}`, kobo(naira));
    ledger.paySeller(user, `order:${id}`, kobo(naira));
    return { id, user };
  };
  return { db, ledger, payouts, paystack, ps, approved };
}

describe('automatic seller payouts through Paystack', () => {
  it('pays an approved payout once, to an account an admin entered (name from the bank)', async () => {
    const { ledger, payouts, ps, approved } = setup();
    const { id } = approved(42_000);
    expect(await payouts.sweep()).toBe(0);                                        // no bank account yet: waits
    const p = await payouts.setBank('boss@x.com', id, { bankCode: '058', accountNumber: '0123456789', accountName: 'typed name is ignored' });
    expect(p.bank).toMatchObject({ bankName: 'GTBank', accountName: 'AGORA MARKETPLACE LTD', approved: true, source: 'admin' });
    expect(await payouts.sweep()).toBe(1);
    expect(ps.transfers).toEqual([{ reference: `stockrun-payout-${id}-1`, amount: 4_200_000, recipient: 'RCP_0123456789' }]);
    expect(payouts.list()[0]).toMatchObject({ status: 'paid', paidBy: 'paystack', reference: `stockrun-payout-${id}-1` });
    expect(ledger.system('sellers')).toBe(0);
    expect(ledger.system('paid_out')).toBe(4_200_000);
    expect(await payouts.sweep()).toBe(0);                                        // never twice
    expect(ps.transfers).toHaveLength(1);
    expect(ledger.check().ok).toBe(true);
  });

  it('an account the seller added by link waits for an admin, and the link cannot replace it afterwards', async () => {
    const { payouts, ps, approved } = setup();
    const { id } = approved(10_000);
    expect(await payouts.sellerSubmitBank(SELLER, { bankCode: '044', accountNumber: '1234567890' })).toEqual({ accountName: 'AGORA MARKETPLACE LTD', bankName: 'Access Bank' });
    expect(payouts.list()[0].bank).toMatchObject({ approved: false, source: 'seller' });
    expect(await payouts.sweep()).toBe(0);                                        // not until approved
    payouts.approveBank('boss@x.com', id);
    expect(await payouts.sweep()).toBe(1);
    expect(ps.transfers[0].recipient).toBe('RCP_1234567890');
    await expect(payouts.sellerSubmitBank(SELLER, { bankCode: '058', accountNumber: '9999999999' })).rejects.toThrow(/already set up/);
    await expect(setup().payouts.sellerSubmitBank(SELLER, { bankCode: '058', accountNumber: '0000000000' })).rejects.toThrow(/could not be found/);
  });

  it('a refused transfer stays owed with a note; the sweep leaves it; an admin retry uses a new reference', async () => {
    const { ledger, payouts, ps, approved } = setup();
    const { id } = approved(5_000);
    await payouts.setBank('boss@x.com', id, { bankCode: '058', accountNumber: '0123456789' });
    ps.state.transferStatus = 'otp';
    expect(await payouts.sweep()).toBe(0);
    expect(payouts.list()[0]).toMatchObject({ status: 'owed' });
    expect(payouts.list()[0].note).toMatch(/OTP/);
    expect(await payouts.sweep()).toBe(0);                                        // left for the admin
    expect(ps.transfers).toHaveLength(1);
    ps.state.transferStatus = 'success';
    expect(await payouts.autoPay(id)).toBe('paid');
    expect(ps.transfers.map((t) => t.reference)).toEqual([`stockrun-payout-${id}-1`, `stockrun-payout-${id}-2`]);
    expect(ledger.system('paid_out')).toBe(500_000);
  });

  it('a transfer Paystack later reverses makes the payout owed again, with the books still balanced', async () => {
    const { ledger, payouts, approved } = setup();
    const { id } = approved(8_000);
    await payouts.setBank('boss@x.com', id, { bankCode: '058', accountNumber: '0123456789' });
    await payouts.sweep();
    expect(payouts.transferFailed(`stockrun-payout-${id}-1`, 'transfer.reversed')).toBe(true);
    expect(payouts.transferFailed(`stockrun-payout-${id}-1`, 'transfer.reversed')).toBe(false);   // once
    expect(payouts.list()[0]).toMatchObject({ status: 'owed' });
    expect(ledger.system('sellers')).toBe(800_000);
    expect(ledger.system('paid_out')).toBe(0);
    expect(ledger.check().ok).toBe(true);
  });

  it('never pays a held payout or one PickupCheck did not approve', async () => {
    const { payouts, ps, approved } = setup();
    const { id } = approved(3_000);
    await payouts.setBank('boss@x.com', id, { bankCode: '058', accountNumber: '0123456789' });
    payouts.hold('boss@x.com', id, true, 'checking');
    expect(await payouts.sweep()).toBe(0);
    expect(await payouts.autoPay(id)).toBe('skipped');
    expect(await payouts.autoPay(999)).toBe('skipped');
    expect(ps.transfers).toHaveLength(0);
  });
});

describe('buyer withdrawals', () => {
  it('takes the money out first, sends it, and gives it back once if Paystack refuses or reverses it', async () => {
    const { db, ledger, paystack, ps } = setup();
    const w = new Withdrawals(db, ledger, paystack);
    const user = Number(db.prepare("INSERT INTO users (email, created_at) VALUES ('ada@x.com', 0)").run().lastInsertRowid);
    ledger.deposit(user, 'dep-ada', kobo(50_000));
    await expect(w.start(user, kobo(60_000), '058', '0123456789')).rejects.toThrow(/more than your spendable balance/);

    const ok = await w.start(user, kobo(20_000), '058', '0123456789');
    expect(ok).toMatchObject({ status: 'sent', accountName: 'AGORA MARKETPLACE LTD', bankName: 'GTBank', amountKobo: 2_000_000 });
    expect(ledger.balance(user).availableKobo).toBe(kobo(30_000));
    expect(ps.transfers.at(-1)).toMatchObject({ amount: 2_000_000, reference: ok.reference });

    ps.state.throwOnTransfer = true;
    const bad = await w.start(user, kobo(10_000), '058', '0123456789');
    expect(bad.status).toBe('failed');
    expect(bad.note).toMatch(/back in your balance/);
    expect(ledger.balance(user).availableKobo).toBe(kobo(30_000));                // came back

    expect(w.failed(ok.reference, 'transfer.reversed')).toBe(true);
    expect(w.failed(ok.reference, 'transfer.reversed')).toBe(false);              // once
    expect(ledger.balance(user).availableKobo).toBe(kobo(50_000));
    expect(ledger.check().ok).toBe(true);
    expect(w.forUser(user).map((x) => x.status)).toEqual(expect.arrayContaining(['failed', 'failed']));
  });
});

describe('Paystack deposit charge paid by the buyer', () => {
  it('adds just enough that StockRun receives the full deposit, with the cap and the small-payment waiver', async () => {
    const { depositCharge, paystackFee, PAYSTACK_LOCAL: c } = await import('../src/money/paystack.ts');
    for (const naira of [100, 1_000, 2_400, 2_500, 10_000, 50_000, 125_000, 500_000, 5_000_000]) {
      const charge = depositCharge(kobo(naira), c), gross = kobo(naira) + charge;
      expect(gross - paystackFee(gross, c), `₦${naira}`).toBeGreaterThanOrEqual(kobo(naira));     // never short
      expect(gross - paystackFee(gross, c) - kobo(naira), `₦${naira}`).toBeLessThanOrEqual(2);     // and not overcharged
    }
    expect(depositCharge(kobo(50_000), c)).toBe(86_295);                  // ₦862.95 on ₦50,000
    expect(depositCharge(kobo(500_000), c)).toBe(kobo(2_000));            // capped
    expect(depositCharge(kobo(50_000), null)).toBe(0);                    // StockRun absorbs it
  });

  it('asks Paystack for deposit + charge, credits the full deposit, and refuses a payment of any other total', async () => {
    const { PAYSTACK_LOCAL } = await import('../src/money/paystack.ts');
    const db = openDb(), ledger = new Ledger(db);
    let paid = 0; let asked = 0;
    const f = (async (url: string, init: RequestInit) => {
      if (url.includes('/transaction/initialize')) { asked = JSON.parse(String(init.body)).amount; return json({ authorization_url: 'https://checkout.example/x' }); }
      const ref = url.split('/').pop();
      return json({ status: 'success', amount: paid, currency: 'NGN', reference: ref, metadata: { userId: 7 } });
    }) as unknown as typeof fetch;
    const ps = new Paystack(db, ledger, { secretKey: 'sk_test_abc123', callbackUrl: 'https://x.example', fetch: f, depositCharge: PAYSTACK_LOCAL });
    const { reference, chargeKobo } = await ps.start(7, kobo(50_000), 'ada@x.com');
    expect(chargeKobo).toBe(86_295);
    expect(asked).toBe(kobo(50_000) + 86_295);
    paid = kobo(50_000);                                                   // only the deposit, without the charge
    await expect(ps.confirm(reference, 7)).rejects.toThrow(/does not match/);
    const { reference: r2 } = await ps.start(7, kobo(50_000), 'ada@x.com');
    paid = kobo(50_000) + 86_295;
    expect(await ps.confirm(r2, 7)).toEqual({ status: 'credited', amountKobo: kobo(50_000) });
    expect(ledger.balance(7).availableKobo).toBe(kobo(50_000));           // the full deposit
  });
});
