# StockRun

**Tell an AI what you want to buy. It finds real sellers near you, writes your WhatsApp message, and locks your
money until you have the goods. Every payment decision is made by a TapeOut circuit on X Layer.**

Built for the X Layer × TapeOut "Build X" hackathon. Live at **https://13-50-119-2.sslip.io** (X Layer mainnet;
naira through Paystack **test mode**, so no real money moves).

## How it works
1. **Sign in** with an email code or a wallet. **Deposit naira** with Paystack (test card in test mode).
2. **Ask:** type what you want, your budget and your area ("20 cartons of Indomie, ₦300,000, Ketu"). One word is
   enough for the area.
3. **Find sellers:** the AI decides what kind of seller sells this (bulk orders → wholesalers, small orders →
   supermarkets) and finds the closest ones that list a mobile number. Sellers come from OpenStreetMap: real
   businesses, labelled "not checked by StockRun".
4. **Message:** the AI writes your first WhatsApp message (never your budget); a link opens *your own* WhatsApp chat
   with the seller. StockRun sends no messages itself.
5. **Record the deal:** enter what you agreed. **RestockGuard** (circuit #1) decides: lock the money, ask you first
   (far away, alcohol, electronics) or reject it with nothing charged.
6. **Collect:** at the shop, with the goods in your hands, confirm the count. Your phone's location must be within
   ~300 m of the shop. **PickupCheck** (circuit #2) approves the seller's payment for what you counted; the rest comes
   back to you.
7. **Seller paid:** StockRun pays the seller's bank through Paystack Transfers, automatically once an admin has
   approved the account (sellers add it from a link you forward). Delivery by a logistics company is decided by
   **DeliveryCheck** (circuit #3).

## What is on-chain and what is not
| | Where it lives | Who can move it |
| --- | --- | --- |
| The three circuits' rules | X Layer, taped out (fixed NAND netlists; the processor is frozen) | Nobody can change them |
| Each payment decision | Asked of the circuit with `eval` on X Layer (read-only; no gas, no wallet). The input, output, circuit ID and block are saved with the order, so anyone can re-ask the circuit and check | — |
| Naira balances and locked money | **StockRun's double-entry ledger**, backed by StockRun's Paystack/bank account. **Not on-chain.** | Only circuit decisions move locked money; an admin can send approved payouts but cannot create, change or redirect them |
| Coins (wallet users) | The buyer's own vault contract (`contracts/src/StockRunVault.sol`), which calls the circuits itself | **Not live yet**: the vault is written and fork-tested, not deployed on mainnet |

## TapeOut and X Layer used
- **Processor Factory, NAND transistor tokens, tapeout, `eval`:** three decision circuits, taped out on X Layer
  mainnet on 2026-11-19 and called live for every naira order.
- **Not used:** DeWEB (the app runs on an AWS Lightsail server), TapeSend, REF (the circuits are flat netlists), circuit containers.

| Item | Value |
| --- | --- |
| Processor | [`0x34efCc0a3191A48Feec787252E6d817b063A4017`](https://www.oklink.com/xlayer/address/0x34efCc0a3191A48Feec787252E6d817b063A4017) |
| RestockGuard #1 (34 in → 5 out, 119 NAND) | tapeout tx [`0xaf6429bf…d2a0feca6fd`](https://www.oklink.com/xlayer/tx/0xaf6429bf2e4a7bc4e435ca493815b8b868d7728389ed904e5eb0dd2a0feca6fd) |
| PickupCheck #2 (27 in → 13 out, 210 NAND) | tapeout tx [`0x24b80f4d…38bacae`](https://www.oklink.com/xlayer/tx/0x24b80f4d29c57371c33357cd9b9ece03038d9016ade3e296620747c5e18bacae) |
| DeliveryCheck #3 (21 in → 13 out, 141 NAND) | tapeout tx [`0x0249042e…e86d66d2`](https://www.oklink.com/xlayer/tx/0x0249042e8918f77cbe4056880fc10a0d54ab3bdb4599f47fe66fa313e86d66d2) |
| Vault | not deployed yet |

The rules each circuit implements are in [`docs/CIRCUITS.md`](docs/CIRCUITS.md); the TypeScript reference model in
[`circuits/reference/`](circuits/reference/) is the source of truth, and tests check the netlists match it bit for bit.

## Status
**Works:** email and wallet sign-in · Paystack deposits (test) · address-first seller search with AI planning ·
AI-written WhatsApp messages · record a deal → RestockGuard → money locked · pickup with a location check →
PickupCheck → seller's payment approved · automatic seller payouts and buyer withdrawals through Paystack (test) ·
admin page (orders, money held, payouts, which sellers buyers contacted).

**Not yet:** paying with coins through the vault · real logistics bookings (Sendrelay is built, needs a live key) ·
Google Maps sellers (built, needs billing).

## Run it
Needs Node 24+ (`node:sqlite`) and, for the local chain, [Foundry](https://getfoundry.sh) (`anvil`).
```
cd app && npm install && npm run build          # the app, served by the server
cd ../agent && npm install && npm run serve     # local chain, test money, codes printed in the console
cd ../agent && npm test                          # server tests
cd ../circuits && npm install && npm test        # circuit reference model
cd ../contracts && forge build && forge test --fork-url $XLAYER_RPC   # vault, on a fork of X Layer
```
`npm run serve:xlayer` runs against X Layer mainnet. Settings are documented in [`.env.example`](.env.example).

**Hosting:** one AWS Lightsail server (Ubuntu 24.04, 1 GB). [`scripts/aws/setup-server.sh`](scripts/aws/setup-server.sh)
installs Node, builds the app, runs it as a `systemd` service behind Caddy (free HTTPS on an sslip.io name) and keeps
the database in `/var/lib/stockrun`, so it survives restarts and updates. Copy the settings to `/opt/stockrun/.env`
first, then `sudo bash setup-server.sh <ip-with-dashes>.sslip.io`. Run it again to deploy the latest `main`.

## Repo
`agent/` server and AI agent · `app/` web app (React, Leaflet) · `circuits/` reference model, netlists, tapeout
scripts · `contracts/` the vault (Foundry) · `deployments/xlayer.json` mainnet addresses · `docs/` design notes ·
`site/` landing page.
