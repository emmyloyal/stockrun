// The StockRun server over HTTP on a local chain: phone and wallet sign-in, profiles, naira (test credit here; Paystack
// is tested in ledger.test.ts), requests with a budget and a delivery pin, self-pickup paying the seller, and the
// privacy walls between people. Naira orders are decided by the circuits through eval (MockCircuits on this chain).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApp } from '../src/server/app.ts';
import { Accounts, ConsoleSms, openDb } from '../src/accounts/accounts.ts';
import { Buyers } from '../src/buyers/buyers.ts';
import { circuitEvaluator, localPlatform, type Platform } from '../src/chain/platform.ts';
import { startLocalChain, localChainAvailable, type LocalChain } from '../src/sim/localChain.ts';
import { RuleExtractor } from '../src/rules.ts';
import { BotChannel } from '../src/sim/bots.ts';
import { PriceBook } from '../src/prices/priceBook.ts';
import { Ledger } from '../src/money/ledger.ts';
import { NairaOrders } from '../src/orders/nairaOrders.ts';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 9)]).toString('base64');
const MILE12 = { lat: 6.6045, lng: 3.3891, address: '12 Ikorodu Road, Ketu, Lagos' };
const SITE = 'https://1-2-433.tapekit.org';

describe.skipIf(!localChainAvailable())('StockRun server', () => {
  let chain: LocalChain; let p: Platform; let server: Server; let base: string; let ledger: Ledger;
  const sms = new ConsoleSms();

  function person() {
    let cookie = '';
    const call = async (path: string, body?: unknown, extra: Record<string, string> = {}) => {
      const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', cookie, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      const text = await r.text();
      return { status: r.status, json: (() => { try { return JSON.parse(text); } catch { return text; } })() as any };
    };
    const phone = async (number: string) => {
      const l = console.log; console.log = () => {};
      try { expect((await call('/api/auth/code', { phone: number })).status).toBe(200); } finally { console.log = l; }
      const code = sms.sent.filter((m) => m.phone.endsWith(number.replace(/\D/g, '').slice(-10))).at(-1)!.text.match(/(\d{6})/)![1];
      return call('/api/auth/verify', { phone: number, code });
    };
    return { call, phone };
  }

  beforeAll(async () => {
    chain = await startLocalChain();
    p = localPlatform(chain);
    const db = openDb();
    ledger = new Ledger(db);
    let buyers: Buyers;
    const orders = new NairaOrders({ db, ledger, evalCircuit: circuitEvaluator(p), supplierStatus: (k) => buyers.sellerStatus(k), carriers: () => buyers.carrierKeys() });
    buyers = new Buyers(db, p, ledger, orders, { extractor: new RuleExtractor(), channel: new BotChannel(), prices: new PriceBook() });
    server = createApp({ platform: p, accounts: new Accounts(db, sms, 'x'.repeat(40)), buyers, ledger, prices: new PriceBook(), paystack: null, allowedOrigins: [SITE], log: (l) => process.env.DEBUG_SERVER && console.error(l) });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(() => { server?.close(); chain?.stop(); });

  it('phone sign-in, a profile with a username and picture, and a public profile without the phone number', async () => {
    const ada = person();
    const v = await ada.phone('0803 111 1111');
    expect(v.json.user).toMatchObject({ phone: '+2348031111111', wallet: null });
    expect((await ada.call('/api/me/profile', { username: 'ada', displayName: 'Ada Obi' })).json.user).toMatchObject({ username: 'ada', displayName: 'Ada Obi' });
    expect((await ada.call('/api/me/avatar', { mediaType: 'image/jpeg', data: JPEG })).json.user.hasAvatar).toBe(true);
    const pic = await fetch(`${base}/api/users/${v.json.user.id}/avatar`);
    expect(pic.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await pic.arrayBuffer()).toString('base64')).toBe(JPEG);
    const pub = (await person().call(`/api/users/${v.json.user.id}`)).json;
    expect(pub).toEqual({ id: v.json.user.id, username: 'ada', displayName: 'Ada Obi', hasAvatar: true });
    expect(JSON.stringify(pub)).not.toContain('2348031111111');
    const bisi = person(); await bisi.phone('0803 222 2222');
    expect((await bisi.call('/api/me/profile', { username: 'ADA' })).status).toBe(409);
  }, 60_000);

  it('wallet sign-in creates an account; a phone account connects a wallet and then signs in with either', async () => {
    const w = privateKeyToAccount(generatePrivateKey());
    const tobi = person();
    const { message } = (await tobi.call(`/api/auth/wallet-message?address=${w.address}`)).json;
    const s = await tobi.call('/api/auth/wallet', { message, signature: await w.signMessage({ message }) });
    expect(s.json.user).toMatchObject({ wallet: w.address, phone: null });
    expect((await tobi.call('/api/me/coins')).json).toMatchObject({ wallet: w.address, okb: '0' });

    const kemi = person(); const k = await kemi.phone('0803 333 3333');
    const kw = privateKeyToAccount(generatePrivateKey());
    const m2 = (await kemi.call(`/api/auth/wallet-message?address=${kw.address}`)).json.message;
    expect((await kemi.call('/api/me/wallet', { message: m2, signature: await kw.signMessage({ message: m2 }) })).json.user).toMatchObject({ phone: '+2348033333333', wallet: kw.address });
    const again = person();
    const m3 = (await again.call(`/api/auth/wallet-message?address=${kw.address}`)).json.message;
    expect((await again.call('/api/auth/wallet', { message: m3, signature: await kw.signMessage({ message: m3 }) })).json.user.id).toBe(k.json.user.id);
  }, 60_000);

  it('ask with a budget and a pin; collect it yourself; your count pays the seller; the rest comes back', async () => {
    const chi = person(); await chi.phone('0805 444 4444');
    const ask = { text: '5 cartons of Indomie', budgetNaira: 80_000, place: MILE12, delivery: 'self' };
    expect((await chi.call('/api/requests', ask)).status).toBe(409);                                        // deposit first
    expect((await chi.call('/api/dev/naira', { amountNaira: 100_000 })).json.naira).toEqual({ availableNaira: 100_000, heldNaira: 0 });
    expect((await chi.call('/api/dev/naira', { amountNaira: 600_000 })).status).toBe(400);                   // over ₦500,000 at a time

    expect((await chi.call('/api/map?lat=6.6045&lng=3.3891&radius=10')).json.sellers[0]).toMatchObject({ verified: true, simulated: true });
    const r = (await chi.call('/api/requests', ask)).json;
    expect(r.message).toMatch(/you collect it yourself, no delivery fee.*funds locked in escrow/);
    let [o] = (await chi.call('/api/orders')).json;
    expect(o).toMatchObject({ money: 'naira', self: true, status: 'Locked', ordered: 5, riderFeeNaira: 0 });
    expect(o.evidence[0]).toMatchObject({ circuit: 'restock', circuitId: '1' });
    expect((await chi.call('/api/me')).json.naira.heldNaira).toBe(5 * o.unitPriceNaira);

    const done = (await chi.call(`/api/orders/${o.orderId}/collect`, { count: 4 })).json;
    expect(done).toMatchObject({ status: 'settled', outcome: 'paid_part', qty: 4 });
    [o] = (await chi.call('/api/orders')).json;
    expect(o).toMatchObject({ status: 'Delivered', pickup: { picked: 4 } });
    expect((await chi.call('/api/me')).json.naira).toEqual({ availableNaira: 100_000 - 4 * o.unitPriceNaira, heldNaira: 0 });
    expect(ledger.system('sellers')).toBe(4 * o.unitPriceNaira * 100);
    expect(ledger.check().ok).toBe(true);
    expect((await chi.call('/api/requests')).json[0]).toMatchObject({ text: '5 cartons of Indomie', budgetNaira: 80_000, delivery: 'self' });
  }, 120_000);

  it('a budget too small is refused by RestockGuard; nobody sees anyone else\'s orders or money', async () => {
    const dayo = person(); await dayo.phone('0805 555 5555');
    await dayo.call('/api/dev/naira', { amountNaira: 100_000 });
    const r = (await dayo.call('/api/requests', { text: '5 cartons of Indomie', budgetNaira: 20_000, place: MILE12, delivery: 'self' })).json;
    expect(r.message).toMatch(/budget/i);
    expect((await dayo.call('/api/me')).json.naira).toEqual({ availableNaira: 100_000, heldNaira: 0 });
    expect((await dayo.call('/api/requests', { text: 'rice', budgetNaira: 50_000, place: { lat: 51.5, lng: -0.1, address: 'London' }, delivery: 'self' })).status).toBe(400);

    const eve = person(); await eve.phone('0805 666 6666');
    expect((await eve.call('/api/orders')).json).toEqual([]);
    expect((await eve.call('/api/orders/1/collect', { count: 1 })).status).toBe(404);
    expect((await eve.call('/api/naira/history')).json).toEqual([]);
  }, 120_000);

  it('refuses the signed-out and non-JSON writes; CORS only for the listed site, with bearer sign-in', async () => {
    const anon = person();
    expect((await anon.call('/api/orders')).status).toBe(401);
    expect((await anon.call('/api/me')).json).toEqual({ user: null });
    expect((await fetch(`${base}/api/auth/code`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"phone":"08030000000"}' })).status).toBe(415);
    expect((await fetch(`${base}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' })).status).toBe(401);

    const pre = await fetch(`${base}/api/me`, { method: 'OPTIONS', headers: { Origin: SITE, 'Access-Control-Request-Method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(SITE);
    expect((await fetch(`${base}/api/me`, { headers: { Origin: 'https://evil.example' } })).headers.get('access-control-allow-origin')).toBeNull();
    const fio = person(); const v = await fio.phone('0807 777 7777');
    const me = await (await fetch(`${base}/api/me`, { headers: { Origin: SITE, Authorization: `Bearer ${v.json.token}` } })).json() as any;
    expect(me.user.phone).toBe('+2348077777777');
  }, 60_000);
});
