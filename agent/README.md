# Agent (to build Nov 25–29)

AI service that turns an order into a proposed, circuit-checked purchase. It holds the **agent key**, which can only
call `proposeOrder` on the vault. It can never move money.

## Tools the agent needs
- `parse_order(text|audio)` → items, quantities, max unit price, category
- `search_suppliers(items, location, radius)` → ranked suppliers from `data/suppliers.json` (+ OSM)
- `message_supplier(supplier, template|text)` → WhatsApp Cloud API (see docs/WHATSAPP.md); voice-call fallback
- `book_rider(pickup, dropoff, window)` → bonded rider from the rider pool (simulated in the demo)
- `propose_order(...)` → vault `proposeOrder`; reports the circuit's decision + reason code back to the owner

## Photo check service (separate key)
- Counts units and flags damage in pickup/delivery photos; calls `attestPickup` / `attestDelivery`.

## Suggested layout
```
agent/
  src/index.ts        # HTTP + webhook server (WhatsApp webhooks)
  src/tools/*.ts      # one file per tool above
  src/check/*.ts      # photo check service
  data/suppliers.json # seeded Lagos wholesalers: id, name, market, lat, lng, whatsapp, categories
```
