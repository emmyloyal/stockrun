# Circuits

- `reference/circuits.ts`: behaviour of RestockGuard, PickupCheck, DeliveryCheck and the CMP8/MIN8/SUB8 blocks. This is the source of truth.
- `reference/pack.ts`: input/output bit packing for `eval()` (TAP-02 §5, LSB-first; confirmed on X Layer).
- `sim/netlist.ts`: software evaluator for TAP-02 netlists (NAND + REF). It matches on-chain `eval` on X Layer.
- `netlists/builder.ts`: NAND compiler (constant folding, gate sharing, dead-gate removal, outputs placed last).
- `netlists/blocks.ts`: CMP8, MIN8, SUB8 generators.
- `build/*.json`: generated netlists to tape out (`npm run build-netlists`). Tests fail if they drift from the generator.
- `scripts/fork-check.ts`: compares a deployed circuit's `eval` with the simulator (read-only).
- `scripts/find-circuits.ts`: scans X Layer processors for circuits.

## Commands
```
npm install
npm test              # reference model, simulator, exhaustive block checks
npx tsc -p .          # type check
npm run build-netlists
npm run fork-check -- <processor> <circuitId>
```

## Workflow per circuit
1. Change the rule in `docs/CIRCUITS.md` and `reference/circuits.ts`. Tests must pass.
2. Write the netlist generator in `netlists/`.
3. Simulate it against the reference model: exhaustive for the blocks; boundaries + 100k random for the big three.
4. Tape out on a mainnet fork, call `eval()` and compare with the reference again.
5. Tape out on mainnet, then record the circuit ID in the root README.
