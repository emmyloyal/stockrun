import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { openDb } from '../src/accounts/accounts.ts';
import { Ledger, kobo } from '../src/money/ledger.ts';
import { Paystack } from '../src/money/paystack.ts';

describe('naira ledger', () => {
  it('deposits once per reference; holds, pays and releases keep every transaction balanced', () => {
    const l = new Ledger(openDb());
    expect(l.deposit(1, 'ref1', kobo(50_000))).toBe(true);
    expect(l.deposit(1, 'ref1', kobo(50_000))).toBe(false);                 // a retried webhook changes nothing
    expect(l.balance(1)).toEqual({ availableKobo: 5_000_000, heldKobo: 0 });

    l.hold(1, 'o1', kobo(35_250));                                           // 5 cartons at ₦6,650 + ₦2,000 delivery
    expect(l.hold(1, 'o1', kobo(35_250))).toBe(false);
    expect(l.balance(1)).toEqual({ availableKobo: 1_475_000, heldKobo: 3_525_000 });
    l.paySeller(1, 'o1', kobo(26_600));                                      // 4 of 5 picked up
    l.release(1, 'o1-unpicked', kobo(6_650));                                // the 5th carton's money comes back
    l.payLogistics(1, 'o1', kobo(2_000));
    expect(l.balance(1)).toEqual({ availableKobo: 2_140_000, heldKobo: 0 });
    expect(l.system('sellers')).toBe(2_660_000);
    expect(l.system('logistics')).toBe(200_000);
    expect(l.system('paystack')).toBe(-5_000_000);
    expect(l.check()).toEqual({ ok: true, problems: [] });
  });

  it('never lets a person spend money they have not got, and refuses fractions of a kobo', () => {
    const l = new Ledger(openDb());
    l.deposit(2, 'r', 10_000);
    expect(() => l.hold(2, 'big', 10_001)).toThrow(/Not enough money/);
    expect(() => l.hold(2, 'frac', 0.5)).toThrow(/whole kobo/);
    expect(() => l.hold(2, 'neg', -5)).toThrow(/whole kobo/);
    expect(() => l.paySeller(2, 'nothing-held', 1)).toThrow(/Not enough money/);
    expect(l.balance(2)).toEqual({ availableKobo: 10_000, heldKobo: 0 });     // failed attempts left nothing behind
    expect(l.check().ok).toBe(true);
  });

  it('shows a person their own history only', () => {
    const l = new Ledger(openDb());
    l.deposit(3, 'a', 500_00); l.deposit(4, 'b', 700_00); l.hold(3, 'o', 200_00);
    expect(l.history(3).map((m) => [m.type, m.amountKobo])).toEqual([['hold', -20_000], ['deposit', 50_000]]);
  });
});

describe('Paystack deposits', () => {
  const KEY = 'sk_test_abc123';
  function setup(answers: Record<string, unknown>) {
    const db = openDb(), ledger = new Ledger(db), calls: { method: string; path: string; body: any }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({ method: init.method!, path, body: init.body ? JSON.parse(init.body as string) : undefined });
      const key = Object.keys(answers).find((k) => path.startsWith(k));
      return new Response(JSON.stringify(key ? answers[key] : { status: false, message: 'no route' }), { status: key ? 200 : 404 });
    }) as unknown as typeof fetch;
    return { ledger, calls, ps: new Paystack(db, ledger, { secretKey: KEY, callbackUrl: 'https://stockrun.example/?paid=1', fetch: f }) };
  }
  const verified = (over: Record<string, unknown>) => ({ status: true, data: { status: 'success', currency: 'NGN', ...over } });

  it('credits a verified deposit once, to the person who started it, for the amount asked', async () => {
    const t = setup({ '/transaction/initialize': { status: true, data: { authorization_url: 'https://checkout.paystack.com/x' } } });
    const { reference, checkoutUrl } = await t.ps.start(7, 25_000_00, 'ada@example.com');
    expect(checkoutUrl).toBe('https://checkout.paystack.com/x');
    expect(t.calls[0].body).toMatchObject({ email: 'ada@example.com', amount: 2_500_000, currency: 'NGN', reference, metadata: { userId: 7 } });

    const ok = setup({});
    (t as any).ps['fetch'] = (async () => new Response(JSON.stringify(verified({ reference, amount: 2_500_000, metadata: { userId: 7 } })))) as unknown as typeof fetch;
    expect(await t.ps.confirm(reference, 7)).toEqual({ status: 'credited', amountKobo: 2_500_000 });
    expect(await t.ps.confirm(reference, 7)).toEqual({ status: 'already', amountKobo: 2_500_000 });
    expect(t.ledger.balance(7).availableKobo).toBe(2_500_000);
    await expect(t.ps.confirm(reference, 8)).rejects.toThrow(/No such deposit/);       // someone else's reference
    void ok;
  });

  it('never credits a failed payment, a different amount, another currency or a reference we did not issue', async () => {
    const t = setup({ '/transaction/initialize': { status: true, data: { authorization_url: 'u' } } });
    const a = (await t.ps.start(9, 10_000_00, 'b@example.com')).reference;
    const b = (await t.ps.start(9, 10_000_00, 'b@example.com')).reference;
    const c = (await t.ps.start(9, 10_000_00, 'b@example.com')).reference;
    const reply = (r: unknown) => { (t as any).ps['fetch'] = (async () => new Response(JSON.stringify(r))) as unknown as typeof fetch; };
    reply({ status: true, data: { status: 'failed', reference: a, amount: 1_000_000, currency: 'NGN' } });
    expect((await t.ps.confirm(a)).status).toBe('failed');
    reply(verified({ reference: b, amount: 100, metadata: { userId: 9 } }));
    await expect(t.ps.confirm(b)).rejects.toThrow(/does not match/);
    reply(verified({ reference: c, amount: 1_000_000, currency: 'USD', metadata: { userId: 9 } }));
    await expect(t.ps.confirm(c)).rejects.toThrow(/does not match/);
    await expect(t.ps.confirm('sr_9_madeup')).rejects.toThrow(/No such deposit/);
    expect(t.ledger.balance(9).availableKobo).toBe(0);
  });

  it('checks amounts and email before contacting Paystack, and verifies webhook signatures', async () => {
    const t = setup({});
    await expect(t.ps.start(1, 50_00, 'a@b.co')).rejects.toThrow(/between ₦100/);
    await expect(t.ps.start(1, 1_000_00, 'not-an-email')).rejects.toThrow(/email/);
    expect(t.calls).toHaveLength(0);
    const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'sr_1_x' } }));
    const sig = createHmac('sha512', KEY).update(body).digest('hex');
    expect(t.ps.verifyWebhook(body, sig)).toEqual({ event: 'charge.success', reference: 'sr_1_x' });
    expect(() => t.ps.verifyWebhook(body, sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a'))).toThrow(/bad signature/);
    expect(() => t.ps.verifyWebhook(Buffer.from(body.toString().replace('sr_1_x', 'sr_2_x')), sig)).toThrow(/bad signature/);
  });
});
