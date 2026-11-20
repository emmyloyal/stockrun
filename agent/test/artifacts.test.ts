// The committed vault (deployments/artifacts/) is what servers without Foundry deploy for every new shop.
// It must be exactly what `forge build` produces from contracts/src, or shops would get a different vault.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const built = new URL('../../contracts/out/StockRunVault.sol/StockRunVault.json', import.meta.url);
const copy = new URL('../../deployments/artifacts/StockRunVault.json', import.meta.url);

describe.skipIf(!existsSync(built))('committed vault artifact', () => {
  it('matches the forge build (run `npm run artifacts` after changing the contract)', () => {
    const a = JSON.parse(readFileSync(built, 'utf8')), b = JSON.parse(readFileSync(copy, 'utf8'));
    expect(b.bytecode.object).toBe(a.bytecode.object);
    expect(b.abi).toEqual(a.abi);
  });
});
