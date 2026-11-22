// search_suppliers: ranked suppliers near the shop that stock the item.
import { readFileSync } from 'node:fs';
import { keccak256, toBytes } from 'viem';
import { distBucket, type Category, type Shop, type Supplier, type SupplierStatus } from '../types.ts';

let cache: Supplier[] | null = null;
export function loadSuppliers(): Supplier[] {
  if (!cache) cache = (JSON.parse(readFileSync(new URL('../../data/suppliers.json', import.meta.url), 'utf8')) as { suppliers: Supplier[] }).suppliers;
  return cache;
}

// The demo sellers in data/suppliers.json are simulated bots. They are on for the local test chain only: on the live
// server (real naira) they are never shown, searched, negotiated with or treated as verified.
let demoOn = true;
export function useDemoSellers(on: boolean) { demoOn = on; }
/** The demo sellers a buyer may see or deal with: none when they are switched off. */
export const demoSellers = (): Supplier[] => (demoOn ? loadSuppliers() : []);

/** Every distinct product across suppliers (the catalogue the AI maps orders onto). */
export function catalog(): { item: string; category: Category }[] {
  const seen = new Map<string, Category>();
  for (const s of loadSuppliers()) for (const st of s.stocks) seen.set(st.item, st.category);
  return [...seen].map(([item, category]) => ({ item, category }));
}

/** The vault's supplier key. */
export const supplierKey = (id: string) => keccak256(toBytes(id));

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface Candidate {
  supplier: Supplier;
  status: SupplierStatus;
  km: number;
  dist: 0 | 1 | 2 | 3;
  listPriceNaira: number;
}

/**
 * Suppliers that stock `item` within `radiusKm`, best first. Blocked suppliers are dropped here,
 * and RestockGuard rejects them anyway. Unknown suppliers are kept but ranked last: the circuit
 * rejects them until the owner approves them, so the agent can suggest them to the owner.
 * Order: preferred > approved > unknown, then distance, then list price.
 */
export function searchSuppliers(item: string, shop: Shop, radiusKm: number, statusOf: (id: string) => SupplierStatus): Candidate[] {
  const rank = { 2: 0, 1: 1, 0: 2, 3: 9 } as const;
  return demoSellers()
    .flatMap((s) => {
      const stock = s.stocks.find((st) => st.item === item);
      if (!stock) return [];
      const km = haversineKm(shop, s);
      const status = statusOf(s.id);
      if (status === 3 || km > radiusKm) return [];
      return [{ supplier: s, status, km, dist: distBucket(km), listPriceNaira: stock.listPriceNaira }];
    })
    .sort((a, b) => rank[a.status] - rank[b.status] || a.km - b.km || a.listPriceNaira - b.listPriceNaira);
}
