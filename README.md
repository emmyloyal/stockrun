# StockRun

**StockRun finds it, buys it and delivers it. Nobody gets paid until the goods are checked, and every step is guarded by a circuit on X Layer.**

An AI restocking agent for small shops in Lagos, built on TapeOut and X Layer for the Build X hackathon.

## How it works
1. **Order:** the shop owner sends the order by text or voice.
2. **Approve and lock:** RestockGuard (a TapeOut circuit) approves it, and the money is locked in the vault.
3. **Find and negotiate:** the agent finds suppliers on the map and negotiates on WhatsApp.
4. **Pickup check:** the owner chooses who collects: themselves, or a verified logistics company (Sendrelay first). That handler checks the goods at the supplier, and PickupCheck pays the supplier for the count it confirms, in naira.
5. **Delivery check** (logistics company only): the owner confirms receipt and gives the rider the delivery code. DeliveryCheck pays the company's fee, or holds it back for the owner if goods arrive short; the shortfall is claimed from the company's insurance. There are no rider bonds.

## TapeOut ecosystem used
- **Processor Factory, NAND transistors, tapeout, `eval()`, REF:** three decision circuits plus shared comparator circuits.
- **DeWEB:** hosts the app.
- **TapeSend:** encrypted receipts between owner, rider and StockRun.
- **TapeCode:** frontend scaffolding, security audit, DeWEB deployment.

## Repo
See `CLAUDE.md` for the layout and the design rules, and `docs/PLAN.md` for the schedule.

## Website (`site/`)
`site/index.html` is the public landing page. It is one static file with no build step. It includes a working RestockGuard demo, which runs a JavaScript copy of the reference model.
- **Deploy on Vercel:** import the repo, set **Root Directory** to `site`, set **Framework Preset** to *Other*, and leave the build command empty. Alternatively, run `npx vercel site` from the repo root.
- **Keep it honest:** the page's "Where we are" section lists what is built, what is simulated and what is not built yet. Update it, and the gate counts, whenever those change.

## Status
| Item | Value |
| --- | --- |
| Processor (X Layer) | [`0x34efCc0a3191A48Feec787252E6d817b063A4017`](https://www.oklink.com/xlayer/address/0x34efCc0a3191A48Feec787252E6d817b063A4017), taped out 2026-11-19 (see `deployments/xlayer.json`) |
| Circuit IDs | RestockGuard #1 (119 NAND) · PickupCheck #2 (210 NAND) · DeliveryCheck #3 (141 NAND) |
| Vault | _TBD_ |
| Server + app | https://stockrun.onrender.com (X Layer mainnet; Render, deployed 2026-11-20) |
| App (DeWEB) | `1.2.433.tape` at https://1-2-433.tapekit.org/ (publish script ready, rehearsed on a fork; not published yet) |
