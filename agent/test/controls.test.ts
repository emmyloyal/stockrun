// Admin controls: pause switches, frozen/muted accounts, withdrawal limits and review, settling mismatched deposits,
// moderation. None of these may create or move money except as Paystack confirms or back to the person's own balance.
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/accounts/accounts.ts';
import { Ledger, kobo } from '../src/money/ledger.ts';
import { Paystack } from '../src/money/paystack.ts';
import { Withdrawals } from '../src/money/withdrawals.ts';
import { Payouts } from '../src/admin/payouts.ts';
import { Controls } from '../src/admin/controls.ts';
import { NairaOrders } from '../src/orders/nairaOrders.ts';
import { supplierKey } from '../src/tools/suppliers.ts';

const json = (data: unknown, status = 200, ok = true) => new Response(JSON.stringify({ status: ok, message: ok ? 'ok' : 'nope', data }), { status, headers: { 'Content-Type': 'application/json' } });

function setup() {
  const db = openDb(), ledger = new Ledger(db), controls = new Controls({ db });
  new NairaOrders({ db, ledger, evalCircuit: async () => { throw new Error('unused'); }, supplierStatus: () => 1, carriers: () => [] });
  const calls: { path: string; body: any }[] = [];
  const verify: Record<string, { status: string; amount: number; currency: string }> = {};
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url), body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path: u.pathname, body });
    if (u.pathname === '/bank') return json([{ name: 'GTBank', code: '058' }]);
    if (u.pathname === '/bank/resolve') return json({ account_name: 'ADA OBI' });
    if (u.pathname === '/transferrecipient') return json({ recipient_code: 'RCP_1' });
    if (u.pathname === '/transfer') return json({ status: 'success', transfer_code: 'TRF_1' });
    if (u.pathname === '/balance') return json([{ currency: 'NGN', balance: 1_234_500 }]);
    if (u.pathname === '/refund') return json({ status: 'pending' });
    if (u.pathname === '/transaction/initialize') return json({ authorization_url: 'https://checkout.example/x' });
    const m = u.pathname.match(/^\/transaction\/verify\/(.+)$/);
    if (m) { const v = verify[decodeURIComponent(m[1])]; return json({ ...v, reference: decodeURIComponent(m[1]), metadata: { userId: 'x' } }); }
    return json(null, 404, false);
  }) as unknown as typeof fetch;
  const paystack = new Paystack(db, ledger, { secretKey: 'sk_test_abc123', callbackUrl: 'https://x.example', fetch: f });
  const user = (naira = 0) => {
    const id = Number(db.prepare('INSERT INTO users (email, created_at) VALUES (?, 0)').run(`u${Math.random()}@x.com`).lastInsertRowid);
    if (naira) ledger.deposit(id, `seed-${id}`, kobo(naira));
    return id;
  };
  return { db, ledger, controls, paystack, calls, verify, user };
}

describe('pause switches', () => {
  it('pause needs a reason, refuses with a plain message, and resumes', () => {
    const { controls } = setup();
    expect(() => controls.setSwitch('boss@x.com', 'deposits', true, '')).toThrow(/why/);
    controls.setSwitch('boss@x.com', 'deposits', true, 'checking a Paystack alert');
    expect(controls.paused('deposits')).toBe(true);
    expect(controls.paused('withdrawals')).toBe(false);
    expect(() => controls.guard('deposits')).toThrow(/Deposits are paused/);
    expect(controls.switches().deposits).toMatchObject({ paused: true, note: 'checking a Paystack alert', by: 'boss@x.com' });
    controls.setSwitch('boss@x.com', 'deposits', false, '');
    expect(() => controls.guard('deposits')).not.toThrow();
    expect(() => controls.setSwitch('boss@x.com', 'everything', true, 'nope')).toThrow(/No such switch/);
  });

  it('paused payouts send nothing, automatically or by sweep', async () => {
    const { db, ledger, controls, paystack, calls, user } = setup();
    const payouts = new Payouts({ db, ledger, paystack, sellerOf: () => ({ name: 'Shop', phone: null }), paused: () => controls.paused('payouts') });
    const buyer = user(5_000);
    const id = Number(db.prepare(`INSERT INTO naira_orders (user_id, supplier_key, rider, ordered, cat, dist, unit_price, rider_fee, budget, status, created_at)
      VALUES (?, ?, '0x0000000000000000000000000000000000000001', 1, 0, 0, ?, 0, ?, 3, 0)`).run(buyer, supplierKey('found-00000000000000a1'), kobo(5_000), kobo(5_000)).lastInsertRowid);
    ledger.hold(buyer, `order:${id}`, kobo(5_000)); ledger.paySeller(buyer, `order:${id}`, kobo(5_000));
    await payouts.setBank('boss@x.com', id, { bankCode: '058', accountNumber: '0123456789', accountName: '' });
    controls.setSwitch('boss@x.com', 'payouts', true, 'bank details look odd');
    expect(await payouts.sweep()).toBe(0);
    expect(await payouts.autoPay(id)).toBe('skipped');
    expect(calls.some((c) => c.path === '/transfer')).toBe(false);
    controls.setSwitch('boss@x.com', 'payouts', false, '');
    expect(await payouts.sweep()).toBe(1);
  });
});

