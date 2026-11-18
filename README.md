# StockRun

**StockRun finds it, buys it and delivers it. Nobody gets paid until the goods are checked, and every step is guarded by a circuit on X Layer.**

An AI restocking agent for small shops in Lagos, built on TapeOut and X Layer for the Build X hackathon.

## How it works
1. **Order:** the shop owner sends the order by text or voice.
2. **Approve and lock:** RestockGuard (a TapeOut circuit) approves it, and the money is locked in the vault.
3. **Find and negotiate:** the agent finds suppliers on the map and negotiates on WhatsApp.
4. **Pickup check:** the rider photographs the goods at the supplier's shop. PickupCheck approves, and the supplier is paid in naira.
5. **Delivery check:** the owner confirms receipt. DeliveryCheck pays the rider, or compensates the owner from the rider's bond.

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
| Processor | _TBD after creation_ |
| Circuit IDs | RestockGuard _TBD_ · PickupCheck _TBD_ · DeliveryCheck _TBD_ |
| Vault | _TBD_ |
| App (DeWEB) | _TBD_ |
