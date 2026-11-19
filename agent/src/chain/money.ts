// Naira <-> token conversion. Prices, budgets and fees are agreed in whole naira; the vault holds a token.
// On the local chain the test token is ₦-denominated (1 token = ₦1, 6 decimals). On X Layer the vault holds USDT0
// (6 decimals), so naira convert at a rate fixed when the server starts (the circuits only ever compare amounts in
// the same token, so the rate affects what the owner sees, never what the circuits decide).

export interface Money {
  /** Token base units for a whole-naira amount (rounded to the nearest base unit). */
  toToken(naira: number): bigint;
  /** Whole naira for a token amount (rounded down). */
  toNaira(amount: bigint): number;
  /** Human description, e.g. "1 token = ₦1" or "1 USDT0 = ₦1,354". */
  describe: string;
}

/** A token worth exactly `perNaira` base units per naira (the local test token). */
export function fixedRate(perNaira: bigint): Money {
  return {
    toToken: (naira) => BigInt(Math.round(naira)) * perNaira,
    toNaira: (amount) => Number(amount / perNaira),
    describe: `1 token = ₦${(10n ** 6n / perNaira).toString()}`,
  };
}

/** A dollar stablecoin with `decimals` decimals at `ngnPerUsd` naira per dollar. Exact integer maths in micro-naira. */
export function usdRate(ngnPerUsd: number, decimals = 6): Money {
  if (!(ngnPerUsd > 100 && ngnPerUsd < 100_000)) throw new Error(`implausible NGN per USD rate: ${ngnPerUsd}`);
  const rateMicro = BigInt(Math.round(ngnPerUsd * 1_000_000)); // micro-naira per dollar
  const one = 10n ** BigInt(decimals);                          // base units per dollar
  return {
    toToken: (naira) => (BigInt(Math.round(naira)) * one * 1_000_000n + rateMicro / 2n) / rateMicro,
    toNaira: (amount) => Number((amount * rateMicro) / (one * 1_000_000n)),
    describe: `1 USDT0 = ₦${ngnPerUsd.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`,
  };
}
