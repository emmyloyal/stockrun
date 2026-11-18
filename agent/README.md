# Agent

AI service that turns a shop owner's order into proposed, circuit-checked purchases. It holds the **agent key**, which can
only call `proposeOrder` on the vault. It can never move money, choose where money goes, approve its own orders or submit
pickup/delivery evidence (all enforced by the vault and tested in `contracts/test/VaultScenarios.sol`).

**Claude reads; code decides.** Claude (`claude-opus-5-5`, structured outputs, server-side refusal fallbacks) only reads text: the owner's order and supplier replies. Prices, counter-offers, the walk-away point, rider choice and every number sent to the vault are computed in code, and RestockGuard has the final word on-chain.

## Run
```
npm install
npm test            # 21 unit tests + 5 end-to-end tests on a local anvil chain (needs Foundry + `forge build` in contracts/)
npm run typecheck
npm run demo -- "5 cartons of Indomie, 10 bags of rice at 80k, within 5 km"
```
- **Reader:** the demo uses Claude when `ANTHROPIC_API_KEY` (or an `ant auth login` profile) is set. Otherwise it uses the rule-based reader.
- **Simulated parts:** the demo runs on a local anvil chain with MockCircuits and bot suppliers. Nothing touches a real network.

## Pipeline (`src/agent.ts`)
| Step | File | What it does |
| --- | --- | --- |
| parse_order | `src/tools/parseOrder.ts` | Claude maps free text (English/Pidgin) onto the product catalogue. Code validates the result: quantity 1–255, prices, radius. |
| search_suppliers | `src/tools/suppliers.ts` | Suppliers within the radius that stock the item, ranked preferred > approved > unknown, then by distance and price. Blocked suppliers are dropped. Unknown suppliers are only *suggested* to the owner. |
| negotiate | `src/tools/negotiate.ts` | Fixed-wording messages, so no message can ever promise payment before the pickup check (guard + tests). Claude reads each reply. Code counters: first 5% under the ask, then halfway, and never above the ceiling (the owner's max, or list price + 5%). |
| book_rider | `src/tools/riders.ts` | Nearest rider whose vault bond covers the goods. Fee: ₦1,500 + ₦250/km. |
| propose_order | `src/tools/vault.ts` | Simulates first, so a REJECT costs no gas. Then it sends the transaction and reads `OrderProposed`. Results: locked / ask owner / rejected (with reason) / too large / circuit failed. |
| report | `ownerMessage` in `src/agent.ts` | WhatsApp summary for the owner. Every on-chain claim carries the tx hash. |

## Category codes sent to RestockGuard (`src/types.ts`)
| Codes | Categories |
| --- | --- |
| 0–5 (everyday, auto-approvable) | staples, drinks, cooking, toiletries, snacks, household |
| 6 (always asks the owner) | restricted (alcohol, tobacco) |
| 7 (always asks the owner) | highValue |

## Data
`data/suppliers.json` holds **fictional** demo suppliers (`simulated: true`, invented names, placeholder phone numbers, demo prices) located at public Lagos markets. Add real suppliers only with their consent, as `simulated: false`.

## Not built yet (say so in the demo)
- **WhatsApp Cloud API channel:** sending the template, plus the webhook that receives replies. `SupplierChannel` is the interface to implement. Today only `BotChannel` (simulated suppliers) exists.
- **Owner replies:** handling "YES <id>" as `approveOrder` is not built. The owner must sign that with the owner key; the agent key cannot do it.
- **Photo check service:** the separate key that calls `attestPickup` / `attestDelivery`.
- **Fallbacks and inputs:** voice-call fallback, voice-note transcription, and OpenStreetMap search beyond `suppliers.json`.
- **Multi-line orders:** they are proposed line by line, one vault order per line. Lines with no deal are reported, not retried.
