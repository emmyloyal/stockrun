# TapeOut and X Layer notes

Everything marked **verify** comes from third-party hackathon repos or articles, not official docs. Confirm before use.

## Network
- X Layer mainnet, chain ID **196**, RPC `https://rpc.xlayer.tech`, explorer: OKLink.
- **No TapeOut testnet.** Rehearse on a local fork: `anvil --fork-url https://rpc.xlayer.tech`.

## Core protocol
- **Processor Factory** creates a processor (circuits contract = ERC-721 + its transistor token, ERC-1155). **verify** factory address; one project lists `0x1f09daefa827f02cbb40967cc91b259763760761` as "CPU Factory".
- **Transistors**: NAND and LATCH, minted per processor at the creator's set price; tapeout burns them.
- **Tapeout** mints a circuit NFT; netlist readable onchain via `netlist()`.
- **eval**: read-only, gas-free off-chain, `eval(uint256,bytes)` — **verify** signature and return type; one project lists selector `0x934d06ea`.
- **REF**: compose circuits from other circuits. **verify** support on X Layer (Cerebr used it; DrawAgent reported flat only).
- **Containers**: each circuit has an ERC-6551 wallet. (Stretch idea: hold escrow in the guard circuit's container.)
- Fees observed by one project: tapeout 0.0013 OKB + 0.0001 OKB per NAND + 0.00066 OKB protocol fee. **verify**
- TapeOut circuit contracts are upgradable by the TapeOut team; factory not sealed (per an independent audit, Oct 2026).

## Ecosystem tools we use
- **DeWEB**: sites stored onchain under `x.y.z.tape` names; public gateway `https://<x-y-z>.tapekit.org/`.
- **TapeKit**: reference client/browser for DeWEB.
- **TapeSend**: cross-chain end-to-end encrypted messaging with wallet-derived keys (spec: TAP-10).
- **TapeCode** (tapecode.ai): describe an app in text → generated app, security audit, one-click DeWEB deploy.
- **FabX**: Proof-of-Design mining. Optional: submit shared circuits.

## Useful references
- Hackathon page: https://web3.okx.com/xlayer/build-x-series
- TAP-10 (DeWEB + TapeSend spec): https://github.com/TapeOutProtocol/TAPs/pull/2
- TapeSynth (Verilog/PLA → NAND netlist, PoD-optimised): https://github.com/Cheeeeez/tapesynth
- Forgeout (optimiser + equivalence checker): https://github.com/davieslennox0/tapeout-forge
- OpenGate (vault calling a circuit's eval on-chain, fork tests): https://github.com/KAMEVETRICS/opengate
- Cerebr (REF composition on X Layer): https://github.com/NetLayerLabs/Cerebr

## First-day checklist
- [ ] Read official TapeOut docs; fill in every **verify** above
- [ ] Confirm eval bit order (see docs/CIRCUITS.md)
- [ ] Create processor; record address in README
- [ ] Mint enough NAND for all circuits (+ margin for a re-spin)
