import { describe, expect, it } from 'vitest';
import { createWalletClient, custom, parseGwei } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { xlayerFees, xLayerChain, XLAYER_TIP_WEI } from '../src/chain/platform.ts';

describe('X Layer fee rule', () => {
  it('pays base fee x 1.25 + 0.001 gwei at most', () => {
    expect(xlayerFees(parseGwei('0.02'))).toEqual({ maxPriorityFeePerGas: XLAYER_TIP_WEI, maxFeePerGas: parseGwei('0.026') });
  });

  it('refuses to send when the base fee is above the ceiling', () => {
    expect(() => xlayerFees(parseGwei('0.6'))).toThrow(/ceiling/);
  });

  it('overrides fees a node fills in (anvil fills a 1 gwei tip)', async () => {
    const node = custom({
      async request({ method }: { method: string }) {
        if (method === 'eth_chainId') return '0xc4';
        if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1312d00', number: '0x1', timestamp: '0x1', transactions: [] };
        if (method === 'eth_fillTransaction') return { raw: '0x', tx: { type: '0x2', gas: '0x5208', nonce: '0x0', chainId: '0xc4',
          maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x3b9aca00', value: '0x0', input: '0x' } };
        if (method === 'eth_getTransactionCount') return '0x0';
        if (method === 'eth_estimateGas') return '0x5208';
        throw new Error(`unexpected ${method}`);
      },
    });
    const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'); // anvil public test key
    const w = createWalletClient({ account, chain: xLayerChain, transport: node });
    const r = await w.prepareTransactionRequest({ to: account.address, value: 0n });
    expect(r.maxPriorityFeePerGas).toBe(XLAYER_TIP_WEI);
    expect(r.maxFeePerGas).toBe(parseGwei('0.026'));
  });
});
