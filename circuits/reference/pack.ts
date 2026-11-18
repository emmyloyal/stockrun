// Packs circuit inputs into the bit vector sent to eval(), and unpacks outputs.
//
// TapeOut convention (TAP-02 §5): vector bit i is bit (i mod 8) of byte floor(i/8), so it is LSB-first.
// Input i is netlist signal 2+i, and outputs are the last nOut signals in index order.
// StockRun convention: fields are laid out in docs/CIRCUITS.md order, and field wire k = bit k of the value.
// The packed vector is therefore the little-endian integer sum(value_j << offset_j).
// StockRunVault._pack/_unpack and MockCircuits MUST use the same convention.

import type { RestockInput, PickupInput, DeliveryInput } from './circuits.ts';

type Field = [value: number, width: number];

export function packFields(fields: Field[]): Uint8Array {
  const total = fields.reduce((n, [, w]) => n + w, 0);
  const out = new Uint8Array(Math.ceil(total / 8));
  let pos = 0;
  for (const [value, width] of fields) {
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** width) throw new RangeError(`value ${value} does not fit in ${width} bits`);
    for (let k = 0; k < width; k++, pos++) if ((value >> k) & 1) out[pos >> 3] |= 1 << (pos & 7);
  }
  return out;
}

export function unpackFields(bytes: Uint8Array, widths: number[]): number[] {
  const total = widths.reduce((n, w) => n + w, 0);
  if (bytes.length * 8 < total) throw new RangeError(`need ${total} bits, got ${bytes.length * 8}`);
  let pos = 0;
  return widths.map((w) => {
    let v = 0;
    for (let k = 0; k < w; k++, pos++) v |= ((bytes[pos >> 3] >> (pos & 7)) & 1) << k;
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
