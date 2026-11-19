// Photo check: unit tests for the count decision, and the full pickup -> delivery path on a local chain with a
// scripted photo counter (Gemini's vision call is replaced; everything on-chain is real: vault + MockCircuits).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createWalletClient, http, parseAbi, type Address, type PublicClient } from 'viem';
import { anvil } from 'viem/chains';
import { handleOrder } from '../src/agent.ts';
import { RuleExtractor } from '../src/rules.ts';
import { BotChannel } from '../src/sim/bots.ts';
import { startLocalChain, localChainAvailable, accounts, tokenAbi, DEMO_SHOP, TOKEN_PER_NAIRA, type LocalChain } from '../src/sim/localChain.ts';
import { decideCount, type PhotoCount, type PhotoCounter, type Photo } from '../src/check/photoCount.ts';
import { CheckService } from '../src/check/checkService.ts';
import { JobStore } from '../src/check/jobs.ts';

const report = (over: Partial<PhotoCount> = {}): PhotoCount =>
  ({ itemVisible: true, count: 5, confidence: 'high', damage: false, damageNotes: '', photoProblem: 'none', ...over });
const PHOTO: Photo = { data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), mediaType: 'image/jpeg' };

describe('count decision (code decides what may be attested)', () => {
  it('attests a clear count, clamped to 0..255', () => {
    expect(decideCount(report({ count: 18 }))).toEqual({ attest: true, aiCount: 18, damage: false, note: '' });
    expect(decideCount(report({ count: 900 }))).toMatchObject({ attest: true, aiCount: 255 });
    expect(decideCount(report({ count: -3 }))).toMatchObject({ attest: true, aiCount: 0 });
  });
  it('asks for a new photo when anything is doubtful', () => {
    expect(decideCount(null)).toMatchObject({ attest: false });
    expect(decideCount(report({ photoProblem: 'blurry' }))).toMatchObject({ attest: false, retake: expect.stringMatching(/blurry/) });
    expect(decideCount(report({ photoProblem: 'units_hidden' }))).toMatchObject({ attest: false, retake: expect.stringMatching(/Spread/) });
    expect(decideCount(report({ itemVisible: false }))).toMatchObject({ attest: false });
    expect(decideCount(report({ confidence: 'low' }))).toMatchObject({ attest: false });
  });
  it('passes visible damage through to the circuit', () => {
    expect(decideCount(report({ damage: true, damageNotes: 'one carton torn' }))).toMatchObject({ attest: true, damage: true, note: 'one carton torn' });
  });
});

/** Scripted counter: returns the next report, and records what it was asked (to prove the order size is never shown). */
class ScriptedCounter implements PhotoCounter {
  queue: (PhotoCount | null)[] = [];
  asked: string[] = [];
  async count(_p: Photo, e: { item: string; unit: string }) { this.asked.push(JSON.stringify(e)); return this.queue.shift() ?? null; }
}

const riderAbi = parseAbi(['function riderPickup(uint256 id, bool atSupplier, uint8 riderCount)', 'function riderArrive(uint256 id, bool atShop)', 'function ownerConfirm(uint256 id, bool ok, bool issue)']);

