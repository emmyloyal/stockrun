# StockRun — project context for Claude Code

## What we are building
StockRun is an AI restocking agent for small shops in Lagos, built for the X Layer × TapeOut "Build X" hackathon
(deadline: 2026-12-07 23:59 UTC = 00:59 Lagos time on Dec 8; we target submission on Dec 6).

A shop owner sends an order ("20 cartons of Indomie, 10 bags of rice, within 5 km"). The agent finds suppliers on
a map and negotiates on WhatsApp. The owner chooses to collect the goods themselves or to send a verified logistics
company (Sendrelay first), and the supplier is paid **only after that handler has checked the goods at pickup**.
Every payment decision is made by a TapeOut circuit on X Layer, never by the AI. There are no rider bonds.

## The non-negotiable design rules
1. **The AI never moves money.** The agent key can only propose orders and submit evidence.
2. **The vault builds every circuit input itself** from contract storage and signed evidence — never from the caller.
3. **Only trusted handlers collect goods:** the owner (self-pickup) or a logistics company the owner approved. PickupCheck
   pays the supplier on the handler's count (a photo count can only lower it). With a logistics company, DeliveryCheck
   pays its fee when the owner confirms, or withholds the fee for the owner if goods arrive short; the shortfall is
   claimed off-chain from the company (insurance/dispute). Self-pickup has no delivery step and no fee. No bonds.
4. **No deposits to suppliers.** Supplier is paid at pickup, after verification, in naira via an off-ramp partner.
5. **If a circuit call fails, the order holds.** Never pay by default.
6. The owner's approval clears "ask owner" rules but never "reject" rules.

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
