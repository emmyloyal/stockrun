// book_rider: the nearest logistics company this shop's vault trusts. No bonds: the vault only accepts handlers the
// owner approved (or the owner, for self-pickup), and PickupCheck re-checks that before paying.
import type { Address } from 'viem';
import type { Rider, Shop, Supplier } from '../types.ts';
import { haversineKm } from './suppliers.ts';

/** Delivery fee in naira: ₦1,500 base + ₦250 per km from supplier to shop, rounded up to ₦100. */
export function riderFeeNaira(km: number): number {
  return Math.ceil((1500 + 250 * km) / 100) * 100;
}

export async function bookRider(
  pool: Rider[], supplier: Supplier, shop: Shop, trusted: (a: Address) => Promise<boolean>,
): Promise<{ rider: Rider; feeNaira: number } | null> {
  const byDistance = [...pool].sort((a, b) => haversineKm(a, supplier) - haversineKm(b, supplier));
  for (const rider of byDistance) {
    if (await trusted(rider.address)) return { rider, feeNaira: riderFeeNaira(haversineKm(supplier, shop)) };
  }
  return null;
}
