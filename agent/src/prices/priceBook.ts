// Price book: every price a supplier quotes, agrees or sends in a price list, with the date.
// It answers two questions:
//   latest(supplier, item)  what this supplier last asked (shown to the owner with its age)
//   reference(item)         what the agent may base its walk-away price on
// The reference is never one supplier's own number: it is the median of the latest price from each supplier over the
// last 30 days, and only once at least 3 suppliers have a price. Until then it is StockRun's catalogue price, which
// suppliers cannot edit. So one supplier raising their price cannot raise what the agent will agree to pay.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadSuppliers } from '../tools/suppliers.ts';

export type PriceSource = 'deal' | 'quote' | 'price_list';
export interface PriceEntry { supplierId: string; item: string; unitPriceNaira: number; source: PriceSource; at: number }
export interface Reference { priceNaira: number; basis: 'market' | 'catalogue'; suppliers: number }

export const WINDOW_MS = 30 * 24 * 3600 * 1000;
export const MIN_SUPPLIERS = 3;

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** StockRun's own reference for an item: median list price in the curated catalogue (data/suppliers.json). */
export function catalogueReference(item: string): number | null {
  const prices = loadSuppliers().flatMap((s) => s.stocks.filter((st) => st.item === item).map((st) => st.listPriceNaira));
  return prices.length ? median(prices) : null;
}

export class PriceBook {
  private entries: PriceEntry[] = [];
  private file: string | null;
  private now: () => number;
  constructor(opts: { file?: string | null; now?: () => number } = {}) {
    this.file = opts.file ?? null;
    this.now = opts.now ?? Date.now;
    if (this.file && existsSync(this.file)) this.entries = JSON.parse(readFileSync(this.file, 'utf8')) as PriceEntry[];
  }

  record(e: Omit<PriceEntry, 'at'> & { at?: number }): void {
    if (!Number.isInteger(e.unitPriceNaira) || e.unitPriceNaira <= 0) return;
    this.entries.push({ ...e, at: e.at ?? this.now() });
    if (this.file) writeFileSync(this.file, JSON.stringify(this.entries, null, 2));
  }

  latest(supplierId: string, item: string): PriceEntry | undefined {
    let best: PriceEntry | undefined;
    for (const e of this.entries) if (e.supplierId === supplierId && e.item === item && (!best || e.at >= best.at)) best = e;
    return best;
  }

  reference(item: string): Reference | null {
    const cutoff = this.now() - WINDOW_MS;
    const perSupplier = new Map<string, PriceEntry>();
    for (const e of this.entries) {
      if (e.item !== item || e.at < cutoff) continue;
      const cur = perSupplier.get(e.supplierId);
      if (!cur || e.at >= cur.at) perSupplier.set(e.supplierId, e);
    }
    if (perSupplier.size >= MIN_SUPPLIERS)
      return { priceNaira: median([...perSupplier.values()].map((e) => e.unitPriceNaira)), basis: 'market', suppliers: perSupplier.size };
    const cat = catalogueReference(item);
    return cat === null ? null : { priceNaira: cat, basis: 'catalogue', suppliers: perSupplier.size };
  }

  all(): readonly PriceEntry[] { return this.entries; }
}

/** "₦13,500, 3 days ago" style age for the owner's screen and messages. */
export function ageText(at: number, now = Date.now()): string {
  const h = Math.floor((now - at) / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
