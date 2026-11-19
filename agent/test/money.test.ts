import { describe, it, expect } from 'vitest';
import { fixedRate, usdRate } from '../src/chain/money.ts';
import { envValue } from '../src/chain/platform.ts';

describe('naira <-> token', () => {
  it('converts the local test token exactly', () => {
    const m = fixedRate(1_000_000n);
    expect(m.toToken(13_300)).toBe(13_300_000_000n);
    expect(m.toNaira(13_300_999_999n)).toBe(13_300);
  });

  it('converts naira to USDT0 at a fixed rate with integer maths', () => {
    const m = usdRate(1354.04, 6);
    expect(m.toToken(1354.04 * 100)).toBe(100_000_000n);     // ₦135,404 = 100 USDT0
    expect(m.toToken(5000)).toBe(3_692_653n);                 // one circuit money unit ≈ 3.69 USDT0
    expect(m.toNaira(m.toToken(13_300))).toBeGreaterThanOrEqual(13_299);
    expect(m.toNaira(m.toToken(13_300))).toBeLessThanOrEqual(13_300);
    expect(() => usdRate(NaN)).toThrow(/implausible/);
    expect(() => usdRate(1.35)).toThrow(/implausible/);
  });

  it('reads env values without inline comments or padding', () => {
    expect(envValue({ K: '  0xabc  # never commit a real key' }, 'K')).toBe('0xabc');
    expect(envValue({ K: '   ' }, 'K')).toBeUndefined();
    expect(envValue({}, 'K')).toBeUndefined();
  });
});
