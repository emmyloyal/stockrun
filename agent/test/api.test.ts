// The app API on a local chain: owner places an order, rider signs their own steps through /rpc, photos go to the
// check service (scripted counter), and the circuits pay. Also checks what the API refuses.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createWalletClient, http, parseAbi } from 'viem';
import { anvil } from 'viem/chains';
import { createApi } from '../src/server/api.ts';
import { startLocalChain, localChainAvailable, accounts, tokenAbi, DEMO_SHOP, TOKEN_PER_NAIRA, type LocalChain } from '../src/sim/localChain.ts';
import { RuleExtractor } from '../src/rules.ts';
import { BotChannel } from '../src/sim/bots.ts';
import { CheckService } from '../src/check/checkService.ts';
import { JobStore } from '../src/check/jobs.ts';
import type { PhotoCount, PhotoCounter } from '../src/check/photoCount.ts';

const vaultUserAbi = parseAbi(['function riderPickup(uint256 id, bool atSupplier, uint8 riderCount)', 'function riderArrive(uint256 id, bool atShop)', 'function ownerConfirm(uint256 id, bool ok, bool issue)']);
const report = (count: number): PhotoCount => ({ itemVisible: true, count, confidence: 'high', damage: false, damageNotes: '', photoProblem: 'none' });
class Scripted implements PhotoCounter { queue: PhotoCount[] = []; async count() { return this.queue.shift() ?? null; } }
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');

describe.skipIf(!localChainAvailable())('app API', () => {
  let chain: LocalChain; let server: Server; let base: string; const counter = new Scripted();
  const api = async (path: string, body?: unknown) => {
    const r = await fetch(base + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  // Browser-side wallets: they talk to the chain only through the API's /rpc relay.
  const browser = (a: typeof accounts.owner) => createWalletClient({ account: a, chain: anvil, transport: http(`${base}/rpc`) });
  const sign = async (a: typeof accounts.owner, functionName: 'riderPickup' | 'riderArrive' | 'ownerConfirm', args: readonly unknown[]) => {
    const hash = await browser(a).writeContract({ address: chain.vault, abi: vaultUserAbi, functionName, args: args as never });
    await chain.pub.waitForTransactionReceipt({ hash });
  };

  beforeAll(async () => {
    chain = await startLocalChain();
    const jobs = new JobStore();
    const checker = createWalletClient({ account: accounts.checker, chain: anvil, transport: http(chain.url) });
    server = createApi({
      pub: chain.pub, vault: chain.vault, chainId: anvil.id, jobs, tokenPerNaira: TOKEN_PER_NAIRA, rpcUrl: chain.url,
      check: new CheckService(chain.vault, chain.pub, checker, counter, jobs),
      agent: { extractor: new RuleExtractor(), channel: new BotChannel(), vault: chain.vaultClient, riders: chain.riders, shop: DEMO_SHOP, tokenPerNaira: TOKEN_PER_NAIRA, jobs },
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(() => { server?.close(); chain?.stop(); });

  it('runs one order from text to rider paid', async () => {
    const placed = await api('/api/orders', { text: '5 cartons of Indomie within 5 km' });
    expect(placed.status).toBe(200);
    expect(placed.json.message).toMatch(/funds locked in escrow\. Order #0/);

    const jobs = (await api(`/api/riders/${accounts.rider.address}/jobs`)).json;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ orderId: '0', status: 'Locked', ordered: 5, unitPriceNaira: 13_300, riderFeeNaira: 2_300, supplier: { name: expect.stringMatching(/Mile 12/) } });

    // Rider counts 5 and signs it; the photo shows 4: the supplier is paid for 4.
    await sign(accounts.rider, 'riderPickup', [0n, true, 5]);
    counter.queue.push(report(4));
    const pickup = await api('/api/orders/0/photo', { stage: 'pickup', mediaType: 'image/jpeg', data: JPEG });
    expect(pickup.json).toMatchObject({ status: 'settled', outcome: 'paid_part', qty: 4 });
    expect(await chain.pub.readContract({ address: chain.token, abi: tokenAbi, functionName: 'balanceOf', args: [accounts.payout.address] })).toBe(4n * 13_300n * TOKEN_PER_NAIRA);

    // Delivery: rider arrives, photo shows 4, the circuit waits for the owner; owner confirms; settle pays the rider.
    await sign(accounts.rider, 'riderArrive', [0n, true]);
    counter.queue.push(report(4));
    expect((await api('/api/orders/0/photo', { stage: 'delivery', mediaType: 'image/jpeg', data: JPEG })).json).toMatchObject({ outcome: 'held', reason: 5 });
    await sign(accounts.owner, 'ownerConfirm', [0n, true, false]);
    expect((await api('/api/orders/0/settle', { stage: 'delivery' })).json).toMatchObject({ outcome: 'rider_paid' });

    const [view] = (await api('/api/orders')).json;
    expect(view).toMatchObject({ status: 'Delivered', pickup: { picked: 4, riderCount: 5, aiCount: 4 }, delivery: { delivered: 4, ownerOk: true }, lastCheck: { outcome: 'rider_paid' } });
  }, 60_000);

  it('refuses what it should', async () => {
    // Test-node controls cannot be reached through the browser relay (no time travel to force a timeout payout).
    const rpc = (method: string) => fetch(`${base}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) });
    expect((await rpc('evm_increaseTime')).status).toBe(403);
    expect((await rpc('anvil_setBalance')).status).toBe(403);
    expect((await rpc('eth_blockNumber')).status).toBe(200);
    expect((await api('/api/orders', { text: '' })).status).toBe(400);
    expect((await api('/api/orders/0/photo', { stage: 'teleport', data: JPEG })).status).toBe(400);
    expect((await api('/api/orders/0/settle', { stage: 'pickup' })).status).toBe(409);
    expect((await fetch(`${base}/..%2F..%2F.env`)).status).not.toBe(200);
  }, 30_000);
});
