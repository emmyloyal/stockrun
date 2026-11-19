// Rehearsal of the mainnet setup on a LOCAL FORK of X Layer (nothing is sent to the real network):
// the real taped-out circuits (#1-#3), real USDT0, the real deployer/agent/check-service keys from .env, a vault for a
// throwaway owner, and one order from text to rider paid. Owner and rider get only the small gas top-up we plan to
// give real users, so this also shows whether that top-up is enough.
//   npm run rehearse:xlayer
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createTestClient, createWalletClient, http, parseAbi, parseEther, formatEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { xLayer } from 'viem/chains';
import { ANVIL } from './sim/localChain.ts';
import { xlayerPlatform, deployVault, envValue, tokenAbi } from './chain/platform.ts';
import { VaultClient } from './tools/vault.ts';
import { handleOrder } from './agent.ts';
import { RuleExtractor } from './rules.ts';
import { BotChannel } from './sim/bots.ts';
import { JobStore } from './check/jobs.ts';
import { CheckService } from './check/checkService.ts';
import { supplierKey } from './tools/suppliers.ts';
import type { PhotoCount, PhotoCounter } from './check/photoCount.ts';

const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const USER_GAS_TOPUP = parseEther('0.0005'); // planned OKB top-up per owner / rider
const vaultAbi = parseAbi([
  'function deposit(uint256)', 'function queueSupplier(bytes32,uint8,address)', 'function applySupplier(bytes32)', 'function postBond(uint256)',
  'function riderPickup(uint256,bool,uint8)', 'function riderArrive(uint256,bool)', 'function ownerConfirm(uint256,bool,bool)',
]);
class Scripted implements PhotoCounter { queue: PhotoCount[] = []; async count() { return this.queue.shift() ?? null; } }
const seen = (count: number): PhotoCount => ({ itemVisible: true, count, confidence: 'high', damage: false, damageNotes: '', photoProblem: 'none' });
const PHOTO = { data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9]), mediaType: 'image/jpeg' as const };

const port = 19545 + Math.floor(Math.random() * 400);
const url = `http://127.0.0.1:${port}`;
const upstream = envValue(process.env, 'XLAYER_RPC') ?? 'https://rpc.xlayer.tech';
const anvil = spawn(ANVIL, ['--fork-url', upstream, '--port', String(port)], { stdio: process.env.ANVIL_LOG ? ['ignore', (await import('node:fs')).openSync(process.env.ANVIL_LOG, 'w'), 'inherit'] : 'ignore' });
const stop = () => anvil.kill();
process.on('exit', stop);

