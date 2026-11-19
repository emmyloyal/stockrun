# TapeOut and X Layer notes

Primary sources (read 2026-11-18):
- **TAP-02** Circuit Netlist Format and Evaluation Semantics (Draft): https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-02.md
- **TAP-10** DeWEB Access and Messaging Layers (Draft), incl. X Layer deployment addresses: https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-10.md
- TapeKit README: https://github.com/TapeOutProtocol/TapeKit
- There is no separate docs site: tapeout.net is a blank page.

Status legend:
- **CONFIRMED (spec)**: stated in a TAP.
- **BNB-only**: TAP-02 verified it on BNB Chain (56) and says it did not read the X Layer and Base contracts.
- **verify**: still unknown.

The `eval`/`circuitInfo`/`netlist` ABI and the bit packing are now **confirmed on X Layer** (see "Fork check: results"). `tapeout` and the fees are still BNB-only.

## Network
- X Layer mainnet: chain ID **196**, RPC `https://rpc.xlayer.tech`, explorer OKLink, native coin OKB.
- **No TapeOut testnet.** Rehearse on a local fork: `anvil --fork-url https://rpc.xlayer.tech`.

## Addresses on X Layer (TAP-10 §2.2; TapeKit says X Layer and Base share addresses)
| Contract | Address |
| --- | --- |
| Processor factory (UUPS proxy) | `0x1f09DAeFA827f02CBb40967cc91b259763760761` |
| Factory implementation | `0x74956236Ab64eD143933040B4137E8A352e4d17b` |
| Circuit beacon | `0xf70d1ed4f62CF3780157B0b421b7E2F45bD0991C` |
| Circuit implementation | `0x977f217887E085D298Cb3819cDAD5A0ee35F29B2` |
| ERC-6551 registry | `0x000000006551c19487814612e58FE06813775758` |
| Container opener | `0x536adD8F30f03b69f6fbF29d425A816A0dC50106` |
| Container implementation | `0xAC4F791353eE9F06e2C50Ae4C34680D28Ea52a57` |
| Container payments table | `0x13b8AFa4Fd1b29B09D23A57A75ba8D3078d44858` |
| DeWEB SiteRegistry proxy | `0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6` |
| DeWEB DomainBinding proxy | `0x68809Fd2fb343aA57D0aeB7f33Defe477c9666f9` |
| DeWEB hub proxy | `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` |
| Processor #1 (Base/X Layer, TAP-10 test cases) | `0x0565EA48CA41Ae559d8d491dbb0a9ec945DB551b` (verify) |

The factory has read functions `cpuCount()`, `cpuAt(uint256)` and `isCPU(address)`.

## Processor (circuits contract) ABI (TAP-02 §6; BNB-only)
| Function | Selector | Notes |
| --- | --- | --- |
| `eval(uint256 id, bytes inputs) view returns (bytes)` | `0x934d06ea` | Packed outputs of one beat. Reverts `"has latch: use step"` if nState > 0 |
| `step(uint256 id, bytes state, bytes inputs) view returns (bytes newState, bytes outputs)` | `0xe8281a1a` | For latched circuits |
| `circuitInfo(uint256 id) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)` | `0x084d60f1` | |
| `netlist(uint256 id) view returns (bytes)` | `0x3fc4be56` | |
| `nextId()` | `0x61b8ce8c` | |
| `tapeout(bytes netlist, uint32 nIn, uint32 nOut) payable returns (uint256 id)` | `0x7bd3ac1d` | Checks the fee, then the §3 checks, then burns the top-level NAND+LATCH count in transistor tokens. Mints the circuit NFT to the caller |
| `beat(address cpu, uint256 id, bytes inputs)` | `0x1fc0021d` | State-changing |

Our circuits have no LATCH, so we use `eval`.

