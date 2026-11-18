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

## WhatsApp (`src/channels/`)
`WhatsAppChannel` is the real `SupplierChannel`. It sends text through the Cloud API, and `webhook.ts` receives replies.
- **Signed webhooks only:** the webhook rejects any request whose `X-Hub-Signature-256` does not match `WHATSAPP_APP_SECRET`, so nobody can inject fake supplier replies.
- **Retries:** duplicate deliveries from Meta are ignored.

### Live WhatsApp test (`npm run live`)
You play the supplier on your own phone. Only the negotiation runs: no vault, no chain, nothing is bought.
1. Fill these in `../.env`: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEST_RECIPIENT`, `WHATSAPP_VERIFY_TOKEN` (any random string) and `WHATSAPP_APP_SECRET`.
2. Open a tunnel: `cloudflared tunnel --url http://localhost:8787`, then copy the `https://….trycloudflare.com` address.
3. In the Meta app, go to WhatsApp → Configuration → Webhook and set:
   - **Callback URL:** `<tunnel>/webhook`
   - **Verify token:** the same value as `WHATSAPP_VERIFY_TOKEN`

   Then subscribe to the **messages** field. Keep `npm run live` running while you click Verify.
4. Send "hi" to the test number. The agent asks for a price; reply as a supplier would.
- **Tunnel address:** the quick-tunnel address changes every time cloudflared restarts, so update the callback URL each time.
- **24-hour window:** WhatsApp only delivers free-form text within 24 hours of the contact's last message. To start a conversation with a supplier who hasn't messaged first, you need an approved template (`order_request`), which is not registered yet.

## Not built yet (say so in the demo)
- **WhatsApp template and hosting:** the `order_request` template for first contact is not registered, and there is no hosted webhook yet. The agent and webhook run locally behind a tunnel.
- **Owner replies:** handling "YES <id>" as `approveOrder` is not built. The owner must sign that with the owner key; the agent key cannot do it.
- **Photo check service:** the separate key that calls `attestPickup` / `attestDelivery`.
- **Fallbacks and inputs:** voice-call fallback, voice-note transcription, and OpenStreetMap search beyond `suppliers.json`.
- **Multi-line orders:** they are proposed line by line, one vault order per line. Lines with no deal are reported, not retried.
