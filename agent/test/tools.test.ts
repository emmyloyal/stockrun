import { describe, it, expect } from 'vitest';
import { parseOrder, normalise } from '../src/tools/parseOrder.ts';
import { RuleExtractor, ruleParseReply } from '../src/rules.ts';
import { negotiate, isDeal, messages, assertSafeMessage, ceilingFor } from '../src/tools/negotiate.ts';
import { searchSuppliers, loadSuppliers, haversineKm, catalog } from '../src/tools/suppliers.ts';
import { riderFeeNaira } from '../src/tools/riders.ts';
import { BotChannel } from '../src/sim/bots.ts';
import { distBucket, type OrderLine } from '../src/types.ts';

const rules = new RuleExtractor();
const OJOTA = { name: 'Demo shop, Ojota', lat: 6.587, lng: 3.381 };
const sup = (id: string) => loadSuppliers().find((s) => s.id === id)!;
const INDOMIE = 'Indomie noodles carton (40 x 70g)';
const line = (over: Partial<OrderLine> = {}): OrderLine => ({ item: INDOMIE, quantity: 5, unit: 'carton', category: 'staples', maxUnitPriceNaira: null, ...over });

describe('parse_order (rule reader)', () => {
  it('reads quantities, items, prices and radius', async () => {
    const { order, problems } = await parseOrder('20 cartons of Indomie, 10 bags of rice at 80k, within 5 km', rules);
    expect(problems).toEqual([]);
    expect(order.radiusKm).toBe(5);
    expect(order.lines).toEqual([
      { item: INDOMIE, quantity: 20, unit: 'carton', category: 'staples', maxUnitPriceNaira: null },
      { item: 'Rice 50kg bag', quantity: 10, unit: 'bag', category: 'staples', maxUnitPriceNaira: 80000 },
    ]);
  });
  it('maps beer to the restricted category (always asks the owner)', async () => {
    const { order } = await parseOrder('5 crates of beer', rules);
    expect(order.lines[0].category).toBe('restricted');
  });
  it('code enforces limits whatever the model returns', () => {
    const r = normalise({ lines: [
      { item: 'x', quantity: 0, unit: 'bag', category: 'staples', maxUnitPriceNaira: null },
      { item: 'y', quantity: 300, unit: 'bag', category: 'staples', maxUnitPriceNaira: -5 },
      { item: 'z', quantity: 3, unit: '', category: 'drinks', maxUnitPriceNaira: -5 },
    ], radiusKm: 900, notes: '' });
    expect(r.order.lines).toEqual([{ item: 'z', quantity: 3, unit: 'unit', category: 'drinks', maxUnitPriceNaira: null }]);
    expect(r.problems).toHaveLength(2);
    expect(r.order.radiusKm).toBe(5);
  });
  it('the catalogue covers every supplier item', () => expect(catalog().length).toBeGreaterThan(10));
});

describe('reading supplier replies (rule reader)', () => {
  it.each([
    ['Na ₦14,000 per one. Pickup after 2pm.', { unitPriceNaira: 14000, acceptsOurOffer: false, pickupWindow: '2pm', available: true }],
    ['Ok deal, ₦13,300. Come pick after 2pm.', { unitPriceNaira: 13300, acceptsOurOffer: true }],
    ['Abeg add small. 13.6k', { unitPriceNaira: 13600, acceptsOurOffer: false }],
    ['Sorry, we no get that one now.', { available: false }],
    ['We only have 3 cartons left.', { quantityAvailable: 3 }],
  ])('%s', (text, want) => expect(ruleParseReply(text)).toMatchObject(want));
});

describe('supplier messages never promise payment before the pickup check', () => {
  it('all templates pass the guard', () => {
    const s = sup('sim-mile12-adeyemi');
    for (const m of [messages.request(s, line()), messages.counter(line(), 13000), messages.confirm(line(), 13000), messages.decline()]) expect(() => assertSafeMessage(m)).not.toThrow();
  });
  it.each(['I will pay you now', 'Send account for deposit', 'We pay upfront', 'We will pay tomorrow'])('blocks: %s', (m) => expect(() => assertSafeMessage(m)).toThrow());
});

