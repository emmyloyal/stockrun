// Rehearsal of the mainnet setup on a LOCAL FORK of X Layer (nothing is sent to the real network):
// the real taped-out circuits (#1-#3), real USDT0, the real deployer/agent/check-service keys from .env, a vault for a
// throwaway owner, and one order from text to rider paid. Owner and rider get only the small gas top-up we plan to
// give real users, so this also shows whether that top-up is enough.
//   npm run rehearse:xlayer
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createTestClient, createWalletClient, http, parseAbi, parseEther, parseGwei, formatEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ANVIL } from './sim/localChain.ts';
import { xlayerPlatform, xLayerChain, xlayerFees, deployVault, envValue, tokenAbi } from './chain/platform.ts';
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

const AGENT_FUND = parseEther('0.001'), CHECK_FUND = parseEther('0.002'); // what we send the service keys on mainnet
const USER_GAS_TOPUP = parseEther('0.00005'); // planned OKB top-up per owner / rider
const vaultAbi = parseAbi([
  'function deposit(uint256)', 'function queueSupplier(bytes32,uint8,address)', 'function applySupplier(bytes32)',
  'function riderPickup(uint256,bool,uint8)', 'function riderArrive(uint256,bool)', 'function ownerConfirm(uint256,bool,bool)',
]);
class Scripted implements PhotoCounter { queue: PhotoCount[] = []; async count() { return this.queue.shift() ?? null; } }
const seen = (count: number): PhotoCount => ({ itemVisible: true, count, confidence: 'high', damage: false, damageNotes: '', photoProblem: 'none' });
const PHOTO = { data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9]), mediaType: 'image/jpeg' as const };

const port = 19545 + Math.floor(Math.random() * 400);
const url = `http://127.0.0.1:${port}`;
// A cold fork fetches each storage slot from the upstream RPC (~1.3 s apiece), so one call can take well over 10 s.
const FORK_HTTP = { timeout: 120_000 };
const upstream = envValue(process.env, 'XLAYER_RPC') ?? 'https://rpc.xlayer.tech';
// --block-time: a forked anvil can answer sendRawTransaction before it has mined, and with automine alone no later block
// ever comes, so viem would wait forever for a tx it already saw pending. Real X Layer keeps producing blocks.
const anvil = spawn(ANVIL, ['--fork-url', upstream, '--port', String(port), '--block-time', '1'], { stdio: process.env.ANVIL_LOG ? ['ignore', (await import('node:fs')).openSync(process.env.ANVIL_LOG, 'w'), 'inherit'] : 'ignore' });
const stop = () => anvil.kill();
process.on('exit', stop);

