# Build plan

Full plan (living doc): https://claude.ai/artifact/Eg2nTvmL9rk9ATxjSAcbcW

## Schedule (2026)
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

**Cut order if late:** voice input, then the AI phone-call fallback, then REF reuse (tape out flat circuits instead). Never cut the pilot.

## Demo video (≤ 3 min)
| Time | Scene |
| --- | --- |
| 0:00–0:20 | Problem: half a day at Mile 12; short supply after paying up front |
| 0:20–0:45 | Order → map → RestockGuard approves → funds lock |
| 0:45–1:15 | WhatsApp negotiation (1 real supplier) → rider booked |
| 1:15–1:45 | Pickup photo → AI count → PickupCheck pays 18 of 20 → naira alert |
| 1:45–2:10 | Delivery → DeliveryCheck pays rider; blocked over-budget attempt with reason code |
| 2:10–2:35 | Under the hood: processor, circuit IDs, eval() on explorer, DeWEB |
| 2:35–3:00 | Users, fee model, pilot feedback |

## Submission checklist
- [x] Processor address + circuit IDs (3 circuits, flat: no shared REF circuits; see README)
- [ ] Vault address
- [ ] DeWEB app link
- [ ] Description: product, users + how to reach them, revenue, why they pay and stay
- [x] TapeOut features used (README)
- [x] Public GitHub repo
- [ ] Demo video ≤ 3 min
- [ ] Form: https://forms.gle/EoDNbxQ65dev1wFd9 — by Dec 6