## Bit packing (TAP-02 §5; CONFIRMED (spec))
- Vector bit *i* is bit (*i* mod 8), value 2^(*i* mod 8), of byte ⌊*i*/8⌋. It is **LSB-first within each byte**.
- Signals: 0 is constant 0, 1 is constant 1, and **input *i* is signal 2+*i***.
- Outputs are the last nOut signals, in index order, so output 0 is bit 0 of byte 0 of the returned bytes.
- Outputs are exactly ⌈nOut/8⌉ bytes, and the unused high bits are 0.
- Inputs are read leniently: missing bits read as 0 and extra bytes are ignored. We still send exactly ⌈nIn/8⌉ bytes.
- **StockRun convention (our choice, because the netlist defines it):**
  - Fields are laid out in the order listed in `docs/CIRCUITS.md`.
  - Within a field, wire *k* = bit *k* of the value (LSB-first).
  - So the first field's LSB is input 0 and output 0.

## Netlist encoding (TAP-02 §2; CONFIRMED (spec))
- The netlist has no header, padding or terminator. nIn and nOut are passed separately to `tapeout`.
- Integers are big-endian, and signal indices are u24.
- `0x00` NAND `a:u24 b:u24` (7 bytes): one signal, NOT(a AND b).
- `0x01` LATCH `d:u24` (4 bytes): one signal, the previous beat's state.
- `0x02` REF `cpu:20B id:u64 nIns:u8 nOuts:u8 ins:u24×nIns` (31+3·nIns bytes): nOuts signals.
- NAND and REF inputs must be backward references (lower than the element's first produced signal). A LATCH `d` may point forward.

## REF (TAP-02; CONFIRMED (spec), X Layer support verify)
- REF is supported in the format.
  - At tapeout the target must pass `isCPU`, must exist, and its arity must match.
  - A REF can only target circuits with at most 255 inputs and 255 outputs.
  - There is no nesting limit beyond gas. (The 16-level limit applies only to Proof-of-Design mining.)
- Our blocks (CMP8, MIN8, SUB8) fit easily.

## Limits and fees
- Limits (TAP-02 §3):
  - nIn ≤ 65,536 and 1 ≤ nOut ≤ 65,536.
  - State ≤ 2^24 bits.
  - Total gates ≤ 2^32−1.
- **Measured eval gas on the X Layer fork (2026-11-18), worst case over our vectors:**

  | Circuit | eval gas |
  | --- | --- |
  | CMP8 | 0.10M (approx.) |
  | MIN8 | 189k |
  | SUB8 | 207k |
  | RestockGuard | 310k |
  | PickupCheck | 517k |
  | DeliveryCheck | 358k |

### ⚠ Fees moved to the BEM token (verified on the X Layer fork, 2026-11-18)
The factory proxy `0x1f09…0761` has been **upgraded** to implementation `0x336e9F0F4c3fEe7C8c803377e4DEA00293f4ae2a`. TAP-10 lists `0x7495…`, which is out of date. New processors get the transistor beacon `0x41Cb2bfd1cccA8f505EEDad0181eef44f1B9Ce65` (implementation `0x44Ebf3345bcf9aB329e7a28E53fd8EcfAd1a5EFE`). The third-party repos describe the old OKB-paid flow.

**BEM token:** `0x60e62Efa9405d6873C5deaBD4E6CC91c25363952` (ERC-20, 8 decimals), returned by `factory.bem()`.

| Step | Call | Payment (live values 2026-11-18) |
| --- | --- | --- |
| Create processor | `factory.createCPU(name, symbol, story, supply, mintPrice)`: **nonpayable** | Pulls `deployFee()` = 10,000,000 units = **0.1 BEM** via `transferFrom`. Goes to the protocol wallet `0x571d…af15` |
| Mint NAND | `transistors.mint(0, amount)`: **nonpayable** | Pulls `amount × mintPrice + protocolFee` in **BEM**. `protocolFee` = 0.01 BEM per mint call. `mintPrice` is ours to set and is paid to us |
| Tape out | `circuits.tapeout(netlist, nIn, nOut)`: **payable** | Exactly `TAPEOUT_FEE()` = **0.0013 OKB** (native). Wrong amounts revert `"tapeout fee"` |

- Factory caps: `MAX_MINT_PRICE` = 10,000 BEM, `MAX_DEPLOY_FEE` = 100 BEM, `MAX_PROTOCOL_FEE` = 10 BEM.
- The factory owner is `0xb3d85b42a045c1a88d800cad0f55d2566a4d3138` and can change the fees within those caps. **Always read fees live.**
- **Our mainnet cost** for 6 circuits (657 NAND):
  - 0.1 BEM to create the processor, plus 0.01 BEM protocol fee for the mint, plus 657 × mintPrice (paid to ourselves).
  - Plus 6 × 0.0013 = **0.0078 OKB**, plus gas.
- **verify:** where to obtain BEM on X Layer (DEX pool or faucet).

## Containers (TAP-10 §1)
- One ERC-6551 account per circuit NFT, at `opener.accountOf(processor, id)`.
- Opening it costs a one-time fee (amount on X Layer: verify).

## Security posture
- TAP-02 and TAP-10 are Draft. No independent audit has been published.
- TapeKit (2026-10-22): processors are frozen on BNB, X Layer and Base (circuit beacons are ownerless), but the factory is still upgradeable.

## Fork check: results (2026-11-18, X Layer mainnet, read-only RPC)
Scripts: `circuits/scripts/fork-check.ts` and `circuits/scripts/find-circuits.ts` (`npm run fork-check -- <processor> <id>`).
- [x] Factory `0x1f09…0761` is live on chain 196. It reports `cpuCount() = 430`. `cpuAt(0)` = `0x839bdD6fa7A66416A609A735e11DE5411B98574e`, and `isCPU` returns true for it.
- [x] `circuitInfo`, `netlist`, `nextId` and `eval` (`0x934d06ea`) all work on X Layer with the TAP-02 signatures.
- [x] **Bit packing CONFIRMED on X Layer.** Our TAP-02 simulator matches on-chain `eval` on:
  - `0x839b…574e` #1 and #2: 2-in/1-out, exhaustive.
  - `0x526b96238cc418d909005e2e2d79e327da4bd0f7` #4: 16-in/16-out, 1,204 gates. 50/50 vectors matched: all-zeros, all-ones, all 16 one-hot inputs and 32 random.
- [x] **Full tapeout rehearsal on the fork** (`contracts/test/fork/Tapeout.fork.t.sol`):
  - Create a processor, mint 657 NAND and tape out all 6 netlists.
  - `circuitInfo`/`netlist` match, and the NAND burn equals the gate count.
  - 1,000/1,000 reference vectors match `eval`.
- [ ] Not yet:
  - REF on X Layer.
  - How to obtain BEM.

## Ecosystem tools we use
- **DeWEB**: sites stored onchain under `x.y.z.tape` names. Public gateway: `https://<x-y-z>.tapekit.org/`.
- **TapeKit**: reference client and browser for DeWEB.
- **TapeSend**: cross-chain end-to-end encrypted messaging with wallet-derived keys (TAP-10).
- **TapeCode** (tapecode.ai): describe an app in text to get a generated app, a security audit and one-click DeWEB deploy.
- **FabX**: Proof-of-Design mining. Optional: submit shared circuits.

## Third-party references
- TapeSynth (Verilog/PLA → NAND netlist): https://github.com/Cheeeeez/tapesynth
- Forgeout (optimiser + equivalence checker): https://github.com/davieslennox0/tapeout-forge
- OpenGate (vault calling eval on-chain, fork tests): https://github.com/KAMEVETRICS/opengate
- Cerebr (REF composition on X Layer): https://github.com/NetLayerLabs/Cerebr

## First-day checklist
- [x] Read the TAPs. Fill in what they answer.
- [x] Eval bit order (TAP-02 §5) and the StockRun field convention.
- [x] Fork check of eval + bit packing on X Layer
- [x] Find createCPU / NAND mint / tapeout fee; rehearse on the fork
- [x] Get BEM + OKB into the deployer wallet (BEM bridged from BNB Chain via tapeout.net BEM Bridge)
- [x] Create a processor: `0x34efCc0a3191A48Feec787252E6d817b063A4017` (2026-11-19, see deployments/xlayer.json)
- [x] Mint 1,000 NAND (470 used by RestockGuard #1, PickupCheck #2, DeliveryCheck #3; 530 left for a re-spin)
