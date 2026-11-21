// The StockRun server over HTTP on a local chain: email and wallet sign-in, profiles, naira (test credit here; Paystack
// is tested in ledger.test.ts), requests with a budget and a delivery pin, self-pickup paying the seller, and the
// privacy walls between people. Naira orders are decided by the circuits through eval (MockCircuits on this chain).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApp } from '../src/server/app.ts';
import { Accounts, ConsoleSms, openDb } from '../src/accounts/accounts.ts';
import { ConsoleEmail } from '../src/accounts/email.ts';
import { Buyers } from '../src/buyers/buyers.ts';
import { circuitEvaluator, localPlatform, type Platform } from '../src/chain/platform.ts';
import { startLocalChain, localChainAvailable, type LocalChain } from '../src/sim/localChain.ts';
import { RuleExtractor } from '../src/rules.ts';
import { BotChannel } from '../src/sim/bots.ts';
import { PriceBook } from '../src/prices/priceBook.ts';
import { Ledger } from '../src/money/ledger.ts';
import { NairaOrders } from '../src/orders/nairaOrders.ts';
import { foundTable } from '../src/discovery/hunt.ts';
import { SELLER_APPROVAL_DELAY_MS } from '../src/buyers/buyers.ts';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 9)]).toString('base64');
const MILE12 = { lat: 6.6045, lng: 3.3891, address: '12 Ikorodu Road, Ketu, Lagos' };
const SITE = 'https://1-2-433.tapekit.org';