try {
  for (let i = 0; ; i++) {
    try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) break; } catch { /* starting */ }
    if (i > 200) throw new Error('fork did not start'); await new Promise((r) => setTimeout(r, 150));
  }
  const payoutForRehearsal = envValue(process.env, 'SUPPLIER_PAYOUT_ADDRESS') ?? privateKeyToAccount(generatePrivateKey()).address;
  const p = await xlayerPlatform({ ...process.env, XLAYER_RPC: url, RPC_TIMEOUT_MS: '120000', SUPPLIER_PAYOUT_ADDRESS: payoutForRehearsal });
  console.log(`fork of X Layer at block ${await p.pub.getBlockNumber()}; processor ${p.circuits}; ${p.money.describe}; 1 circuit unit = ${Number(p.unit) / 1e6} ${p.tokenSymbol}`);

  const forkBlock = await p.pub.getBlockNumber();
  const test = createTestClient({ chain: xLayerChain, mode: 'anvil', transport: http(url, FORK_HTTP) });
  const usdt = async (a: Address) => Number(await p.pub.readContract({ address: p.token, abi: tokenAbi, functionName: 'balanceOf', args: [a] })) / 1e6;
  const send = async (h: Promise<Hex>) => { const r = await p.pub.waitForTransactionReceipt({ hash: await h }); if (r.status !== 'success') throw new Error('tx reverted'); return r; };

  // Agent and check-service wallets are new: give them the OKB we plan to send them for real.
  await test.setBalance({ address: p.agent.account.address, value: AGENT_FUND });
  await test.setBalance({ address: p.checker.account.address, value: CHECK_FUND });
  const owner = privateKeyToAccount(generatePrivateKey()), rider = privateKeyToAccount(generatePrivateKey());
  for (const a of [owner, rider]) await test.setBalance({ address: a.address, value: USER_GAS_TOPUP });
  // USDT0's storage layout defeats anvil_dealERC20, so on the fork only we borrow from an existing holder.
  const HOLDER: Address = '0xE64B0f1a50ba340426861F29327E9EAa7fb404AD';
  await test.impersonateAccount({ address: HOLDER });
  await test.setBalance({ address: HOLDER, value: parseEther('1') });
  const holder = createWalletClient({ account: HOLDER, chain: xLayerChain, transport: http(url, FORK_HTTP) });
  const transferAbi = parseAbi(['function transfer(address,uint256) returns (bool)']);
  await send(holder.writeContract({ address: p.token, abi: transferAbi, functionName: 'transfer', args: [owner.address, 200_000_000n] }));
  await send(holder.writeContract({ address: p.token, abi: transferAbi, functionName: 'transfer', args: [rider.address, 100_000_000n] }));
  await test.stopImpersonatingAccount({ address: HOLDER });
  const okb0 = { deployer: await p.pub.getBalance({ address: p.deployer.account.address }) };

  // 1. Shop vault: weekly budget ₦300,000, auto-approve up to ₦100,000.
  const vault = await deployVault(p, owner.address, 300_000, 100_000, [rider.address]);  // rider = the shop's logistics company
  const deployCost = okb0.deployer - await p.pub.getBalance({ address: p.deployer.account.address });
  console.log(`vault ${vault} deployed; cost ${formatEther(deployCost)} OKB on the fork`);

  // 2. Owner: deposit 150 USDT0, approve one supplier (24 h wait).
  const ow = createWalletClient({ account: owner, chain: xLayerChain, transport: http(url, FORK_HTTP) });
  await send(ow.writeContract({ address: p.token, abi: tokenAbi, functionName: 'approve', args: [vault, 2n ** 255n] }));
  await send(ow.writeContract({ address: vault, abi: vaultAbi, functionName: 'deposit', args: [150_000_000n] }));
  await send(ow.writeContract({ address: vault, abi: vaultAbi, functionName: 'queueSupplier', args: [supplierKey('sim-mile12-adeyemi'), 1, p.supplierPayout] }));
  await test.increaseTime({ seconds: 86_400 }); await test.mine({ blocks: 1 });
  await send(ow.writeContract({ address: vault, abi: vaultAbi, functionName: 'applySupplier', args: [supplierKey('sim-mile12-adeyemi')] }));

  // 3. Logistics company: trusted by this vault from set-up; no bond.
  const rw = createWalletClient({ account: rider, chain: xLayerChain, transport: http(url, FORK_HTTP) });

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

  // Gas used per wallet, priced at the most our fee rule lets mainnet charge (base 0.02 gwei x 1.25 + tip). The fork's
  // own base fee drifts down over empty blocks, so its OKB balances would understate the real cost.
  const worst = xlayerFees(parseGwei('0.02')).maxFeePerGas;
  const used = new Map<string, bigint>();
  for (let n = forkBlock + 1n, end = await p.pub.getBlockNumber(); n <= end; n++) {
    for (const h of (await p.pub.getBlock({ blockNumber: n })).transactions) {
      const rc = await p.pub.getTransactionReceipt({ hash: h });
      used.set(rc.from.toLowerCase(), (used.get(rc.from.toLowerCase()) ?? 0n) + rc.gasUsed);
    }
  }
  const row = (name: string, a: Address, budget?: bigint) => {
    const g = used.get(a.toLowerCase()) ?? 0n, cost = g * worst;
    console.log(`  ${name.padEnd(8)} ${String(g).padStart(9)} gas = ${formatEther(cost)} OKB at mainnet price` +
      (budget ? `; planned ${formatEther(budget)} OKB covers this ${budget / (cost || 1n)}x` : ''));
    if (budget && cost > budget) throw new Error(`${name} top-up of ${formatEther(budget)} OKB is too small`);
  };
  console.log('\nGas used (one shop set-up + one order):');
  row('deployer', p.deployer.account.address);
  row('owner', owner.address, USER_GAS_TOPUP);
  row('rider', rider.address, USER_GAS_TOPUP);
  row('agent', p.agent.account.address, AGENT_FUND);
  row('check', p.checker.account.address, CHECK_FUND);
  console.log('\nREHEARSAL PASSED (local fork only; nothing was sent to X Layer).');
} finally { stop(); }
