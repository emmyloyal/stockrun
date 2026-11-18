# Circuits

- `reference/circuits.ts` — behaviour of RestockGuard, PickupCheck, DeliveryCheck (source of truth).
- `reference/pack.ts` — input/output bit packing for `eval()`. **Bit order is unconfirmed — see TODO.**
- `test/` — unit, boundary and random tests of the reference model.
- `netlists/` — (to create) netlists for CMP8, MIN8, SUB8 and the three circuits.

## Workflow per circuit
1. Change the rule in `docs/CIRCUITS.md` and `reference/circuits.ts`; tests green.
2. Write the netlist (TapeOut canvas, or Verilog → TapeSynth).
3. Simulate the netlist locally against the reference model (exhaustive for CMP8/MIN8/SUB8, boundary + 100k random for the big three).
4. Tape out on a mainnet fork, call `eval()`, compare to the reference again.
5. Tape out on mainnet; record the circuit ID in the root README.
