// Price lists sent by suppliers on WhatsApp, e.g. "Indomie 13,500 / Rice 50kg 82k / Peak milk 9,800".
// The AI maps each line onto the catalogue; code keeps only catalogue items with believable prices and records them.
// Prices far from StockRun's catalogue reference (likely typos such as "135" for "13,500") are sent back to check.
import { z } from 'zod';
import type { Extractor } from '../llm.ts';
import { catalog } from '../tools/suppliers.ts';
import { ALIASES, naira } from '../tools/parseOrder.ts';
import type { Supplier } from '../types.ts';
import { catalogueReference, type PriceBook } from './priceBook.ts';

export const PriceListSchema = z.object({
  items: z.array(z.object({
    item: z.string().describe('Exact catalogue name if the product matches the catalogue, otherwise the product as written'),
    unitPriceNaira: z.number().describe('Price per unit in naira'),
  })),
});
export type PriceList = z.infer<typeof PriceListSchema>;

const instructions = () => `You read price lists that Lagos wholesalers send on WhatsApp (English or Nigerian Pidgin).
Report each product and its price per unit in naira. Map products to this catalogue when they match (use the exact name):
${catalog().map((c) => `- ${c.item}`).join('\n')}
"13.5k" = 13500, "82k" = 82000, "13,500" = 13500. Only report prices the message actually states.`;

/** Accepted prices are within this factor of the catalogue reference; anything else is sent back to check. */
export const SANITY_FACTOR = 3;

export interface PriceListResult {
  accepted: { item: string; unitPriceNaira: number }[];
  check: { item: string; unitPriceNaira: number }[];   // believable item, unbelievable price
  unknown: string[];                                    // not in the catalogue
}

export function normalisePriceList(raw: PriceList): PriceListResult {
  const known = new Set(catalog().map((c) => c.item));
  const r: PriceListResult = { accepted: [], check: [], unknown: [] };
  for (const { item, unitPriceNaira } of raw.items) {
    const name = item.trim();
    if (!known.has(name)) { r.unknown.push(name); continue; }
    const price = Math.round(unitPriceNaira), ref = catalogueReference(name)!;
    if (!Number.isFinite(price) || price <= 0 || price > ref * SANITY_FACTOR || price < ref / SANITY_FACTOR) r.check.push({ item: name, unitPriceNaira: price });
    else r.accepted.push({ item: name, unitPriceNaira: price });
  }
  return r;
}

/** Read a supplier's price-list message and record the accepted prices. Returns what happened, for the reply. */
export async function updatePriceList(supplier: Supplier, text: string, ex: Extractor, book: PriceBook): Promise<PriceListResult | null> {
  const raw = await ex.extract(PriceListSchema, instructions(), text);
  if (!raw) return null;
  const r = normalisePriceList(raw);
  for (const a of r.accepted) book.record({ supplierId: supplier.id, item: a.item, unitPriceNaira: a.unitPriceNaira, source: 'price_list' });
  return r;
}

/** Offline reader: one product per line or comma, price is the last amount on it. */
export function ruleParsePriceList(text: string): PriceList {
  const items: PriceList['items'] = [];
  for (const part of text.split(/\n|,(?!\d{3})|;|\//)) {
    const amounts = [...part.matchAll(/₦?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?k|\d+)/gi)].map((m) => m[1]);
    if (!amounts.length) continue;
    const price = naira(amounts[amounts.length - 1]);
    if (price === null) continue;
    const alias = ALIASES.find(([re]) => re.test(part));
    items.push({ item: alias ? alias[1] : part.replace(/₦?\s?[\d,.]+k?/gi, '').trim(), unitPriceNaira: price });
  }
  return { items };
}