describe.skipIf(!localChainAvailable())('photo check on a local chain', () => {
  let chain: LocalChain; let pub: PublicClient; let svc: CheckService; let counter: ScriptedCounter; let jobs: JobStore;
  const wallet = (a: typeof accounts.owner) => createWalletClient({ account: a, chain: anvil, transport: http(chain.url) });
  const send = async (p: Promise<`0x${string}`>) => pub.waitForTransactionReceipt({ hash: await p });
  const balance = (a: Address) => pub.readContract({ address: chain.token, abi: tokenAbi, functionName: 'balanceOf', args: [a] });
  const order = async (text: string) => {
    const r = await handleOrder(text, { extractor: new RuleExtractor(), channel: new BotChannel(), vault: chain.vaultClient, riders: chain.riders, shop: DEMO_SHOP, tokenPerNaira: TOKEN_PER_NAIRA, jobs });
    const o = r.outcomes[0];
    if (o.kind !== 'proposed' || o.result.status !== 'locked') throw new Error('order did not lock');
    return o.result.orderId;
  };
  const riderPickup = (id: bigint, n: number) => send(wallet(accounts.rider).writeContract({ address: chain.vault, abi: riderAbi, functionName: 'riderPickup', args: [id, true, n] }));
  const riderArrive = (id: bigint) => send(wallet(accounts.rider).writeContract({ address: chain.vault, abi: riderAbi, functionName: 'riderArrive', args: [id, true] }));

  beforeAll(async () => {
    chain = await startLocalChain();
    pub = chain.pub;
    counter = new ScriptedCounter();
    jobs = new JobStore();
    svc = new CheckService(chain.vault, pub, wallet(accounts.checker), counter, jobs);
  }, 60_000);
  afterAll(() => { chain?.stop(); });

  it('short pickup: photo shows 4 of 5, rider says 5 -> PickupCheck pays the supplier for 4', async () => {
    const id = await order('5 cartons of Indomie within 5 km');
    expect(jobs.get(id)).toMatchObject({ item: 'Indomie noodles carton (40 x 70g)', unit: 'carton', rider: accounts.rider.address });
    const before = await balance(accounts.payout.address);
    await riderPickup(id, 5);
    counter.queue.push(report({ count: 4 }));
    const r = await svc.pickup(id, PHOTO);
    expect(r).toMatchObject({ status: 'settled', outcome: 'paid_part', qty: 4, reason: 5, aiCount: 4 });
    expect(await balance(accounts.payout.address) - before).toBe(4n * 13_300n * TOKEN_PER_NAIRA);
    expect(counter.asked.at(-1)).not.toMatch(/5|quantity|ordered/); // the model never sees the order size

    // Delivery: 4 arrive. The owner has not confirmed yet -> the circuit waits.
    await riderArrive(id);
    counter.queue.push(report({ count: 4 }));
    const d1 = await svc.delivery(id, PHOTO);
    expect(d1).toMatchObject({ status: 'settled', outcome: 'held', reason: 5 });
    // Owner confirms -> anyone may settle again -> rider paid.
    await send(wallet(accounts.owner).writeContract({ address: chain.vault, abi: riderAbi, functionName: 'ownerConfirm', args: [id, true, false] }));
    const riderBefore = await balance(accounts.rider.address);
    expect(await svc.settle(id, 'delivery')).toMatchObject({ outcome: 'rider_paid' });
    expect(await balance(accounts.rider.address) - riderBefore).toBe(2_300n * TOKEN_PER_NAIRA);
  }, 60_000);

  it('photo first, rider second: waits for the rider, then settles in full', async () => {
    const id = await order('5 cartons of Indomie within 5 km');
    counter.queue.push(report({ count: 5 }));
    expect(await svc.pickup(id, PHOTO)).toMatchObject({ status: 'waiting_rider', aiCount: 5 });
    await riderPickup(id, 5);
    expect(await svc.settle(id, 'pickup')).toMatchObject({ outcome: 'paid', qty: 5, reason: 0 });
  }, 60_000);

  it('short delivery: 5 picked up, photo at the shop shows 3 -> owner compensated from the bond', async () => {
    const id = await order('5 cartons of Indomie within 5 km');
    await riderPickup(id, 5);
    counter.queue.push(report({ count: 5 }));
    await svc.pickup(id, PHOTO);
    await riderArrive(id);
    counter.queue.push(report({ count: 3 }));
    expect(await svc.delivery(id, PHOTO)).toMatchObject({ status: 'settled', outcome: 'compensated', qty: 2, reason: 4 });
  }, 60_000);

  it('damaged goods at pickup -> held, nothing paid', async () => {
    const id = await order('5 cartons of Indomie within 5 km');
    const before = await balance(accounts.payout.address);
    await riderPickup(id, 5);
    counter.queue.push(report({ damage: true, damageNotes: 'two cartons wet' }));
    expect(await svc.pickup(id, PHOTO)).toMatchObject({ status: 'settled', outcome: 'held', reason: 3, damage: true });
    expect(await balance(accounts.payout.address)).toBe(before);
  }, 60_000);

  it('a bad photo is never attested, and unknown or wrong-stage orders are refused', async () => {
    const id = await order('5 cartons of Indomie within 5 km');
    counter.queue.push(report({ photoProblem: 'too_dark' }));
    expect(await svc.pickup(id, PHOTO)).toMatchObject({ status: 'retake' });
    expect((await svc.order(id))[13]).toBe(false); // aiCounted still false
    expect(await svc.pickup(id, { data: new Uint8Array(), mediaType: 'image/jpeg' })).toMatchObject({ status: 'retake' });
    expect(await svc.pickup(999n, PHOTO)).toMatchObject({ status: 'error' });
    expect(await svc.delivery(id, PHOTO)).toMatchObject({ status: 'error', message: expect.stringMatching(/not waiting for a delivery/) });
  }, 60_000);
});
