// parse_order: owner's text -> order lines. The AI reads the text; code validates everything after.
import { z } from 'zod';
import type { Extractor } from '../llm.ts';
import { CATEGORIES, type Category, type OrderLine, type ParsedOrder } from '../types.ts';
import { catalog } from './suppliers.ts';

const CategoryEnum = z.enum(Object.keys(CATEGORIES) as [Category, ...Category[]]);

export const OrderSchema = z.object({
  lines: z.array(z.object({
    item: z.string().describe('Exact catalogue name if the product is in the catalogue, otherwise a short product name'),
    quantity: z.number().int().describe('Number of units (cartons, bags, crates, packs)'),
    unit: z.string(),
    category: CategoryEnum,
    maxUnitPriceNaira: z.number().nullable().describe('Highest price per unit the owner will pay, in naira, or null if not stated'),
  })),
  radiusKm: z.number().nullable().describe('Search radius in km if stated, else null'),
  notes: z.string().describe('Anything else the owner asked for (delivery time, brand), or empty'),
});

const instructions = () => `You read restocking orders sent by small shop owners in Lagos, Nigeria, by WhatsApp text or voice transcript.
Messages may mix English, Nigerian Pidgin and Yoruba, and use local units ("carton", "bag", "crate", "pack", "dozen").
Extract each product line. Map products to this catalogue when they match (use the exact name):
${catalog().map((c) => `- ${c.item} [${c.category}]`).join('\n')}
Category rules: staples, drinks, cooking, toiletries, snacks, household are everyday stock. Alcohol or tobacco is "restricted".
Phones, electronics or anything unusual or expensive is "highValue".
Amounts like "5k" mean 5,000 naira, "13.5k" means 13,500. A price "per carton"/"each" is maxUnitPriceNaira.
Only report what the message says. If a quantity is missing, skip that line and mention it in notes.`;

export interface ParseResult { order: ParsedOrder; problems: string[] }

/** "Cartons" -> "carton", so messages read "5 carton(s)" whatever form the reader returned. */
export function singular(unit: string): string {
  const u = unit.trim().toLowerCase();
  if (!u) return 'unit';
  if (/(ss|us)$/.test(u)) return u;
  return u.endsWith('ies') ? u.slice(0, -3) + 'y' : u.endsWith('es') && /(box|dozen)es$/.test(u) ? u.slice(0, -2) : u.replace(/s$/, '');
}

/** Validates and normalises whatever the extractor returned. Code, not the model, enforces limits. */
export function normalise(raw: z.infer<typeof OrderSchema>): ParseResult {
  const problems: string[] = [];
  const lines: OrderLine[] = [];
  for (const l of raw.lines) {
    if (!Number.isInteger(l.quantity) || l.quantity < 1) { problems.push(`"${l.item}": quantity missing or invalid`); continue; }
    if (l.quantity > 255) { problems.push(`"${l.item}": ${l.quantity} units is more than one order can hold (255); split it`); continue; }
    const max = l.maxUnitPriceNaira;
    lines.push({ item: l.item.trim(), quantity: l.quantity, unit: singular(l.unit), category: l.category,
      maxUnitPriceNaira: max !== null && Number.isFinite(max) && max > 0 ? Math.round(max) : null });
  }
  const r = raw.radiusKm;
  return { order: { lines, radiusKm: r !== null && r > 0 && r <= 50 ? r : 5, notes: raw.notes }, problems };
}

export async function parseOrder(text: string, ex: Extractor): Promise<ParseResult> {
  const raw = await ex.extract(OrderSchema, instructions(), text);
  if (!raw) return { order: { lines: [], radiusKm: 5, notes: '' }, problems: ['Could not read the order. Please send it again.'] };
  return normalise(raw);
}

// ---------------------------------------------------------------- offline fallback
// Rule-based reader for the demo without an API key: "20 cartons of Indomie, 10 bags of rice at 80k, within 5 km".
export const ALIASES: [RegExp, string][] = [
  [/indomie|noodle/i, 'Indomie noodles carton (40 x 70g)'],
  [/rice/i, 'Rice 50kg bag'],
  [/spaghetti|pasta/i, 'Spaghetti carton (20 x 500g)'],
  [/tomato/i, 'Tomato paste carton (50 x 70g)'],
  [/\boil\b/i, 'Vegetable oil 25L'],
  [/sugar/i, 'Sugar 50kg bag'],
  [/water/i, 'Bottled water pack (12 x 75cl)'],
  [/coke|fanta|soft ?drink|minerals?/i, 'Soft drink crate (24 x 35cl)'],
  [/beer|stout/i, 'Beer crate (12 x 60cl)'],
  [/detergent|omo|ariel/i, 'Detergent carton (12 x 900g)'],
  [/soap/i, 'Bar soap carton (36 pcs)'],
  [/biscuit/i, 'Biscuits carton (48 packs)'],
  [/candle/i, 'Candles carton (48 pcs)'],
];

const naira = (s: string) => { const m = s.replace(/[₦,\s]/g, '').match(/^(\d+(?:\.\d+)?)(k)?$/i); return m ? Math.round(parseFloat(m[1]) * (m[2] ? 1000 : 1)) : null; };

/** Rule-based order reader (offline fallback). */
export function ruleParseOrder(text: string): z.infer<typeof OrderSchema> {
  const lines: z.infer<typeof OrderSchema>['lines'] = [];
  for (const part of text.split(/,|\band\b|\n|;/i)) {
    const q = part.match(/(\d+)\s*(cartons?|bags?|crates?|packs?|pcs|pieces|tins?|dozens?)?/i);
    const alias = ALIASES.find(([re]) => re.test(part));
    if (!q || !alias) continue;
    const entry = catalog().find((c) => c.item === alias[1])!;
    const price = part.match(/(?:at|@|for|max|not more than)\s*(₦?\s*[\d,.]+k?)/i);
    lines.push({ item: entry.item, quantity: parseInt(q[1], 10), unit: (q[2] ?? 'unit').replace(/s$/i, '').toLowerCase(),
      category: entry.category, maxUnitPriceNaira: price ? naira(price[1]) : null });
  }
  const km = text.match(/(\d+(?:\.\d+)?)\s*km/i);
  return { lines, radiusKm: km ? parseFloat(km[1]) : null, notes: '' };
}

export { naira };
