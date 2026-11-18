# Circuit specification

The TypeScript reference model in `circuits/reference/` implements exactly this spec and is the source of truth.
Quantities are in order units (cartons, bags). Money is in units of ₦5,000. The vault fills every input.

Output encodings shared by all circuits: `decision` is 2 bits, `reason` is 3 bits.

---

## 1. RestockGuard — 34 inputs → 5 outputs
Decides whether an order may lock funds.

| Bits | Name | Meaning | Source |
| --- | --- | --- | --- |
| 8 | `total` | Order total (units of ₦5,000, 0–255) | Negotiated price saved to the order |
| 8 | `budget` | Remaining weekly budget | Vault storage |
| 8 | `limit` | Owner's auto-approve limit | Vault storage (owner-set, 24 h delay) |
| 2 | `sup` | 00 unknown, 01 approved, 10 preferred, 11 blocked | Supplier registry |
| 3 | `cat` | 0–5 everyday stock, 6–7 needs owner | Order |
| 2 | `dist` | 00 <2 km, 01 2–5 km, 10 5–10 km, 11 >10 km | Order (from map) |
| 1 | `ownerOk` | Owner approved this order | Owner signature |
| 2 | spare | Must be 0 | — |

Rules (first match wins):
1. `sup` ∈ {00, 11} → REJECT (00), reason 1
2. `total > budget` → REJECT, reason 2
3. `!ownerOk && total > limit` → ASK_OWNER (01), reason 3
4. `!ownerOk && cat >= 6` → ASK_OWNER, reason 4
5. `!ownerOk && dist == 11` → ASK_OWNER, reason 5
6. otherwise → APPROVE (10), reason 0

## 2. PickupCheck — 27 inputs → 13 outputs
Decides how much the supplier is paid at pickup.

| Bits | Name | Meaning |
| --- | --- | --- |
| 1 | `atSupplier` | Rider's signed GPS inside supplier geofence |
| 8 | `ordered` | Units ordered |
| 8 | `aiCount` | Units counted by AI in pickup photo (signed by check service) |
| 8 | `riderCount` | Units confirmed by rider |
| 1 | `damage` | AI flags visible damage |
| 1 | `bonded` | Rider bond ≥ order value (vault computes) |

Rules (first match wins):
1. `!atSupplier` → HOLD (00), reason 1
2. `!bonded` → HOLD, reason 2
3. `damage` → HOLD, reason 3
4. `payQty = min(aiCount, riderCount, ordered)`; `payQty == 0` → HOLD, reason 4
5. `payQty < ordered` → PAY_PART (01), reason 5; else PAY_FULL (10), reason 0

Outputs: `decision` (2), `payQty` (8; 0 when HOLD), `reason` (3).

## 3. DeliveryCheck — 21 inputs → 13 outputs
Pays the rider or compensates the owner from the bond.

| Bits | Name | Meaning |
| --- | --- | --- |
| 1 | `atShop` | Rider's signed GPS inside shop geofence |
| 8 | `picked` | `payQty` recorded at pickup |
| 8 | `delivered` | Units AI counts in delivery photo |
| 1 | `damage` | AI flags damage at delivery |
| 1 | `ownerOk` | Owner confirmed receipt |
| 1 | `ownerIssue` | Owner reported a problem |
| 1 | `timeout` | 24 h since arrival, owner silent |

Rules (first match wins):
1. `!atShop` → WAIT (00), reason 1
2. `damage` → HOLD (00), reason 3
3. `delivered < picked` → COMPENSATE (01), reason 4, `shortQty = picked − delivered`
4. `ownerIssue` → HOLD (00), reason 2
5. `ownerOk || timeout` → PAY_RIDER (10), reason 0
6. otherwise → WAIT (00), reason 5

Outputs: `decision` (2), `shortQty` (8; 0 unless COMPENSATE), `reason` (3).

## Shared sub-circuits
- `CMP8`: 8-bit a > b (and a < b) comparator.
- `MIN8`: 8-bit min(a, b).
- `SUB8`: 8-bit a − b (DeliveryCheck only; inputs guarantee a ≥ b when used).
Reuse via REF if the processor supports it; otherwise inline (flatten).

## Bit order
TapeOut (TAP-02 §5): vector bit i = bit (i mod 8) of byte floor(i/8), LSB-first. Input i is signal 2+i, and outputs are the last nOut signals.
StockRun convention: fields are laid out in the order listed in this file. Within a field, wire k = bit k of the value (LSB-first).
`circuits/reference/pack.ts`, `StockRunVault._pack/_unpack` and the netlists must all follow this. See docs/TAPEOUT_NOTES.md.
