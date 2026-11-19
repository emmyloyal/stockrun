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
    const signIn = async (role: 'owner' | 'rider') => {
      const log = console.log; console.log = () => {};
      try { expect((await call('/api/auth/code', { phone })).status).toBe(200); } finally { console.log = log; }
      const code = sms.sent.filter((m) => m.phone.endsWith(phone.replace(/\D/g, '').slice(-10))).at(-1)!.text.match(/(\d{6})/)![1];
      expect((await call('/api/auth/verify', { phone, code, role })).status).toBe(200);
      const { message } = (await call(`/api/me/link-message?address=${key.address}`)).json;
      expect((await call('/api/me/key', { address: key.address, signature: await key.signMessage({ message }) })).status).toBe(200);
      expect((await call('/api/me/test-money', {})).status).toBe(200);
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
    server = createApp({ platform: p, accounts, shops });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(() => { server?.close(); chain?.stop(); });

  it('two owners and two riders: sign up, set up, order, pick up, with nobody reaching anyone else', async () => {
    const ada = person('0803 111 1111'), bisi = person('0803 222 2222'), tunde = person('0805 333 3333'), musa = person('0805 444 4444');
    for (const [who, role] of [[ada, 'owner'], [bisi, 'owner'], [tunde, 'rider'], [musa, 'rider']] as const) await who.signIn(role);

    // Shop setup deploys a vault owned by the phone key.
    const shop = (await ada.call('/api/shop', { name: "Ada's Provisions", ...OJOTA, weeklyBudgetNaira: 500_000, limitNaira: 100_000 })).json.shop;
    expect(await p.pub.readContract({ address: shop.vault, abi: vaultAbi, functionName: 'owner' })).toBe(ada.key.address);
    expect((await ada.call('/api/shop', { name: 'Again', ...OJOTA, weeklyBudgetNaira: 500_000, limitNaira: 100_000 })).status).toBe(409);
    expect((await tunde.call('/api/shop', { name: 'Rider shop', ...OJOTA, weeklyBudgetNaira: 500_000, limitNaira: 100_000 })).status).toBe(403);
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

    // Riders: profile + bond in Ada's vault.
    await tunde.call('/api/rider/profile', { name: 'Tunde', lat: 6.6, lng: 3.39 });
    await musa.call('/api/rider/profile', { name: 'Musa', lat: 6.45, lng: 3.39 });
    await tunde.sign(p.token, 'approve', [shop.vault, 2n ** 255n]);
    await tunde.sign(shop.vault, 'postBond', [p.money.toToken(200_000)]);

    // Order: the agent proposes to Ada's vault; RestockGuard approves; Tunde (bonded) is booked.
    const placed = (await ada.call('/api/orders', { text: '5 cartons of Indomie within 5 km' })).json;
    expect(placed.message).toMatch(/funds locked in escrow\. Order #0/);
    expect((await bisi.call('/api/orders')).json).toEqual([]);                       // Bisi sees none of Ada's orders
    const [job] = (await tunde.call('/api/rider/jobs')).json;
    expect(job).toMatchObject({ shopId: shop.id, orderId: '0', status: 'Locked', rider: tunde.key.address });
    expect((await musa.call('/api/rider/jobs')).json).toEqual([]);

    // Pickup: Tunde signs his count; Musa cannot send photos for Tunde's job; the photo settles the pickup.
    await tunde.sign(shop.vault, 'riderPickup', [0n, true, 5]);
    expect((await musa.call(`/api/jobs/${shop.id}/0/photo`, { stage: 'pickup', mediaType: 'image/jpeg', data: JPEG })).status).toBe(404);
    counter.queue.push(seen(5));
    expect((await tunde.call(`/api/jobs/${shop.id}/0/photo`, { stage: 'pickup', mediaType: 'image/jpeg', data: JPEG })).json).toMatchObject({ status: 'settled', outcome: 'paid', qty: 5 });
    expect(await p.pub.readContract({ address: p.token, abi: tokenAbi, functionName: 'balanceOf', args: [p.supplierPayout] })).toBe(5n * p.money.toToken(13_300));
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
    expect((await anon.call('/api/orders')).status).toBe(403);                        // riders have no shop orders
    expect((await anon.call('/api/auth/verify', { phone: '0807 555 5555', code: '000000' })).status).toBe(400);
  }, 60_000);
});