describe('negotiation with supplier bots', () => {
  it('gets a price under the opening ask, within the ceiling', async () => {
    const bots = new BotChannel();
    const r = await negotiate(sup('sim-mile12-adeyemi'), line(), 13500, bots, rules);
    expect(isDeal(r)).toBe(true);
    if (!isDeal(r)) return;
    expect(r.unitPriceNaira).toBe(13300);                 // opened at 14,000; countered 13,300; accepted
    expect(r.unitPriceNaira).toBeLessThanOrEqual(ceilingFor(line(), 13500));
    expect(bots.log.every((m) => !/deposit|upfront/i.test(m.text))).toBe(true);
  });
  it('never exceeds the owner maximum: walks away instead', async () => {
    const bots = new BotChannel({ 'sim-mile12-adeyemi': { floorDiscount: 1.0, openingMarkup: 1.1 } }); // floor 13,500
    const r = await negotiate(sup('sim-mile12-adeyemi'), line({ maxUnitPriceNaira: 12000 }), 13500, bots, rules);
    expect(isDeal(r)).toBe(false);
    if (!isDeal(r)) expect(r.reason).toBe('too_expensive');
  });
  it('meets in the middle when the supplier pushes back', async () => {
    const bots = new BotChannel({ 'sim-ketu-chukwu': { floorDiscount: 0.99 } }); // floor 79,700
    const r = await negotiate(sup('sim-ketu-chukwu'), line({ item: 'Rice 50kg bag', unit: 'bag', maxUnitPriceNaira: 82000 }), 80500, bots, rules);
    expect(isDeal(r)).toBe(true);
    if (isDeal(r)) { expect(r.unitPriceNaira).toBeGreaterThanOrEqual(79700); expect(r.unitPriceNaira).toBeLessThanOrEqual(82000); }
  });
  it('handles no reply and no stock', async () => {
    const silent = await negotiate(sup('sim-mile12-adeyemi'), line(), 13500, new BotChannel({ 'sim-mile12-adeyemi': { replyDelayMs: -1 } }), rules);
    expect(!isDeal(silent) && silent.reason).toBe('no_reply');
    const short = await negotiate(sup('sim-mile12-adeyemi'), line({ quantity: 50 }), 13500, new BotChannel({ 'sim-mile12-adeyemi': { stock: 10 } }), rules);
    expect(!isDeal(short) && short.reason).toBe('unavailable');
  });
});

describe('search_suppliers', () => {
  it('ranks preferred > approved > unknown, drops blocked and far suppliers', () => {
    const status = (id: string) => (({ 'sim-mile12-adeyemi': 1, 'sim-mile12-blessing': 2, 'sim-oyingbo-folake': 3 } as Record<string, 0 | 1 | 2 | 3>)[id] ?? 0);
    const r = searchSuppliers(INDOMIE, OJOTA, 5, status);
    expect(r.map((c) => c.supplier.id)).toEqual(['sim-mile12-blessing', 'sim-mile12-adeyemi']);
    expect(searchSuppliers(INDOMIE, OJOTA, 50, status).map((c) => c.supplier.id)).not.toContain('sim-oyingbo-folake');
  });
  it('computes distances and circuit buckets', () => {
    expect(haversineKm(OJOTA, sup('sim-mile12-adeyemi'))).toBeCloseTo(2.98, 1);
    expect([1.9, 2, 4.99, 5, 9.9, 10, 30].map(distBucket)).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });
  it('rider fee: ₦1,500 + ₦250/km, rounded up to ₦100', () => expect([0, 2.6, 10].map(riderFeeNaira)).toEqual([1500, 2200, 4000]));
});