describe.skipIf(!localChainAvailable())('StockRun server', () => {
  let chain: LocalChain; let p: Platform; let server: Server; let base: string; let ledger: Ledger;
  let clock = Date.now();
  let hunt: { db: ReturnType<typeof openDb>; places: null; osm: null; web: null; generate: null };
  let db: ReturnType<typeof openDb>;
  const mail = new ConsoleEmail();

  function person() {
    let cookie = '';
    const call = async (path: string, body?: unknown, extra: Record<string, string> = {}) => {
      const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', cookie, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      const text = await r.text();
      return { status: r.status, json: (() => { try { return JSON.parse(text); } catch { return text; } })() as any };
    };
    const email = async (address: string) => {
      const l = console.log; console.log = () => {};
      try { expect((await call('/api/auth/email-code', { email: address })).status).toBe(200); } finally { console.log = l; }
      const code = mail.sent.filter((m) => m.to === address).at(-1)!.text.match(/(\d{6})/)![1];
      return call('/api/auth/email-verify', { email: address, code });
    };
    return { call, email };
  }

  beforeAll(async () => {
    chain = await startLocalChain();
    p = localPlatform(chain);
    db = openDb();
    ledger = new Ledger(db);
    let buyers: Buyers;
    const orders = new NairaOrders({ db, ledger, evalCircuit: circuitEvaluator(p), supplierStatus: (k, u) => buyers.sellerStatus(k, u), carriers: () => buyers.carrierKeys() });
    buyers = new Buyers(db, p, ledger, orders, { extractor: new RuleExtractor(), channel: new BotChannel(), prices: new PriceBook(), foundDb: db, now: () => clock });
    hunt = { db, places: null, osm: null, web: null, generate: null };
    server = createApp({ hunt, platform: p, accounts: new Accounts(db, new ConsoleSms(), 'x'.repeat(40), Date.now, null, mail), buyers, ledger, prices: new PriceBook(), paystack: null, allowedOrigins: [SITE], log: (l) => process.env.DEBUG_SERVER && console.error(l) });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(() => { server?.close(); chain?.stop(); });

  it('email sign-in, a profile with a username and picture, and a public profile without the email', async () => {
    const ada = person();
    const v = await ada.email('ada@example.com');
    expect(v.json.user).toMatchObject({ email: 'ada@example.com', phone: null, wallet: null });
    expect((await ada.call('/api/me/profile', { username: 'ada', displayName: 'Ada Obi' })).json.user).toMatchObject({ username: 'ada', displayName: 'Ada Obi' });
    expect((await ada.call('/api/me/avatar', { mediaType: 'image/jpeg', data: JPEG })).json.user.hasAvatar).toBe(true);
    const pic = await fetch(`${base}/api/users/${v.json.user.id}/avatar`);
    expect(pic.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await pic.arrayBuffer()).toString('base64')).toBe(JPEG);
    const pub = (await person().call(`/api/users/${v.json.user.id}`)).json;
    expect(pub).toEqual({ id: v.json.user.id, username: 'ada', displayName: 'Ada Obi', hasAvatar: true });
    expect(JSON.stringify(pub)).not.toContain('ada@example.com');
    const bisi = person(); await bisi.email('bisi@example.com');
    expect((await bisi.call('/api/me/profile', { username: 'ADA' })).status).toBe(409);
  }, 60_000);

  it('wallet sign-in creates an account; an email account connects a wallet and then signs in with either', async () => {
    const w = privateKeyToAccount(generatePrivateKey());
    const tobi = person();
    const { message } = (await tobi.call(`/api/auth/wallet-message?address=${w.address}`)).json;
    const s = await tobi.call('/api/auth/wallet', { message, signature: await w.signMessage({ message }) });
    expect(s.json.user).toMatchObject({ wallet: w.address, email: null });
    expect((await tobi.call('/api/me/coins')).json).toMatchObject({ wallet: w.address, okb: '0' });

    const kemi = person(); const k = await kemi.email('kemi@example.com');
    const kw = privateKeyToAccount(generatePrivateKey());
    const m2 = (await kemi.call(`/api/auth/wallet-message?address=${kw.address}`)).json.message;
    expect((await kemi.call('/api/me/wallet', { message: m2, signature: await kw.signMessage({ message: m2 }) })).json.user).toMatchObject({ email: 'kemi@example.com', wallet: kw.address });
    const again = person();
    const m3 = (await again.call(`/api/auth/wallet-message?address=${kw.address}`)).json.message;
    expect((await again.call('/api/auth/wallet', { message: m3, signature: await kw.signMessage({ message: m3 }) })).json.user.id).toBe(k.json.user.id);
  }, 60_000);

  it('ask with a budget and a pin; collect it yourself; your count pays the seller; the rest comes back', async () => {
    const chi = person(); await chi.email('chi@example.com');
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
    const dayo = person(); await dayo.email('dayo@example.com');
    await dayo.call('/api/dev/naira', { amountNaira: 100_000 });
    const r = (await dayo.call('/api/requests', { text: '5 cartons of Indomie', budgetNaira: 20_000, place: MILE12, delivery: 'self' })).json;
    expect(r.message).toMatch(/budget/i);
    expect((await dayo.call('/api/me')).json.naira).toEqual({ availableNaira: 100_000, heldNaira: 0 });
    expect((await dayo.call('/api/requests', { text: 'rice', budgetNaira: 50_000, place: { lat: 51.5, lng: -0.1, address: 'London' }, delivery: 'self' })).status).toBe(400);

    const eve = person(); await eve.email('eve@example.com');
    expect((await eve.call('/api/orders')).json).toEqual([]);
    expect((await eve.call('/api/orders/1/collect', { count: 1 })).status).toBe(404);
    expect((await eve.call('/api/naira/history')).json).toEqual([]);
  }, 120_000);

  it('refuses the signed-out and non-JSON writes; CORS only for the listed site, with bearer sign-in', async () => {
    const anon = person();
    expect((await anon.call('/api/orders')).status).toBe(401);
    expect((await anon.call('/api/me')).json).toEqual({ user: null });
    expect((await fetch(`${base}/api/auth/email-code`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"email":"a@b.com"}' })).status).toBe(415);
    // Phone sign-in is gone.
    for (const path of ['/api/auth/code', '/api/auth/verify']) expect((await anon.call(path, { phone: '08030000000', code: '123456' })).status).toBe(404);
    expect((await fetch(`${base}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' })).status).toBe(401);

    const pre = await fetch(`${base}/api/me`, { method: 'OPTIONS', headers: { Origin: SITE, 'Access-Control-Request-Method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(SITE);
    expect((await fetch(`${base}/api/me`, { headers: { Origin: 'https://evil.example' } })).headers.get('access-control-allow-origin')).toBeNull();
    const fio = person(); const v = await fio.email('fio@example.com');
    const me = await (await fetch(`${base}/api/me`, { headers: { Origin: SITE, Authorization: `Bearer ${v.json.token}` } })).json() as any;
    expect(me.user.email).toBe('fio@example.com');
  }, 60_000);

  it('records a WhatsApp deal with a found seller: the money locks at once, RestockGuard decides, the seller is paid at pickup', async () => {
    foundTable(db);
    const add = db.prepare("INSERT INTO found_sellers (id, name, address, lat, lng, phone, source, source_url, found_at, kind) VALUES (?, ?, ?, ?, ?, ?, 'osm', 'https://www.openstreetmap.org/node/1', 0, 'supermarket')");
    add.run('found-00000000000000a1', 'Agora Marketplace', 'Egbe, Lagos', 6.6050, 3.3900, '+2349079579400');      // ~1 km from Mile 12 pin
    add.run('found-00000000000000b2', 'Far Away Store', 'Lekki, Lagos', 6.4400, 3.5300, '+2348111621102');         // ~24 km away
    const gbenga = person(); await gbenga.email('gbenga@example.com');
    const deal = { sellerId: 'found-00000000000000a1', item: 'Indomie carton', quantity: 4, unit: 'carton', unitPriceNaira: 14_000, category: 'staples', delivery: 'self', place: MILE12 };

    expect((await gbenga.call('/api/deals', deal)).json.error).toMatch(/balance is too low/);              // no money yet
    expect((await gbenga.call('/api/my-sellers/found-00000000000000a1')).json.status).toBe(0);           // and the seller was not added
    await gbenga.call('/api/dev/naira', { amountNaira: 200_000 });

    const r = (await gbenga.call('/api/deals', deal)).json;                                              // a new seller, straight away
    expect(r).toMatchObject({ status: 'locked' });
    expect(r.message).toMatch(/RestockGuard approved it; the money is locked/);
    expect((await gbenga.call('/api/my-sellers/found-00000000000000a1')).json.status).toBe(1);           // recording added them
    let [o] = (await gbenga.call('/api/orders')).json;
    expect(o).toMatchObject({ status: 'Locked', ordered: 4, unitPriceNaira: 14_000, self: true, item: 'Indomie carton' });
    expect(o.supplier.name).toMatch(/^Agora Marketplace/);
    expect(o.evidence[0]).toMatchObject({ circuit: 'restock' });
    expect((await gbenga.call('/api/me')).json.naira).toEqual({ availableNaira: 200_000 - 56_000, heldNaira: 56_000 });

    // At pickup the buyer counts 3 good cartons: PickupCheck pays the seller for 3, the 4th comes back.
    expect((await gbenga.call(`/api/orders/${o.orderId}/collect`, { count: 3 })).json).toMatchObject({ status: 'settled', outcome: 'paid_part', qty: 3 });
    [o] = (await gbenga.call('/api/orders')).json;
    expect(o.status).toBe('Delivered');
    expect((await gbenga.call('/api/me')).json.naira).toEqual({ availableNaira: 200_000 - 42_000, heldNaira: 0 });
    expect(ledger.check().ok).toBe(true);

    // Far away (over 10 km): RestockGuard asks the buyer first, nothing is locked yet.
    const far = (await gbenga.call('/api/deals', { ...deal, sellerId: 'found-00000000000000b2', quantity: 1 })).json;
    expect(far).toMatchObject({ status: 'ask_owner', reason: 5 });

    // Blocking is immediate; another buyer's list is separate.
    expect((await gbenga.call('/api/my-sellers/found-00000000000000a1/block', {})).json.status).toBe(3);
    expect((await gbenga.call('/api/deals', deal)).json.error).toMatch(/blocked/);
    const other = person(); await other.email('other@example.com');
    expect((await other.call('/api/my-sellers/found-00000000000000a1')).json.status).toBe(0);
  }, 120_000);

  it('a server can still make new sellers wait (SELLER_APPROVAL_DELAY_HOURS), like the vault', async () => {
    const orders = new NairaOrders({ db, ledger, evalCircuit: circuitEvaluator(p), supplierStatus: () => 0, carriers: () => [] });
    const slow = new Buyers(db, p, ledger, orders, { extractor: new RuleExtractor(), channel: new BotChannel(), prices: new PriceBook(), foundDb: db, now: () => clock, sellerDelayMs: SELLER_APPROVAL_DELAY_MS });
    const userId = 9_999;
    expect(slow.addSeller(userId, 'found-00000000000000a1')).toMatchObject({ status: 0, pendingStatus: 1, effectiveAt: clock + SELLER_APPROVAL_DELAY_MS });
    clock += SELLER_APPROVAL_DELAY_MS;
    expect(slow.sellerFor(userId, 'found-00000000000000a1')).toMatchObject({ status: 1, pendingStatus: null });
  });
});
