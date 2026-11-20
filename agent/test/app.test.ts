// Multi-shop server on a local chain: real sign-in (SMS codes captured from the console sender), keys made "on the phone"
// (here: in the test), a vault deployed per shop, the owner and rider signing their own steps through /rpc, and checks
// that nobody can see or act on someone else's shop or jobs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { createApp } from '../src/server/app.ts';
import { Accounts, ConsoleSms, openDb } from '../src/accounts/accounts.ts';
import { Shops } from '../src/accounts/shops.ts';
import { localPlatform, tokenAbi, type Platform } from '../src/chain/platform.ts';
import { startLocalChain, localChainAvailable, type LocalChain } from '../src/sim/localChain.ts';
import { RuleExtractor } from '../src/rules.ts';
import { BotChannel } from '../src/sim/bots.ts';
import { PriceBook } from '../src/prices/priceBook.ts';
import { supplierKey } from '../src/tools/suppliers.ts';
import type { PhotoCount, PhotoCounter } from '../src/check/photoCount.ts';

const vaultAbi = parseAbi([
  'function queueSupplier(bytes32,uint8,address)', 'function applySupplier(bytes32)', 'function deposit(uint256)', 'function postBond(uint256)',
  'function riderPickup(uint256,bool,uint8)', 'function owner() view returns (address)',
]);
class Scripted implements PhotoCounter { queue: PhotoCount[] = []; async count() { return this.queue.shift() ?? null; } }
const seen = (count: number): PhotoCount => ({ itemVisible: true, count, confidence: 'high', damage: false, damageNotes: '', photoProblem: 'none' });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9]).toString('base64');
const OJOTA = { lat: 6.587, lng: 3.381 };

