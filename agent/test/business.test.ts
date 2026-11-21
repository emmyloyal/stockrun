import { describe, expect, it } from 'vitest';
import { openDb } from '../src/accounts/accounts.ts';
import { Ledger, kobo } from '../src/money/ledger.ts';
import { Geocoder } from '../src/discovery/geocode.ts';
import { Listings } from '../src/business/listings.ts';
import { Chats } from '../src/business/chat.ts';
import { huntSellers } from '../src/discovery/hunt.ts';

const offline = new Geocoder({ fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch, log: () => {}, sleep: async () => {} });
const DAY = 86_400_000;

function setup() {
  let t = 1_800_000_000_000;
  const db = openDb(), ledger = new Ledger(db);
  const listings = new Listings({ db, ledger, geocoder: offline, now: () => t, feeNaira: 1_000, periodDays: 30 });
  const user = (email: string) => Number(db.prepare('INSERT INTO users (email, created_at) VALUES (?, 0)').run(email).lastInsertRowid);
  const store = { name: 'Mama Tolu Provisions', kind: 'wholesale', address: 'Mile 12', phone: '0803 555 1234',
    products: [{ item: 'Indomie noodles carton', unit: 'carton', priceNaira: 13_500 }, { item: 'Golden Penny spaghetti', unit: 'carton', priceNaira: 9_800 }] };
  return { db, ledger, listings, user, store, tick: (ms: number) => { t += ms; }, now: () => t };
}

describe('stores registered on StockRun', () => {
  it('waits for an admin, is paid monthly from the balance, and goes live only when approved and paid', async () => {
    const { ledger, listings, user, store, tick, now } = setup();
    const tolu = user('tolu@shop.ng');
    const b = await listings.save(tolu, store);
    expect(b).toMatchObject({ name: 'Mama Tolu Provisions', phone: '+2348035551234', review: 'pending', live: false });
    expect(b.products).toHaveLength(2);
    expect(() => listings.payMonth(tolu, 'pay-00000001')).toThrow(/checking your store/);          // not before approval

    listings.review(b.sellerId, true, '', 'boss@x.com');
    expect(() => listings.payMonth(tolu, 'pay-00000001')).toThrow(/Deposit naira first/);
    ledger.deposit(tolu, 'dep-1', kobo(5_000));
    expect(listings.payMonth(tolu, 'pay-00000001')).toMatchObject({ live: true, paidUntil: now() + 30 * DAY });
    expect(listings.payMonth(tolu, 'pay-00000001').paidUntil).toBe(now() + 30 * DAY);              // same tap: charged once
    expect(listings.payMonth(tolu, 'pay-00000002').paidUntil).toBe(now() + 60 * DAY);              // early: adds a month
    expect(ledger.system('listings')).toBe(kobo(2_000));
    expect(ledger.balance(tolu).availableKobo).toBe(kobo(3_000));
    tick(61 * DAY);
    expect(listings.mine(tolu)!.live).toBe(false);                                                // expired
    expect(listings.hidden(b.sellerId)).toBe(true);
    expect(ledger.check().ok).toBe(true);
  });

  it('rejected stores see why and go back for review when edited; one store per phone number', async () => {
    const { listings, user, store } = setup();
    const tolu = user('tolu@shop.ng'), other = user('other@x.com');
    const b = await listings.save(tolu, store);
    listings.review(b.sellerId, false, 'Add a real address', 'boss@x.com');
    expect(() => listings.payMonth(tolu, 'pay-00000001')).toThrow(/did not approve your store: Add a real address/);
    expect((await listings.save(tolu, { ...store, address: 'Mile 12, Kosofe' })).review).toBe('pending');
    await expect(listings.save(other, store)).rejects.toThrow(/already registered/);
    await expect(listings.save(tolu, { ...store, products: [] })).rejects.toThrow(/at least one product/);
    await expect(listings.save(tolu, { ...store, kind: 'spaceship' })).rejects.toThrow(/what kind of store/);
  });

  it('live stores whose products match come first in the hunt, with their prices; suspended ones disappear', async () => {
    const { db, ledger, listings, user, store } = setup();
    const tolu = user('tolu@shop.ng');
    const b = await listings.save(tolu, store);
    listings.review(b.sellerId, true, '', 'boss@x.com');
    ledger.deposit(tolu, 'dep-1', kobo(1_000));
    listings.payMonth(tolu, 'pay-00000001');
    const near = { lat: 6.5965, lng: 3.3878, address: 'Ketu' };
    const r = await huntSellers('20 cartons of Indomie', near, { db, listings }, { budgetNaira: 300_000 });
    expect(r.sellers[0]).toMatchObject({ name: 'Mama Tolu Provisions', listed: true });
    expect(r.sellers[0].products).toEqual([{ item: 'Indomie noodles carton', unit: 'carton', priceNaira: 13_500 }]);
    expect(listings.matching('rice', near, 30, ['supermarket'])).toEqual([]);                    // nothing they sell
    listings.suspend(b.sellerId, true, 'complaints');
    expect((await huntSellers('20 cartons of Indomie', near, { db, listings })).sellers.some((s) => s.name === 'Mama Tolu Provisions')).toBe(false);
  });
});

describe('chat with a registered store', () => {
  it('only the buyer and the store owner can read it; unread counts; no chats with stores that are not live', async () => {
    const { db, ledger, listings, user, store } = setup();
    const tolu = user('tolu@shop.ng'), ada = user('ada@x.com'), eve = user('eve@x.com');
    const b = await listings.save(tolu, store);
    const chats = new Chats({ db, listings });
    expect(() => chats.open(ada, b.sellerId)).toThrow(/WhatsApp instead/);                       // not live yet
    listings.review(b.sellerId, true, '', 'boss@x.com');
    ledger.deposit(tolu, 'dep-1', kobo(1_000));
    listings.payMonth(tolu, 'pay-00000001');

    const c = chats.open(ada, b.sellerId);
    expect(c).toMatchObject({ role: 'buyer', store: { name: 'Mama Tolu Provisions' } });
    expect(chats.open(ada, b.sellerId).id).toBe(c.id);                                            // the same chat again
    expect(() => chats.open(tolu, b.sellerId)).toThrow(/your own store/);
    chats.send(ada, c.id, 'Good morning, do you have 20 cartons of Indomie?');
    expect(chats.unread(tolu)).toBe(1);
    expect(chats.list(tolu)[0]).toMatchObject({ role: 'shop', buyer: { label: 'ada' }, unread: 1 });
    expect(chats.messages(tolu, c.id).map((m) => [m.from, m.text])).toEqual([['buyer', 'Good morning, do you have 20 cartons of Indomie?']]);
    expect(chats.unread(tolu)).toBe(0);                                                           // read
    const reply = chats.send(tolu, c.id, 'Yes, ₦13,500 per carton.');
    expect(chats.messages(ada, c.id, reply.id - 1)).toEqual([{ id: reply.id, from: 'shop', text: 'Yes, ₦13,500 per carton.', at: reply.at }]);
    expect(() => chats.messages(eve, c.id)).toThrow(/No such chat/);
    expect(() => chats.send(eve, c.id, 'hi')).toThrow(/No such chat/);
    expect(() => chats.send(ada, c.id, '   ')).toThrow(/Type a message/);
    listings.suspend(b.sellerId, true, 'complaints');
    expect(() => chats.send(ada, c.id, 'Hello?')).toThrow(/not on StockRun right now/);
  });
});
