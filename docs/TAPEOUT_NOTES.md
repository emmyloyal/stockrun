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

Everything BNB-only must be confirmed on an X Layer fork before we rely on it (see "Fork check" below).

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
- Gas (BNB measurement): about **2,317 gas per gate** in `eval`. The vault calls eval on-chain, so a 500-gate circuit costs about 1.2M gas per settle. Keep circuits small.
- Tapeout fee:
  - TAP-02 does not specify it. BNB charges 0.0002 BNB.
  - X Layer figures observed by one third-party project: 0.0013 OKB tapeout + 0.0001 OKB per NAND + 0.00066 OKB protocol fee. **verify**
- **verify:** how to create a processor (TAP-10 says this "is not described"), the NAND mint function, and the price.

## Containers (TAP-10 §1)
- One ERC-6551 account per circuit NFT, at `opener.accountOf(processor, id)`.
- Opening it costs a one-time fee (amount on X Layer: verify).

## Security posture
- TAP-02 and TAP-10 are Draft. No independent audit has been published.
- TapeKit (2026-10-22): processors are frozen on BNB, X Layer and Base (circuit beacons are ownerless), but the factory is still upgradeable.

## Fork check (to do once Foundry is installed)
On `anvil --fork-url https://rpc.xlayer.tech`, confirm the BNB-only items above:
1. Call `factory.cpuCount()` and `cpuAt(0)`, and confirm the factory address.
2. On a processor with existing circuits, call `circuitInfo`, `netlist` and `eval`. Check that the selectors match.
3. Simulate the netlist locally and compare with `eval`. This confirms the bit packing on X Layer.
4. Find `createCPU`, the NAND mint function and the fee constants from the factory and processor bytecode/ABI (or from third-party scripts such as OpenGate or Cerebr), then check them on the fork.

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
- [ ] Fork check on X Layer (above)
- [ ] Create a processor and record its address in the README
- [ ] Mint enough NAND for all circuits, plus a margin for a re-spin