describe.skipIf(!localChainAvailable())('multi-shop app server', () => {
  let chain: LocalChain; let p: Platform; let server: Server; let base: string; let sms: ConsoleSms; const counter = new Scripted();

  /** One person on one phone: a cookie jar and a key that never leaves the "phone". */
  function person(phone: string) {
    let cookie = '';
    const key = privateKeyToAccount(generatePrivateKey());
    const call = async (path: string, body?: unknown, type = 'application/json') => {
      const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': type, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      return { status: r.status, json: await r.json() as any };
    };
    const transport = () => http(`${base}/rpc`, { fetchOptions: { headers: { cookie } } });
    const sign = async (address: Address, functionName: string, args: unknown[]) => {
      const w = createWalletClient({ account: key, chain: anvil, transport: transport() });
      const hash = await w.writeContract({ address, abi: [...vaultAbi, ...tokenAbi], functionName: functionName as never, args: args as never });
      const r = await createPublicClient({ chain: anvil, transport: transport() }).waitForTransactionReceipt({ hash });
      expect(r.status).toBe('success');
    };
    const signIn = async (role: 'owner' | 'rider', testMoney = true) => {
      const log = console.log; console.log = () => {};
      try { expect((await call('/api/auth/code', { phone })).status).toBe(200); } finally { console.log = log; }
      const code = sms.sent.filter((m) => m.phone.endsWith(phone.replace(/\D/g, '').slice(-10))).at(-1)!.text.match(/(\d{6})/)![1];
      expect((await call('/api/auth/verify', { phone, code, role })).status).toBe(200);
      const { message } = (await call(`/api/me/link-message?address=${key.address}`)).json;
      expect((await call('/api/me/key', { address: key.address, signature: await key.signMessage({ message }) })).status).toBe(200);
      if (testMoney) expect((await call('/api/me/test-money', {})).status).toBe(200);
    };
    return { key, call, sign, signIn, cookie: () => cookie };
  }

  beforeAll(async () => {
    chain = await startLocalChain();
    p = localPlatform(chain);
    const db = openDb();
    sms = new ConsoleSms();
    const accounts = new Accounts(db, sms, 'x'.repeat(40));
    const shops = new Shops(db, p, { extractor: new RuleExtractor(), channel: new BotChannel(), counter, prices: new PriceBook() });
    server = createApp({ platform: p, accounts, shops, allowedOrigins: ['https://1-2-433.tapekit.org'] });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(() => { server?.close(); chain?.stop(); });

  it('two owners: set up, deposit, order with a logistics company or collect it yourself, with neither reaching the other', async () => {
    const ada = person('0803 111 1111'), bisi = person('0803 222 2222');
    for (const who of [ada, bisi]) await who.signIn('owner');

    // Shop setup deploys a vault owned by the phone key.
    const shop = (await ada.call('/api/shop', { name: "Ada's Provisions", ...OJOTA, weeklyBudgetNaira: 500_000, limitNaira: 100_000 })).json.shop;
    expect(await p.pub.readContract({ address: shop.vault, abi: vaultAbi, functionName: 'owner' })).toBe(ada.key.address);
    expect((await ada.call('/api/shop', { name: 'Again', ...OJOTA, weeklyBudgetNaira: 500_000, limitNaira: 100_000 })).status).toBe(409);
    expect((await bisi.call('/api/shop', { name: 'Far away', lat: 9.07, lng: 7.49, weeklyBudgetNaira: 500_000, limitNaira: 100_000 })).status).toBe(400);
    await bisi.call('/api/shop', { name: "Bisi's Store", lat: 6.6, lng: 3.35, weeklyBudgetNaira: 300_000, limitNaira: 50_000 });

    // Ada approves a supplier (her key signs; approvals wait 24 h), funds her vault.
    const map = (await ada.call('/api/map')).json;
    const adeyemi = map.suppliers.find((s: any) => s.id === 'sim-mile12-adeyemi');
    expect(adeyemi.status).toBe(0);
    await ada.sign(shop.vault, 'queueSupplier', [adeyemi.key, 1, map.supplierPayout]);
    await ada.call('/api/dev/advance-day', {});
    await ada.sign(shop.vault, 'applySupplier', [supplierKey('sim-mile12-adeyemi')]);
    await ada.sign(p.token, 'approve', [shop.vault, 2n ** 255n]);
    await ada.sign(shop.vault, 'deposit', [p.money.toToken(400_000)]);
    expect((await ada.call('/api/shop/money')).json).toMatchObject({ vaultNaira: 400_000, availableNaira: 400_000, weeklyBudgetNaira: 500_000, limitNaira: 100_000 });

    // Order with a logistics company: the platform's company is trusted by every new vault; no bond anywhere.
    const company = p.carriers[0].wallet;
    const placed = (await ada.call('/api/orders', { text: '5 cartons of Indomie within 5 km' })).json;
    expect(placed.message).toMatch(/delivery by Demo logistics company.*funds locked in escrow\. Order #0/);
    expect((await bisi.call('/api/orders')).json).toEqual([]);                       // Bisi sees none of Ada's orders
    const [job] = (await ada.call('/api/orders')).json;
    expect(job).toMatchObject({ orderId: '0', status: 'Locked', rider: company.account.address });

    // The company confirms the 5 cartons at pickup (its dispatch desk signs); no photo needed; the supplier is paid.
    const ch = await company.writeContract({ address: shop.vault, abi: vaultAbi, functionName: 'riderPickup', args: [0n, true, 5] });
    await p.pub.waitForTransactionReceipt({ hash: ch });
    expect((await bisi.call(`/api/orders/0/settle`, { stage: 'pickup' })).status).toBe(404);       // not Bisi's order
    expect((await ada.call(`/api/orders/0/settle`, { stage: 'pickup' })).json).toMatchObject({ status: 'settled', outcome: 'paid', qty: 5 });
    expect(await p.pub.readContract({ address: p.token, abi: tokenAbi, functionName: 'balanceOf', args: [p.supplierPayout] })).toBe(5n * p.money.toToken(13_300));

    // Bisi collects herself: no delivery fee; her own count pays the supplier and the order is done.
    const bshop = (await bisi.call('/api/me')).json.shop;
    await bisi.sign(bshop.vault, 'queueSupplier', [adeyemi.key, 1, map.supplierPayout]);
    await bisi.call('/api/dev/advance-day', {});
    await bisi.sign(bshop.vault, 'applySupplier', [supplierKey('sim-mile12-adeyemi')]);
    await bisi.sign(p.token, 'approve', [bshop.vault, 2n ** 255n]);
    await bisi.sign(bshop.vault, 'deposit', [p.money.toToken(100_000)]);
    const mine = (await bisi.call('/api/orders', { text: '3 cartons of Indomie within 10 km', delivery: 'self' })).json;
    expect(mine.message).toMatch(/you collect it yourself, no delivery fee.*funds locked in escrow/);
    const [bjob] = (await bisi.call('/api/orders')).json;
    expect(bjob).toMatchObject({ rider: bisi.key.address, riderFeeNaira: 0, status: 'Locked' });
    const payoutBefore = await p.pub.readContract({ address: p.token, abi: tokenAbi, functionName: 'balanceOf', args: [p.supplierPayout] });
    await bisi.sign(bshop.vault, 'riderPickup', [BigInt(bjob.orderId), true, 3]);
    expect((await bisi.call(`/api/orders/${bjob.orderId}/settle`, { stage: 'pickup' })).json).toMatchObject({ status: 'settled', outcome: 'paid', qty: 3 });
    expect(await p.pub.readContract({ address: p.token, abi: tokenAbi, functionName: 'balanceOf', args: [p.supplierPayout] }) - payoutBefore).toBe(3n * p.money.toToken(13_300));
    expect((await bisi.call('/api/orders')).json[0].status).toBe('Delivered');
  }, 120_000);

  it('refuses the unauthenticated, the wrong role, non-JSON writes and test-node controls', async () => {
    const anon = person('0807 555 5555');
    expect((await anon.call('/api/orders')).status).toBe(401);
    expect((await anon.call('/api/me')).json).toEqual({ user: null });
    expect((await anon.call('/api/auth/code', { phone: '0807 555 5555' }, 'text/plain')).status).toBe(415);
    const rpc = (cookie: string, method: string) => fetch(`${base}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) });
    expect((await rpc('', 'eth_blockNumber')).status).toBe(401);
    await anon.signIn('rider');
    expect((await rpc(anon.cookie(), 'eth_blockNumber')).status).toBe(200);
    expect((await rpc(anon.cookie(), 'evm_increaseTime')).status).toBe(403);
    expect((await anon.call('/api/me')).json.user.role).toBe('owner');               // no rider accounts: asking for one gives an owner
    expect((await anon.call('/api/orders')).status).toBe(409);                        // ...who must set up a shop first
    expect((await anon.call('/api/auth/verify', { phone: '0807 555 5555', code: '000000' })).status).toBe(400);
  }, 60_000);

  it('a new buyer gets gas once, at shop set-up, and can price a deposit in naira', async () => {
    const chioma = person('0809 666 6666');
    await chioma.signIn('owner', false);                                            // a brand-new phone key: no gas, no money
    expect(await p.pub.getBalance({ address: chioma.key.address })).toBe(0n);
    expect((await chioma.call('/api/shop', { name: "Chioma's Shop", ...OJOTA, weeklyBudgetNaira: 300_000, limitNaira: 100_000 })).status).toBe(200);
    expect(await p.pub.getBalance({ address: chioma.key.address })).toBe(p.gasTopUpWei);
    expect((await chioma.call('/api/me/gas', {})).json).toEqual({ tx: null, already: true });   // never twice
    expect(await p.pub.getBalance({ address: chioma.key.address })).toBe(p.gasTopUpWei);

    expect((await chioma.call('/api/money/to-token?naira=150000')).json).toEqual({ naira: 150_000, amount: p.money.toToken(150_000).toString(), symbol: 'TEST' });
    expect((await chioma.call('/api/money/to-token?naira=1.5')).status).toBe(400);
    expect((await person('0809 777 7777').call('/api/money/to-token?naira=100')).status).toBe(401);
    expect((await chioma.call('/api/config')).json).toMatchObject({ network: 'local', explorerTx: null, tokenSymbol: 'TEST' });
  }, 60_000);

  it('the app on DeWEB: CORS only for the listed site, and sign-in by bearer token instead of the cookie', async () => {
    const site = 'https://1-2-433.tapekit.org';
    const pre = await fetch(`${base}/api/me`, { method: 'OPTIONS', headers: { Origin: site, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(site);
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
    const other = await fetch(`${base}/api/me`, { headers: { Origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();

    const phone = '0809 888 8888';
    await (async () => { const l = console.log; console.log = () => {}; try { await fetch(`${base}/api/auth/code`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: site }, body: JSON.stringify({ phone }) }); } finally { console.log = l; } })();
    const code = sms.sent.filter((m) => m.phone.endsWith('8098888888')).at(-1)!.text.match(/(\d{6})/)![1];
    const v = await (await fetch(`${base}/api/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: site }, body: JSON.stringify({ phone, code, role: 'owner' }) })).json() as any;
    expect(v.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const me = await (await fetch(`${base}/api/me`, { headers: { Origin: site, Authorization: `Bearer ${v.token}` } })).json() as any;
    expect(me.user.phone).toBe('+2348098888888');
    const rpc = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: site, Authorization: `Bearer ${v.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) });
    expect(rpc.status).toBe(200);
    expect((await (await fetch(`${base}/api/me`, { headers: { Authorization: 'Bearer not-a-real-token-at-all-000' } })).json() as any).user).toBeNull();
  }, 60_000);
});