describe('frozen and muted accounts', () => {
  it('frozen stops money and speech; muted stops speech only; both need a reason and are logged', () => {
    const { controls, user, db } = setup();
    const id = user();
    expect(() => controls.setFlags('boss@x.com', id, { frozen: true }, '')).toThrow(/why/);
    controls.setFlags('boss@x.com', id, { frozen: true }, 'card reported stolen');
    expect(() => controls.guardMoney(id)).toThrow(/on hold/);
    expect(() => controls.guardSpeech(id)).toThrow();
    controls.setFlags('boss@x.com', id, { frozen: false, muted: true }, 'spam posts');
    expect(() => controls.guardMoney(id)).not.toThrow();
    expect(() => controls.guardSpeech(id)).toThrow(/cannot post/);
    expect(controls.findUsers(String(id))[0]).toMatchObject({ id, flags: { muted: true, frozen: false } });
    const log = db.prepare("SELECT detail FROM admin_log WHERE action = 'user' ORDER BY id").all() as { detail: string }[];
    expect(log.map((l) => l.detail)).toEqual([`froze user ${id}: card reported stolen`, `unfroze and muted user ${id}: spam posts`]);
  });
});

describe('withdrawal limits and review', () => {
  it('small withdrawals go at once; big ones wait; approve sends, reject returns the money', async () => {
    const { db, ledger, paystack, calls, user } = setup();
    const w = new Withdrawals(db, ledger, paystack, Date.now, { dailyLimitKobo: kobo(300_000), reviewOverKobo: kobo(100_000) });
    const id = user(400_000);
    const small = await w.start(id, kobo(50_000), '058', '0123456789');
    expect(small.status).toBe('sent');
    const big = await w.start(id, kobo(150_000), '058', '0123456789');
    expect(big.status).toBe('review');
    expect(calls.filter((c) => c.path === '/transfer')).toHaveLength(1);       // the big one was not sent
    expect(ledger.balance(id).availableKobo).toBe(kobo(200_000));              // both left the balance at once
    expect(w.pendingKobo()).toBe(kobo(150_000));
    await expect(w.start(id, kobo(150_000), '058', '0123456789')).rejects.toThrow(/up to ₦100,000 more today/);
    const sent = await w.approve(big.reference);
    expect(sent.status).toBe('sent');
    await expect(w.approve(big.reference)).rejects.toThrow(/not waiting/);      // cannot be sent twice
    expect(calls.filter((c) => c.path === '/transfer')).toHaveLength(2);

    const other = user(300_000);
    const held = await w.start(other, kobo(120_000), '058', '0123456789');
    expect(() => w.reject(held.reference, '')).toThrow(/why/);
    const r = w.reject(held.reference, 'name on the account does not match');
    expect(r.status).toBe('failed');
    expect(ledger.balance(other).availableKobo).toBe(kobo(300_000));          // all back
    expect(ledger.check().ok).toBe(true);
  });
});

describe('deposits that do not match', () => {
  async function mismatched(s: ReturnType<typeof setup>, paid: number) {
    const id = s.user();
    const { reference } = await s.paystack.start(id, kobo(10_000), 'a@b.co');
    s.verify[reference] = { status: 'success', amount: paid, currency: 'NGN' };
    await expect(s.paystack.confirm(reference)).rejects.toThrow(/check it by hand/);   // metadata/amount differ
    return { id, reference };
  }

  it('credit gives what Paystack received, once; webhooks then leave it alone', async () => {
    const s = setup();
    const { id, reference } = await mismatched(s, kobo(9_000));
    const r = await s.paystack.resolveMismatch(reference, 'credit');
    expect(r.creditedKobo).toBe(kobo(9_000));
    expect(s.ledger.balance(id).availableKobo).toBe(kobo(9_000));
    await expect(s.paystack.resolveMismatch(reference, 'credit')).rejects.toThrow(/does not match/);
    expect(await s.paystack.confirm(reference)).toMatchObject({ status: 'already' });
    expect(s.ledger.balance(id).availableKobo).toBe(kobo(9_000));
  });

  it('refund asks Paystack to return the payment and credits nothing', async () => {
    const s = setup();
    const { id, reference } = await mismatched(s, kobo(9_000));
    await s.paystack.resolveMismatch(reference, 'refund');
    expect(s.calls.find((c) => c.path === '/refund')?.body).toEqual({ transaction: reference });
    expect(s.ledger.balance(id).availableKobo).toBe(0);
    expect(s.paystack.deposits('refunded')).toHaveLength(1);
  });

  it('nothing happens unless Paystack confirms a successful payment', async () => {
    const s = setup();
    const { reference } = await mismatched(s, kobo(9_000));
    s.verify[reference] = { status: 'reversed', amount: kobo(9_000), currency: 'NGN' };
    await expect(s.paystack.resolveMismatch(reference, 'credit')).rejects.toThrow(/reversed/);
    expect(s.paystack.deposits('mismatch')).toHaveLength(1);                 // released for another try
  });

  it('reads the Paystack balance for the books', async () => {
    expect(await setup().paystack.balanceKobo()).toBe(1_234_500);
  });
});
