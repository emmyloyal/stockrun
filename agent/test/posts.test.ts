import { describe, expect, it } from 'vitest';
import { openDb } from '../src/accounts/accounts.ts';
import { Ledger, kobo } from '../src/money/ledger.ts';
import { Geocoder } from '../src/discovery/geocode.ts';
import { Listings } from '../src/business/listings.ts';
import { Posts } from '../src/business/posts.ts';
import { Chats } from '../src/business/chat.ts';

const offline = new Geocoder({ fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch, log: () => {}, sleep: async () => {} });
const DAY = 86_400_000;
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');

async function setup() {
  let t = 1_800_000_000_000;
  const db = openDb(), ledger = new Ledger(db);
  const listings = new Listings({ db, ledger, geocoder: offline, now: () => t });
  const posts = new Posts({ db, listings, now: () => t });
  const user = (email: string) => Number(db.prepare('INSERT INTO users (email, created_at) VALUES (?, 0)').run(email).lastInsertRowid);
  const tolu = user('tolu@shop.ng'), ada = user('ada@buyer.ng');
  const store = await listings.save(tolu, { name: 'Mama Tolu Provisions', kind: 'wholesale', address: 'Mile 12', phone: '0803 555 1234',
    products: [{ item: 'Indomie noodles carton', unit: 'carton', priceNaira: 13_500 }] });
  const goLive = () => { listings.review(store.sellerId, true, '', 'boss@x.com'); ledger.deposit(tolu, 'dep-1', kobo(5_000)); listings.payMonth(tolu, 'pay-00000001'); };
  return { db, listings, posts, tolu, ada, store, goLive, tick: (ms: number) => { t += ms; } };
}

describe('store posts and the buyers\' feed', () => {
  it('only a live store can post; buyers see it in the feed with the store, price and photo', async () => {
    const { posts, tolu, ada, store, goLive } = await setup();
    expect(() => posts.create(ada, { text: 'Fresh stock' })).toThrow(/Register your store/);
    expect(() => posts.create(tolu, { text: 'Fresh stock' })).toThrow(/approved/);          // pending review
    goLive();
    const p = posts.create(tolu, { text: '  New Indomie stock just arrived  ', priceNaira: 13_000, unit: 'Carton', photo: { mediaType: 'image/jpeg', data: JPEG } });
    expect(p).toMatchObject({ text: 'New Indomie stock just arrived', priceNaira: 13_000, unit: 'carton', hasPhoto: true, mine: true, store: { sellerId: store.sellerId, name: 'Mama Tolu Provisions' } });
    const [seen] = posts.feed(ada);
    expect(seen).toMatchObject({ id: p.id, mine: false });
    expect(posts.photo(p.id)?.type).toBe('image/jpeg');
    expect(posts.store(ada, store.sellerId)).toMatchObject({ name: 'Mama Tolu Provisions', mine: false, products: [{ item: 'Indomie noodles carton' }], posts: [{ id: p.id }] });
  });

  it('checks text, price and photo bytes', async () => {
    const { posts, tolu, goLive } = await setup();
    goLive();
    expect(() => posts.create(tolu, { text: '' })).toThrow(/Write what you have/);
    expect(() => posts.create(tolu, { text: 'x'.repeat(501) })).toThrow(/under 500/);
    expect(() => posts.create(tolu, { text: 'Rice', priceNaira: 12.5 })).toThrow(/whole naira/);
    expect(() => posts.create(tolu, { text: 'Rice', photo: { mediaType: 'image/jpeg', data: Buffer.from('<svg/>').toString('base64') } })).toThrow(/JPEG, PNG or WebP/);
    expect(posts.create(tolu, { text: 'Rice, no price' })).toMatchObject({ priceNaira: null, unit: null, hasPhoto: false });
  });

  it('a store that stops being live drops off the feed and its store page; only the owner can delete a post', async () => {
    const { posts, tolu, ada, store, goLive, tick } = await setup();
    goLive();
    const p = posts.create(tolu, { text: 'Groundnut oil, 25 litres' });
    expect(() => posts.remove(ada, p.id)).toThrow(/No such post/);
    tick(31 * DAY);                                                                        // the month ran out
    expect(posts.feed(ada)).toEqual([]);
    expect(() => posts.store(ada, store.sellerId)).toThrow(/not on StockRun/);
    expect(posts.store(tolu, store.sellerId).posts).toHaveLength(1);                       // the owner still sees it
    expect(posts.photo(p.id)).toBeNull();
    posts.remove(tolu, p.id);
    expect(posts.store(tolu, store.sellerId).posts).toHaveLength(0);
  });

  it('a buyer who saw a post can message the store, and the owner sees the conversation', async () => {
    const { db, listings, posts, tolu, ada, store, goLive } = await setup();
    goLive();
    posts.create(tolu, { text: 'Rice 50kg bags' });
    const chats = new Chats({ db, listings });
    const c = chats.open(ada, posts.feed(ada)[0].store.sellerId);
    chats.send(ada, c.id, 'How much for 5 bags?');
    expect(chats.list(tolu)).toMatchObject([{ role: 'shop', store: { sellerId: store.sellerId }, unread: 1, last: { text: 'How much for 5 bags?', from: 'buyer' } }]);
  });
});
