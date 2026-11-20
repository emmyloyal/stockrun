# StockRun — project context for Claude Code

## What we are building
StockRun is an AI buying agent on a map, for anyone in Nigeria, built for the X Layer × TapeOut "Build X" hackathon
(deadline: 2026-12-07 23:59 UTC = 00:59 Lagos time on Dec 8; we target submission on Dec 6).

A person signs in with a phone number or a wallet, deposits naira (Paystack) or uses the coins in their wallet, and
types what they want with a budget ("20 cartons of Indomie, under ₦300,000, deliver to Ikeja"). The agent finds sellers
and producers on the map, negotiates with them on WhatsApp, and pays the seller **only after the logistics company (or
the buyer collecting it) has the goods**. Every payment decision is made by a TapeOut circuit on X Layer, never by the AI.
People have a profile (username, picture). There are no shops, no riders and no bonds.

## The non-negotiable design rules
1. **The AI never moves money.** The agent key can only propose orders and submit evidence.
2. **Every payment decision is a TapeOut circuit's.** Inputs are built from stored state and signed evidence, never
   from the caller. Coins: the user's vault on X Layer builds the inputs and moves the money. Naira: the server builds
   the same inputs from the ledger, calls the same circuit's `eval` on X Layer, and applies only what it returns.
3. **Only trusted handlers collect goods:** the buyer (self-pickup) or a verified logistics company. The seller is paid
   at pickup on the handler's confirmation; delivery decides the logistics fee (paid, or held back if goods are short).
4. **No deposits to sellers.** Sellers are paid at pickup, after verification, in naira via StockRun's payout account.
5. **If a circuit call fails, the order holds.** Never pay by default.
6. The buyer's approval clears "ask owner" rules but never "reject" rules.
7. **Honesty about where money is.** Naira deposits are held by StockRun in a ledger (integer kobo, every movement
   recorded, a deposit credited once per Paystack reference and only after Paystack verifies it). The app never calls
   naira balances "on-chain". On-chain claims carry a transaction hash.

## Repo layout
- `docs/` — plan, circuit specs, TapeOut notes, WhatsApp notes. **Read `docs/CIRCUITS.md` before touching circuits or the vault.**
- `circuits/` — TypeScript reference model of the three circuits (the source of truth for behaviour), tests, and later the netlists.
- `contracts/` — Foundry project: `StockRunVault.sol` + TapeOut interface. Tests run on a fork of X Layer mainnet.
- `agent/` — AI agent service (order parsing, supplier search, negotiation, booking).
- `app/` — owner + rider mobile web app (React + Leaflet/OpenStreetMap), deployed to DeWEB.
- `scripts/` — deploy / tapeout / verify scripts.

## TapeOut facts (verify against official docs before relying on them — see docs/TAPEOUT_NOTES.md)
- X Layer mainnet, chain ID 196, RPC `https://rpc.xlayer.tech`. **TapeOut has no testnet** — rehearse on a local fork.
- Circuits are built from NAND (and LATCH) transistors; tapeout burns transistors and mints a circuit NFT.
- Circuits are evaluated with a read-only `eval(circuitId, bytes)` call; they cannot call out or write state.
- Each circuit has an ERC-6551 "container" wallet. REF lets circuits reuse other circuits (confirm support).

## Working agreements
- The reference model in `circuits/reference/` defines behaviour. Netlists and the vault must match it bit for bit;
  every change to a rule changes the reference model and its tests first.
- Never commit private keys. Use `.env` (see `.env.example`). Never hard-code addresses that are marked "verify".
- Keep the demo path working end to end at all times; simulate (supplier bots, GPS track, naira alert) rather than block.

## Commands
- Circuit model tests: `cd circuits && npm install && npm test`
- Contracts: `cd contracts && forge install foundry-rs/forge-std && forge build && forge test --fork-url $XLAYER_RPC`
