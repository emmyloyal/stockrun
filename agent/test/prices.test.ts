import { describe, it, expect } from 'vitest';
import { PriceBook, catalogueReference, median, ageText, WINDOW_MS } from '../src/prices/priceBook.ts';
import { normalisePriceList, ruleParsePriceList, updatePriceList } from '../src/prices/priceList.ts';
import { negotiate, isDeal, messages, assertSafeMessage, ceilingFor, type PriceEvent } from '../src/tools/negotiate.ts';
import { RuleExtractor } from '../src/rules.ts';
import { BotChannel } from '../src/sim/bots.ts';
import { loadSuppliers } from '../src/tools/suppliers.ts';
import type { OrderLine } from '../src/types.ts';

const INDOMIE = 'Indomie noodles carton (40 x 70g)';
const RICE = 'Rice 50kg bag';
const DAY = 24 * 3600 * 1000;
const NOW = 1_800_000_000_000;
const book = () => new PriceBook({ now: () => NOW });
const line = (over: Partial<OrderLine> = {}): OrderLine => ({ item: INDOMIE, quantity: 5, unit: 'carton', category: 'staples', maxUnitPriceNaira: null, ...over });
const sup = (id: string) => loadSuppliers().find((s) => s.id === id)!;

describe('price book', () => {
  it('uses the catalogue until 3 suppliers have prices, then the median of their latest prices', () => {
    const b = book();
    const cat = catalogueReference(INDOMIE)!;
    expect(b.reference(INDOMIE)).toEqual({ priceNaira: cat, basis: 'catalogue', suppliers: 0 });
    b.record({ supplierId: 'a', item: INDOMIE, unitPriceNaira: 14_000, source: 'deal' });
    b.record({ supplierId: 'b', item: INDOMIE, unitPriceNaira: 14_400, source: 'price_list' });
    expect(b.reference(INDOMIE)?.basis).toBe('catalogue');
    b.record({ supplierId: 'c', item: INDOMIE, unitPriceNaira: 14_200, source: 'quote' });
    expect(b.reference(INDOMIE)).toEqual({ priceNaira: 14_200, basis: 'market', suppliers: 3 });
  });

  it('one supplier inflating their price cannot raise the reference (or the walk-away price)', () => {
    const b = book();
    for (const [id, p] of [['a', 14_000], ['b', 14_200], ['c', 14_400]] as const) b.record({ supplierId: id, item: INDOMIE, unitPriceNaira: p, source: 'deal' });
    const before = b.reference(INDOMIE)!.priceNaira;
    b.record({ supplierId: 'c', item: INDOMIE, unitPriceNaira: 40_000, source: 'price_list' });
    b.record({ supplierId: 'c', item: INDOMIE, unitPriceNaira: 45_000, source: 'price_list' });
    expect(b.reference(INDOMIE)!.priceNaira).toBe(before);
    expect(ceilingFor(line(), b.reference(INDOMIE)!.priceNaira)).toBe(14_900);
  });

  it('ignores prices older than 30 days and keeps only each supplier\'s latest', () => {
    const b = book();
    for (const id of ['a', 'b', 'c']) b.record({ supplierId: id, item: RICE, unitPriceNaira: 60_000, source: 'deal', at: NOW - WINDOW_MS - DAY });
    expect(b.reference(RICE)?.basis).toBe('catalogue');
    b.record({ supplierId: 'a', item: RICE, unitPriceNaira: 80_000, source: 'deal', at: NOW - 2 * DAY });
    b.record({ supplierId: 'a', item: RICE, unitPriceNaira: 81_000, source: 'quote', at: NOW - DAY });
    expect(b.latest('a', RICE)).toMatchObject({ unitPriceNaira: 81_000, source: 'quote' });
    expect(ageText(b.latest('a', RICE)!.at, NOW)).toBe('1 day ago');
  });

  it('refuses nonsense prices', () => {
    const b = book();
    b.record({ supplierId: 'a', item: INDOMIE, unitPriceNaira: -5, source: 'quote' });
    b.record({ supplierId: 'a', item: INDOMIE, unitPriceNaira: 13_500.5, source: 'quote' });
    expect(b.all()).toHaveLength(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3);
  });
});

describe('price lists from suppliers', () => {
  it('reads a WhatsApp price list with the offline reader', () => {
    const r = normalisePriceList(ruleParsePriceList('Indomie 13,500\nRice 50kg 82k\nPeak milk tin 9,800\nSugar 50kg bag ₦135'));
    expect(r.accepted).toEqual([{ item: INDOMIE, unitPriceNaira: 13_500 }, { item: RICE, unitPriceNaira: 82_000 }]);
    expect(r.unknown).toEqual(['Peak milk tin']);
    expect(r.check).toEqual([{ item: 'Sugar 50kg bag', unitPriceNaira: 135 }]); // typo for 135,000? sent back to check
  });

  it('records accepted prices against the supplier and replies safely', async () => {
    const b = book();
    const s = sup('sim-mile12-adeyemi');
    const r = await updatePriceList(s, 'Indomie 13,700, Rice 81,000', new RuleExtractor(), b);
    expect(r?.accepted).toHaveLength(2);
    expect(b.latest(s.id, INDOMIE)).toMatchObject({ unitPriceNaira: 13_700, source: 'price_list' });
    const reply = messages.priceListReply(2, ['Sugar 50kg bag ₦135'], ['Peak milk tin']);
    expect(reply).toMatch(/saved 2 prices.*check these.*do not stock/);
    expect(() => assertSafeMessage(reply)).not.toThrow();
    expect(() => assertSafeMessage(messages.askPriceList(s))).not.toThrow();
  });
});

describe('negotiation feeds the price book', () => {
  it('reports every quote and the final deal', async () => {
    const events: PriceEvent[] = [];
    const r = await negotiate(sup('sim-mile12-adeyemi'), line(), 13_500, new BotChannel(), new RuleExtractor(), { onPrice: (e) => events.push(e) });
    expect(isDeal(r)).toBe(true);
    expect(events.at(0)).toEqual({ kind: 'quote', unitPriceNaira: 14_000 });
    expect(events.at(-1)).toEqual({ kind: 'deal', unitPriceNaira: isDeal(r) ? r.unitPriceNaira : -1 });
  });
});
