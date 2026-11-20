// A logistics company booked from a real order, end to end on a local chain: quote -> RestockGuard locks goods and fee
// -> booking -> the company's "picked up" pays the supplier -> the owner counts at the door -> "delivered" pays the
// company's fee, or holds it back for the owner when goods are short. The company here is a stand-in whose status the
// test controls; the Sendrelay connector itself is tested in sendrelay.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createPublicClient, createWalletClient, http, parseAbi, type Address } from 'viem';
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
import type { Booking, BookingUpdate, Carrier, CarrierQuote, DeliveryJob, DeliveryState } from '../src/logistics/carrier.ts';

/** A logistics company whose rider the test moves along. */
class StandIn implements Carrier {
  readonly id = 'standin'; readonly name = 'Stand-in Logistics';
  price = 2500; booked: DeliveryJob[] = []; states = new Map<string, DeliveryState>();
  async quote(job: DeliveryJob): Promise<CarrierQuote> { return { carrier: this.id, quoteId: `q-${job.ref}`, priceNaira: this.price, expiresAt: Date.now() + 3600_000, vehicle: 'MOTORCYCLE', test: true }; }
  async book(job: DeliveryJob, q: CarrierQuote): Promise<Booking> {
    if (!this.booked.some((b) => b.ref === job.ref)) this.booked.push(job);
    this.states.set(`b-${job.ref}`, 'assigned');
    return { carrier: this.id, bookingId: `b-${job.ref}`, ref: job.ref, state: 'booked', priceNaira: q.priceNaira, handoverCode: '482913', test: true };
  }
  async get(id: string): Promise<BookingUpdate> { return { bookingId: id, state: this.states.get(id)!, rider: { name: 'Kemi', vehicle: 'MOTORCYCLE' }, failureReason: null, dropoffPhotoUrl: null, at: Date.now() }; }
  async cancel() {}
  async trackingLink(id: string) { return `https://track.example/${id}`; }
  move(id: string, s: DeliveryState) { this.states.set(id, s); }
}

const vaultAbi = parseAbi(['function queueSupplier(bytes32,uint8,address)', 'function applySupplier(bytes32)', 'function deposit(uint256)', 'function ownerConfirm(uint256,bool,bool)', 'function approveOrder(uint256)']);

