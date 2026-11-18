// Packs circuit inputs into the bit vector sent to eval(), and unpacks outputs.
//
// TODO (blocking, day 1): confirm TapeOut's convention for how `bytes` map onto input wires
// (MSB-first vs LSB-first, byte order) and how outputs are returned. This file currently uses
// MSB-first, fields in the order listed in docs/CIRCUITS.md, zero-padded to whole bytes.
// StockRunVault._pack* must use the SAME convention.

import type { RestockInput, PickupInput, DeliveryInput } from './circuits';

type Field = [value: number, width: number];

export function packFields(fields: Field[]): Uint8Array {
  const bits: number[] = [];
  for (const [value, width] of fields) {
    if (value < 0 || value >= 2 ** width) throw new RangeError(`value ${value} does not fit in ${width} bits`);
    for (let b = width - 1; b >= 0; b--) bits.push((value >> b) & 1);
  }
  while (bits.length % 8) bits.push(0);
  const out = new Uint8Array(bits.length / 8);
  bits.forEach((v, i) => { if (v) out[i >> 3] |= 0x80 >> (i & 7); });
  return out;
}

export function unpackFields(bytes: Uint8Array, widths: number[]): number[] {
  let pos = 0;
  return widths.map((w) => {
    let v = 0;
    for (let k = 0; k < w; k++, pos++) v = (v << 1) | ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1);
    return v;
  });
}

const b = (x: boolean) => (x ? 1 : 0);

export const packRestock = (i: RestockInput) =>
  packFields([[i.total, 8], [i.budget, 8], [i.limit, 8], [i.sup, 2], [i.cat, 3], [i.dist, 2], [b(i.ownerOk), 1], [0, 2]]);

export const packPickup = (i: PickupInput) =>
  packFields([[b(i.atSupplier), 1], [i.ordered, 8], [i.aiCount, 8], [i.riderCount, 8], [b(i.damage), 1], [b(i.bonded), 1]]);

export const packDelivery = (i: DeliveryInput) =>
  packFields([[b(i.atShop), 1], [i.picked, 8], [i.delivered, 8], [b(i.damage), 1], [b(i.ownerOk), 1], [b(i.ownerIssue), 1], [b(i.timeout), 1]]);

// Output layouts: RestockGuard [decision 2, reason 3]; Pickup [decision 2, payQty 8, reason 3]; Delivery [decision 2, shortQty 8, reason 3]
export const RESTOCK_OUT = [2, 3];
export const PICKUP_OUT = [2, 8, 3];
export const DELIVERY_OUT = [2, 8, 3];
