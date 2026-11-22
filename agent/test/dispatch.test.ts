// A logistics company booked from a naira request, end to end: quote -> RestockGuard locks goods + fee in the ledger
// -> booking -> the company's "picked up" pays the seller -> the buyer counts at the door -> "delivered" pays the
// company's fee, or holds it back when goods are short. The company is a stand-in whose status the test controls;
// the Sendrelay connector itself is tested in sendrelay.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
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
import type { Booking, BookingUpdate, Carrier, CarrierQuote, DeliveryJob, DeliveryState } from '../src/logistics/carrier.ts';

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

const PLACE = { lat: 6.6045, lng: 3.3891, address: '12 Ikorodu Road, Ketu, Lagos' };

describe.skipIf(!localChainAvailable())('logistics company booked from a naira request', () => {
  let chain: LocalChain; let p: Platform; let server: Server; let base: string; let buyers: Buyers; let ledger: Ledger;
  const mail = new ConsoleEmail(), standin = new StandIn();
  let cookie = '';
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, json: await r.json() as any };
  };
  const poll = () => buyers.dispatcher.poll(buyers.dispatchSets());

  beforeAll(async () => {
    chain = await startLocalChain();
    p = { ...localPlatform(chain) };
    p.carriers = [{ id: 'standin', name: standin.name, connector: standin,
      wallet: createWalletClient({ account: privateKeyToAccount('0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6'), chain: anvil, transport: http(chain.url) }) }];
    const db = openDb();
    ledger = new Ledger(db);
    const orders = new NairaOrders({ db, ledger, evalCircuit: circuitEvaluator(p), supplierStatus: (k, u) => buyers.sellerStatus(k, u), carriers: () => buyers.carrierKeys() });
    buyers = new Buyers(db, p, ledger, orders, { extractor: new RuleExtractor(), channel: new BotChannel(), prices: new PriceBook() });
    server = createApp({ platform: p, accounts: new Accounts(db, new ConsoleSms(), 'x'.repeat(40), Date.now, null, mail), buyers, ledger, prices: new PriceBook(), paystack: null });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const l = console.log; console.log = () => {};
    try { await call('/api/auth/email-code', { email: 'buyer@example.com' }); } finally { console.log = l; }
    await call('/api/auth/email-verify', { email: 'buyer@example.com', code: mail.sent.at(-1)!.text.match(/(\d{6})/)![1] });
    await call('/api/dev/naira', { amountNaira: 300_000 });
  }, 60_000);
  afterAll(() => { server?.close(); chain?.stop(); });

  it('books at its quote, pays the seller on its pickup, then records the delivery on the buyer\'s count; its fee never passes through StockRun', async () => {
    const placed = (await call('/api/requests', { text: '5 cartons of Indomie', budgetNaira: 100_000, place: PLACE, delivery: 'logistics', contactPhone: '0803 777 0001' })).json;
    expect(placed.message).toMatch(/delivery by Stand-in Logistics, ₦2,500 paid to them directly.*funds locked in escrow/);
    let [o] = (await call('/api/orders')).json;
    expect(o).toMatchObject({ money: 'naira', self: false, status: 'Locked', courierFeeNaira: 2500, logistics: { carrier: 'standin', state: 'booked', handoverCode: '482913' } });
    expect(standin.booked[0]).toMatchObject({ item: { quantity: 5 }, dropoff: { contactPhone: '+2348037770001', address: PLACE.address } });
    const bookingId = o.logistics.bookingId;
    expect((await call(`/api/orders/${o.orderId}/received`, { count: 5 })).status).toBe(409);       // not picked up yet

    standin.move(bookingId, 'picked_up'); await poll();
    [o] = (await call('/api/orders')).json;
    expect(o).toMatchObject({ status: 'PickedUp', pickup: { picked: 5 }, logistics: { pickupSigned: true, riderName: 'Kemi' } });
    expect(ledger.system('sellers')).toBe(5 * o.unitPriceNaira * 100);

    expect((await call(`/api/orders/${o.orderId}/received`, { count: 5 })).status).toBe(200);
    standin.move(bookingId, 'delivered'); await poll();
    [o] = (await call('/api/orders')).json;
    expect(o.status).toBe('Delivered');
    expect(ledger.system('logistics')).toBe(0);                          // the buyer pays the company directly
    expect(o.evidence.map((e: { circuit: string }) => e.circuit)).toEqual(['restock', 'pickup', 'delivery']);

    // Second order arrives short (3 of 5): DeliveryCheck records it; no money moves.
    await call('/api/requests', { text: '5 cartons of Indomie', budgetNaira: 100_000, place: PLACE, delivery: 'logistics', contactPhone: '0803 777 0001' });
    const o2 = (await call('/api/orders')).json.find((x: any) => x.orderId !== o.orderId);
    standin.move(o2.logistics.bookingId, 'picked_up'); await poll();
    const before = (await call('/api/me')).json.naira.availableNaira;
    expect((await call(`/api/orders/${o2.orderId}/received`, { count: 3 })).status).toBe(200);
    standin.move(o2.logistics.bookingId, 'delivered'); await poll();
    expect(ledger.system('logistics')).toBe(0);
    expect((await call('/api/me')).json.naira.availableNaira - before).toBe(0);
    const after2 = (await call('/api/orders')).json.find((x: any) => x.orderId === o2.orderId);
    expect(after2.status).toBe('Delivered');
    expect(after2.evidence.map((e: { circuit: string }) => e.circuit)).toEqual(['restock', 'pickup', 'delivery']);
    expect(ledger.check().ok).toBe(true);
  }, 180_000);
});