describe.skipIf(!localChainAvailable())('logistics company booked from an order', () => {
  let chain: LocalChain; let p: Platform; let server: Server; let base: string; let shops: Shops;
  const sms = new ConsoleSms(), standin = new StandIn();
  let cookie = '';
  const key = privateKeyToAccount(generatePrivateKey());
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, json: await r.json() as any };
  };
  const sign = async (address: Address, functionName: string, args: unknown[]) => {
    const t = http(`${base}/rpc`, { fetchOptions: { headers: { cookie } } });
    const hash = await createWalletClient({ account: key, chain: anvil, transport: t }).writeContract({ address, abi: [...vaultAbi, ...tokenAbi], functionName: functionName as never, args: args as never });
    expect((await createPublicClient({ chain: anvil, transport: t }).waitForTransactionReceipt({ hash })).status).toBe('success');
  };
  const balance = (a: Address) => p.pub.readContract({ address: p.token, abi: tokenAbi, functionName: 'balanceOf', args: [a] });
  const quiet = async <T,>(f: () => Promise<T>) => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };

  beforeAll(async () => {
    chain = await startLocalChain();
    const local = localPlatform(chain);
    // The platform works with one booking-capable company; its desk key is anvil's public test key #9.
    p = { ...local, carriers: [{ id: 'standin', name: standin.name, connector: standin,
      wallet: createWalletClient({ account: privateKeyToAccount('0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6'), chain: anvil, transport: http(chain.url) }) }] };
    const db = openDb();
    shops = new Shops(db, p, { extractor: new RuleExtractor(), channel: new BotChannel(), counter: null, prices: new PriceBook() });
    server = createApp({ platform: p, accounts: new Accounts(db, sms, 'x'.repeat(40)), shops, sendrelayWebhookSecret: 'whsec_dGVzdA' });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await quiet(() => call('/api/auth/code', { phone: '0803 777 0001' }));
    const code = sms.sent.at(-1)!.text.match(/(\d{6})/)![1];
    await call('/api/auth/verify', { phone: '0803 777 0001', code, role: 'owner' });
    const { message } = (await call(`/api/me/link-message?address=${key.address}`)).json;
    await call('/api/me/key', { address: key.address, signature: await key.signMessage({ message }) });
    await call('/api/me/test-money', {});
  }, 60_000);
  afterAll(() => { server?.close(); chain?.stop(); });

  it('books the company at its quote, pays the supplier on its pickup, then pays or withholds its fee on the owner count', async () => {
    const shop = (await call('/api/shop', { name: "Kemi's Kiosk", lat: 6.587, lng: 3.381, weeklyBudgetNaira: 500_000, limitNaira: 200_000 })).json.shop;
    const map = (await call('/api/map')).json;
    await sign(shop.vault, 'queueSupplier', [supplierKey('sim-mile12-adeyemi'), 1, map.supplierPayout]);
    await call('/api/dev/advance-day', {});
    await sign(shop.vault, 'applySupplier', [supplierKey('sim-mile12-adeyemi')]);
    await sign(p.token, 'approve', [shop.vault, 2n ** 255n]);
    await sign(shop.vault, 'deposit', [p.money.toToken(300_000)]);

    // Order: the company's ₦2,500 quote becomes the locked delivery fee, and it is booked once.
    const placed = (await call('/api/orders', { text: '5 cartons of Indomie within 5 km' })).json;
    expect(placed.message).toMatch(/₦2,500 delivery by Stand-in Logistics.*funds locked in escrow/);
    let [o] = (await call('/api/orders')).json;
    expect(o).toMatchObject({ status: 'Locked', riderFeeNaira: 2500, logistics: { carrier: 'standin', state: 'booked', handoverCode: '482913', trackingUrl: expect.stringContaining('track.example') } });
    expect(standin.booked).toHaveLength(1);
    expect(standin.booked[0]).toMatchObject({ item: { quantity: 5, valueNaira: 66_500 }, dropoff: { contactPhone: '+2348037770001' } });
    const bookingId = o.logistics.bookingId;

    // Counting at the door before pickup is refused.
    expect((await call(`/api/orders/${o.orderId}/received`, { count: 5 })).status).toBe(409);

    // The company reports "picked up": its desk key confirms on-chain and PickupCheck pays the supplier for 5.
    const payout0 = await balance(p.supplierPayout);
    standin.move(bookingId, 'picked_up');
    await shops.dispatcher.poll(shops.dispatchShops());
    expect(await balance(p.supplierPayout) - payout0).toBe(5n * p.money.toToken(13_300));
    [o] = (await call('/api/orders')).json;
    expect(o).toMatchObject({ status: 'PickedUp', logistics: { pickupSigned: true, state: 'picked_up', riderName: 'Kemi' } });

    // Owner counts 5 at the door and confirms; the rider enters the code (COMPLETED) -> the company's fee is paid.
    expect((await call(`/api/orders/${o.orderId}/received`, { count: 5 })).status).toBe(200);
    await sign(shop.vault, 'ownerConfirm', [BigInt(o.orderId), true, false]);
    const desk = p.carriers[0].wallet.account.address, fee0 = await balance(desk);
    standin.move(bookingId, 'delivered');
    await shops.dispatcher.poll(shops.dispatchShops());
    expect(await balance(desk) - fee0).toBe(p.money.toToken(2_500));
    [o] = (await call('/api/orders')).json;
    expect(o.status).toBe('Delivered');

    // Second order arrives short: 3 of 5. The fee is held back for the owner; nothing goes to the company.
    await call('/api/orders', { text: '5 cartons of Indomie within 5 km' });
    const o2 = (await call('/api/orders')).json.find((x: any) => x.orderId === '1');
    standin.move(o2.logistics.bookingId, 'picked_up');
    await shops.dispatcher.poll(shops.dispatchShops());
    expect((await call(`/api/orders/1/received`, { count: 3 })).status).toBe(200);
    const fee1 = await balance(desk), free1 = (await call('/api/shop/money')).json.availableNaira;
    standin.move(o2.logistics.bookingId, 'delivered');
    await shops.dispatcher.poll(shops.dispatchShops());
    expect(await balance(desk)).toBe(fee1);
    expect((await call('/api/shop/money')).json.availableNaira - free1).toBe(2_500);
    expect((await call('/api/orders')).json.find((x: any) => x.orderId === '1').status).toBe('Delivered');
  }, 180_000);

  it('never books above the fee locked in the vault, and refuses unsigned webhooks', async () => {
    // 20 cartons is above the owner's ₦200,000 auto-approve limit: the order waits for the owner, unbooked.
    await call('/api/orders', { text: '20 cartons of Indomie within 5 km' });
    let o = (await call('/api/orders')).json.find((x: any) => x.orderId === '2');
    expect(o).toMatchObject({ status: 'AwaitingOwner', riderFeeNaira: 2500 });
    expect(o.logistics.bookingId).toBeUndefined();
    // Meanwhile the quote expires and the company's price rises to ₦9,000.
    const s = shops.dispatchShops()[0];
    s.jobs.updateDelivery('2', { quote: { ...o.logistics.quote, expiresAt: 0 } });
    standin.price = 9000;
    const booked = standin.booked.length;
    await sign(o.vault, 'approveOrder', [2n]);
    o = (await call('/api/orders')).json.find((x: any) => x.orderId === '2');       // listing books pending orders
    expect(o.status).toBe('Locked');
    expect(o.logistics.bookingId).toBeUndefined();
    expect(o.logistics.error).toMatch(/Booking refused: Stand-in Logistics now asks ₦9,000, more than the ₦2,500 locked/);
    expect(standin.booked).toHaveLength(booked);

    const r = await fetch(`${base}/api/webhooks/sendrelay`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Relay-Signature': 't=1,v1=' + '0'.repeat(64) }, body: '{}' });
    expect(r.status).toBe(401);
  }, 120_000);
});
