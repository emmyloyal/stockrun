// book_rider: nearest rider whose bond covers the goods. In the demo the pool is simulated;
// bonds are read from the vault, so an unbonded rider is never booked (PickupCheck would hold anyway).
import type { Address } from 'viem';
import type { Rider, Shop, Supplier } from '../types.ts';
import { haversineKm } from './suppliers.ts';

/** Delivery fee in naira: ₦1,500 base + ₦250 per km from supplier to shop, rounded up to ₦100. */
export function riderFeeNaira(km: number): number {
  return Math.ceil((1500 + 250 * km) / 100) * 100;
}

export async function bookRider(
  pool: Rider[], supplier: Supplier, shop: Shop, goodsValue: bigint, bondOf: (a: Address) => Promise<bigint>,
): Promise<{ rider: Rider; feeNaira: number } | null> {
  const byDistance = [...pool].sort((a, b) => haversineKm(a, supplier) - haversineKm(b, supplier));
  for (const rider of byDistance) {
    if ((await bondOf(rider.address)) >= goodsValue) return { rider, feeNaira: riderFeeNaira(haversineKm(supplier, shop)) };
  }
  return null;
}
