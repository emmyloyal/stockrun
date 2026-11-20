// Shared domain types and the encodings the circuits expect (docs/CIRCUITS.md).

/** Category code for RestockGuard: 0-5 everyday stock (auto-approvable), 6-7 always ask the owner. */
export const CATEGORIES = {
  staples: 0,      // rice, noodles, flour, beans, garri, pasta
  drinks: 1,       // water, soft drinks, juice, malt
  cooking: 2,      // oil, tomato paste, seasoning, sugar, salt
  toiletries: 3,   // soap, detergent, toothpaste, tissue
  snacks: 4,       // biscuits, sweets, crisps
  household: 5,    // matches, candles, batteries, nylon bags
  restricted: 6,   // alcohol, cigarettes: owner decides
  highValue: 7,    // phones, electronics, anything unusual
} as const;
export type Category = keyof typeof CATEGORIES;

/** Distance bucket for RestockGuard: 00 <2 km, 01 2-5 km, 10 5-10 km, 11 >10 km (always ask the owner). */
export function distBucket(km: number): 0 | 1 | 2 | 3 {
  if (km < 2) return 0;
  if (km < 5) return 1;
  if (km < 10) return 2;
  return 3;
}

/** Supplier status in the vault registry: 0 unknown, 1 approved, 2 preferred, 3 blocked. */
export type SupplierStatus = 0 | 1 | 2 | 3;

export interface OrderLine {
  item: string;            // normalised product name, e.g. "Indomie noodles 40x70g"
  quantity: number;        // order units (cartons, bags), 1..255
  unit: string;            // "carton", "bag", ...
  category: Category;
  maxUnitPriceNaira: number | null; // owner's ceiling per unit, if given
}

export interface ParsedOrder {
  lines: OrderLine[];
  radiusKm: number;        // search radius (default 5)
  notes: string;
}

export interface Supplier {
  id: string;              // stable id; the vault key is keccak256(id)
  name: string;
  market: string;
  lat: number;
  lng: number;
  whatsapp: string;        // E.164; simulated suppliers use reserved test numbers
  simulated: boolean;      // true for demo bots: never presented as real businesses
  stocks: { item: string; category: Category; listPriceNaira: number }[];
}

export interface Rider {
  id: string;
  name: string;
  address: `0x${string}`;  // the handler's on-chain key: a logistics company the shop approved (no bond)
  lat: number;
  lng: number;
}

export interface Shop {
  name: string;
  lat: number;
  lng: number;
}
