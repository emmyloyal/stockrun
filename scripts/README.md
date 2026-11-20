# Scripts (to write)

- `create-processor` — create the StockRun processor via the factory; mint NAND transistors.
- `tapeout <netlist>` — tape out a circuit; print its circuit ID.
- `verify-circuit <id> <circuit>` — call `eval()` on X Layer (or a fork) and compare against `circuits/reference` on boundary + random inputs.
- `deploy-vault` — deploy `StockRunVault` with the circuit IDs from `.env`.
- `demo-reset` — seed suppliers, a trusted logistics company and a funded vault for recording the video.

Rehearse everything on a fork first: `anvil --fork-url $XLAYER_RPC`.
