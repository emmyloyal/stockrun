# Starting in Claude Code

1. Unzip, `cd stockrun`, `git init`, then run `claude`. Claude Code reads `CLAUDE.md` automatically.
2. Check everything works:
   - `cd circuits && npm install && npm test` (18 tests)
   - `cd contracts && forge install foundry-rs/forge-std && forge test` (6 tests, run against mock circuits)

## Suggested prompts, in order
1. "Read docs/TAPEOUT_NOTES.md and the official TapeOut docs at <link>. Fill in every 'verify' item and tell me the exact eval() signature and bit order."
2. "Update circuits/reference/pack.ts, StockRunVault._pack/_unpack and MockCircuits to the confirmed bit order. Keep all tests green."
3. "Write Verilog for CMP8, MIN8 and SUB8, synthesise to NAND netlists with TapeSynth, and add a simulator that checks the netlists exhaustively against the reference model."
4. "Build RestockGuard, PickupCheck and DeliveryCheck netlists from those blocks; check them against the reference model (boundaries + 100k random)."
5. "Write scripts to create the processor, mint NAND, tape out on an anvil fork of X Layer, and compare eval() with the reference."
6. "Add fork tests: StockRunVault against the real taped-out circuits."
7. Then the agent (agent/README.md) and the app (app/README.md).
