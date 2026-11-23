# Build plan

Full plan (living doc): https://claude.ai/artifact/Eg2nTvmL9rk9ATxjSAcbcW

## Where it ended up (2026-11-23)
Submitted to the X Layer × TapeOut "Build X" hackathon. Live at https://stockrun-ai.duckdns.org (AWS), naira through
Paystack in live mode, the three circuits on X Layer mainnet. The original plan below changed along the way:
- **Riders and bonds were dropped.** The buyer collects (or a verified logistics company delivers); the seller is paid at
  pickup for what the buyer counted.
- **Buyers, not only shop owners.** Anyone signs in by email or wallet, adds money and asks for what they want.
- **Sellers come from OpenStreetMap and registered stores.** Buyers message them from their own WhatsApp; the haggling
  agent and bot suppliers stay on the local chain.
- **Money:** StockRun's 1.5% is paid on every deposit (naira and coins); stores pay ₦2,000 a month.
- **DeWEB:** built and rehearsed, not published; the app is served from the AWS server.
- **Still waiting:** Paystack's business upgrade (for withdrawals and automatic seller payouts) and a live Sendrelay key.

## Original schedule (2026)
| Dates | Workstream | Done when |
| --- | --- | --- |
| Nov 18–19 | Docs and truth tables | TapeOut docs read; bit order confirmed; reference model tests green |
| Nov 20–23 | Build and tape out circuits | Comparator + min circuits, RestockGuard, PickupCheck, DeliveryCheck taped out; eval matches reference on fork |
| Nov 23–26 | Vault contract and tests | Vault deployed; fork tests incl. attack tests pass |
| Nov 25–29 | AI agent and WhatsApp | Order parsing, supplier ranking, negotiation with 1 real supplier + 2 bots |
| Nov 28–Dec 1 | Logistics companies and self-pickup | Sendrelay booked from orders; its status updates drive pickup/delivery; self-pickup confirm; no bonds |
| Nov 30–Dec 3 | Map, wiring, DeWEB | Full demo path end to end; app live on DeWEB |
| Dec 2–4 | Pilot with shop owners | 1–2 real owners try it; quotes and feedback captured |
| Dec 5–6 | Video and submission | 3-min video, description, form submitted |

## Submission checklist
- [x] Processor address + circuit IDs (3 circuits, flat: no shared REF circuits; see README)
- [x] Live app link (https://stockrun-ai.duckdns.org; DeWEB not used)
- [x] Description: product, users + how to reach them, revenue, why they pay and stay
- [x] TapeOut features used (README)
- [x] Public GitHub repo
- [x] Form submitted
- [ ] Demo video link in the README (still "coming soon")
- [ ] Pilot with real shop owners