try {
  for (let i = 0; ; i++) {
    try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) break; } catch { /* starting */ }
    if (i > 200) throw new Error('fork did not start'); await new Promise((r) => setTimeout(r, 150));
  }
  const payoutForRehearsal = envValue(process.env, 'SUPPLIER_PAYOUT_ADDRESS') ?? privateKeyToAccount(generatePrivateKey()).address;
  const p = await xlayerPlatform({ ...process.env, XLAYER_RPC: url, SUPPLIER_PAYOUT_ADDRESS: payoutForRehearsal });
  console.log(`fork of X Layer at block ${await p.pub.getBlockNumber()}; processor ${p.circuits}; ${p.money.describe}; 1 circuit unit = ${Number(p.unit) / 1e6} ${p.tokenSymbol}`);

  const test = createTestClient({ chain: xLayer, mode: 'anvil', transport: http(url) });
  const okb = async (a: Address) => formatEther(await p.pub.getBalance({ address: a }));
  const usdt = async (a: Address) => Number(await p.pub.readContract({ address: p.token, abi: tokenAbi, functionName: 'balanceOf', args: [a] })) / 1e6;
  const send = async (h: Promise<Hex>) => { const r = await p.pub.waitForTransactionReceipt({ hash: await h }); if (r.status !== 'success') throw new Error('tx reverted'); return r; };

  // Agent and check-service wallets are new: give them the OKB we plan to send them for real.
  for (const w of [p.agent, p.checker]) await test.setBalance({ address: w.account.address, value: parseEther('0.005') });
  const owner = privateKeyToAccount(generatePrivateKey()), rider = privateKeyToAccount(generatePrivateKey());
  for (const a of [owner, rider]) await test.setBalance({ address: a.address, value: USER_GAS_TOPUP });
  // USDT0's storage layout defeats anvil_dealERC20, so on the fork only we borrow from an existing holder.
  const HOLDER: Address = '0xE64B0f1a50ba340426861F29327E9EAa7fb404AD';
  await test.impersonateAccount({ address: HOLDER });
  await test.setBalance({ address: HOLDER, value: parseEther('1') });
  const holder = createWalletClient({ account: HOLDER, chain: xLayer, transport: http(url) });
  const transferAbi = parseAbi(['function transfer(address,uint256) returns (bool)']);
  await send(holder.writeContract({ address: p.token, abi: transferAbi, functionName: 'transfer', args: [owner.address, 200_000_000n] }));
  await send(holder.writeContract({ address: p.token, abi: transferAbi, functionName: 'transfer', args: [rider.address, 100_000_000n] }));
  await test.stopImpersonatingAccount({ address: HOLDER });
  const okb0 = { deployer: await p.pub.getBalance({ address: p.deployer.account.address }) };

  // 1. Shop vault: weekly budget ₦300,000, auto-approve up to ₦100,000.
  const vault = await deployVault(p, owner.address, 300_000, 100_000);
  const deployCost = okb0.deployer - await p.pub.getBalance({ address: p.deployer.account.address });
  console.log(`vault ${vault} deployed; cost ${formatEther(deployCost)} OKB`);

  // 2. Owner: deposit 150 USDT0, approve one supplier (24 h wait).
  const ow = createWalletClient({ account: owner, chain: xLayer, transport: http(url) });
  await send(ow.writeContract({ address: p.token, abi: tokenAbi, functionName: 'approve', args: [vault, 2n ** 255n] }));
  await send(ow.writeContract({ address: vault, abi: vaultAbi, functionName: 'deposit', args: [150_000_000n] }));
  await send(ow.writeContract({ address: vault, abi: vaultAbi, functionName: 'queueSupplier', args: [supplierKey('sim-mile12-adeyemi'), 1, p.supplierPayout] }));
  await test.increaseTime({ seconds: 86_400 }); await test.mine({ blocks: 1 });
  await send(ow.writeContract({ address: vault, abi: vaultAbi, functionName: 'applySupplier', args: [supplierKey('sim-mile12-adeyemi')] }));

  // 3. Rider: bond 80 USDT0 in this vault.
  const rw = createWalletClient({ account: rider, chain: xLayer, transport: http(url) });
  await send(rw.writeContract({ address: p.token, abi: tokenAbi, functionName: 'approve', args: [vault, 2n ** 255n] }));
  await send(rw.writeContract({ address: vault, abi: vaultAbi, functionName: 'postBond', args: [80_000_000n] }));

  // 4. Agent: order from text; RestockGuard (#1, real circuit) decides.
  const jobs = new JobStore();
  const r = await handleOrder('5 cartons of Indomie within 5 km', {
    extractor: new RuleExtractor(), channel: new BotChannel(), vault: new VaultClient(vault, p.pub, p.agent), jobs, money: p.money,
    shop: { name: 'Rehearsal shop, Ojota', lat: 6.587, lng: 3.381 },
    riders: [{ id: 'r1', name: 'Rehearsal rider', address: rider.address, lat: 6.6, lng: 3.39 }],
  });
  const o = r.outcomes[0];
  if (o.kind !== 'proposed' || o.result.status !== 'locked') throw new Error(`order did not lock: ${JSON.stringify(o, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}`);
  const id = o.result.orderId;
  console.log(`order #${id} locked by RestockGuard: ${o.deal.unitPriceNaira} naira x 5`);

  // 5. Pickup: rider counts 5, photo shows 5 -> PickupCheck (#2) pays the supplier.
  const counter = new Scripted();
  const check = new CheckService(vault, p.pub, p.checker, counter, jobs);
  const payoutBefore = await usdt(p.supplierPayout);
  await send(rw.writeContract({ address: vault, abi: vaultAbi, functionName: 'riderPickup', args: [id, true, 5] }));
  counter.queue.push(seen(5));
  const pick = await check.pickup(id, PHOTO);
  console.log(`pickup: ${JSON.stringify(pick, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}`);
  if (pick.status !== 'settled' || pick.outcome !== 'paid') throw new Error('pickup did not pay');
  console.log(`supplier payout received ${(await usdt(p.supplierPayout) - payoutBefore).toFixed(6)} USDT0`);

  // 6. Delivery: rider arrives, photo shows 5, owner confirms -> DeliveryCheck (#3) pays the rider.
  await send(rw.writeContract({ address: vault, abi: vaultAbi, functionName: 'riderArrive', args: [id, true] }));
  await send(ow.writeContract({ address: vault, abi: vaultAbi, functionName: 'ownerConfirm', args: [id, true, false] }));
  const riderBefore = await usdt(rider.address);
  counter.queue.push(seen(5));
  const del = await check.delivery(id, PHOTO);
  console.log(`delivery: ${JSON.stringify(del, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}`);
  if (del.status !== 'settled' || del.outcome !== 'rider_paid') throw new Error('delivery did not pay the rider');
  console.log(`rider fee received ${(await usdt(rider.address) - riderBefore).toFixed(6)} USDT0`);

  console.log('\nOKB left of the planned top-ups:');
  console.log(`  owner  ${await okb(owner.address)} of ${formatEther(USER_GAS_TOPUP)}`);
  console.log(`  rider  ${await okb(rider.address)} of ${formatEther(USER_GAS_TOPUP)}`);
  console.log(`  agent  ${await okb(p.agent.account.address)} of 0.005`);
  console.log(`  check  ${await okb(p.checker.account.address)} of 0.005`);
  console.log('\nREHEARSAL PASSED (local fork only; nothing was sent to X Layer).');
} finally { stop(); }
