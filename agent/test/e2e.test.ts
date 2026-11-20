// End to end: the agent against a real StockRunVault on a local anvil chain (MockCircuits implement the
// reference rules; the real taped-out circuits are covered by contracts/test/fork/). Needs anvil and
// `forge build` artifacts; skipped otherwise.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { handleOrder, type AgentDeps } from '../src/agent.ts';
import { RuleExtractor } from '../src/rules.ts';
import { BotChannel } from '../src/sim/bots.ts';
import { startLocalChain, localChainAvailable, accounts, tokenAbi, vaultAdminAbi, DEMO_SHOP, TOKEN_PER_NAIRA, type LocalChain } from '../src/sim/localChain.ts';
import { fixedRate } from '../src/chain/money.ts';

const { payout } = accounts;

describe.skipIf(!localChainAvailable())('agent end to end on a local chain', () => {
  let chain: LocalChain; let pub: PublicClient; let deps: AgentDeps; let token: Address; let vault: Address;

  beforeAll(async () => {
    chain = await startLocalChain();
    ({ pub, token, vault } = chain);
    deps = {
      extractor: new RuleExtractor(),
      channel: new BotChannel(),
      vault: chain.vaultClient,
      riders: chain.riders,
      shop: DEMO_SHOP,
      money: fixedRate(TOKEN_PER_NAIRA),
    };
  }, 60_000);

  afterAll(() => { chain?.stop(); });

  it('small order: negotiates, books a trusted logistics company, RestockGuard approves and locks funds', async () => {
    const report = await handleOrder('5 cartons of Indomie within 5 km', deps);
    const [o] = report.outcomes;
    expect(o.kind).toBe('proposed');
    if (o.kind !== 'proposed') return;
    expect(o.deal.supplier.id).toBe('sim-mile12-adeyemi');
    expect(o.deal.unitPriceNaira).toBe(13300);
    expect(o.result.status).toBe('locked');
    // Mile 12 -> Ojota is 2.98 km: delivery ₦1,500 + 250 x 2.98 = ₦2,245 -> ₦2,300.
    // 5 x ₦13,300 + ₦2,300 = ₦68,800 locked in escrow.
    expect(o.riderFeeNaira).toBe(2300);
    expect(await pub.readContract({ address: vault, abi: vaultAdminAbi, functionName: 'locked' })).toBe(68_800n * TOKEN_PER_NAIRA);
    // The agent moved no money: the supplier is paid only after the pickup check.
    expect(await pub.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [payout.address] })).toBe(0n);
    expect(report.message).toMatch(/RestockGuard approved; funds locked in escrow\. Order #0, tx 0x[0-9a-f]{64}/);
  });

  it('large order: within budget but above the limit, so the circuit asks the owner', async () => {
    const report = await handleOrder('10 bags of rice at 80k within 5 km', deps);
    const [o] = report.outcomes;
    expect(o.kind === 'proposed' && o.deal.supplier.id).toBe('sim-ketu-chukwu'); // preferred supplier first
    expect(o.kind === 'proposed' && o.deal.unitPriceNaira).toBeLessThanOrEqual(80000);
    expect(o.kind === 'proposed' && o.result.status).toBe('ask_owner');
    expect(report.message).toMatch(/Needs your OK because it is above your auto-approve limit\. Reply YES 1/);
  });

  it('restricted item: beer always needs the owner', async () => {
    const report = await handleOrder('5 crates of beer within 15 km', deps);
    const [o] = report.outcomes;
    expect(o.kind === 'proposed' && o.result.status).toBe('ask_owner');
    expect(o.kind === 'proposed' && o.result.status === 'ask_owner' && o.result.reason).toBe(4);
  });

  it('unapproved suppliers are suggested to the owner, never used', async () => {
    const report = await handleOrder('3 cartons of spaghetti within 5 km', deps); // only Blessing (unknown) stocks it
    expect(report.outcomes[0].kind).toBe('no_supplier');
    expect(report.message).toMatch(/Suggest approving: Blessing Wholesale \(demo\)/);
  });

  it('over budget: RestockGuard rejects and nothing is stored', async () => {
    // ~186 units of budget left; 15 bags of rice at ~₦79,500 = ~239 units, over the budget
    const report = await handleOrder('15 bags of rice at 80k within 5 km', deps);
    const [o] = report.outcomes;
    expect(o.kind === 'proposed' && o.result.status).toBe('rejected');
    expect(o.kind === 'proposed' && o.result.status === 'rejected' && o.result.reason).toBe(2);
    expect(report.message).toMatch(/rejected it: it is over your remaining weekly budget\. Nothing was charged/);
  });
});
