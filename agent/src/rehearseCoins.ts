// Rehearse a coin order end to end on a FORK of X Layer mainnet: the real server over HTTP, the real taped-out
// circuits, real USDT0 (moved on the fork from a holder), and a fresh buyer wallet that starts with NO OKB, so
// StockRun's one-off gas top-up must cover everything the buyer signs. Nothing is sent to mainnet.
//
//   npm run rehearse:coins      (needs anvil and the mainnet keys in .env; they only sign on the fork)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createTestClient, createWalletClient, formatEther, http, parseAbi, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ANVIL } from './sim/localChain.ts';
import { xlayerPlatform, xLayerChain, envValue, tokenAbi, circuitEvaluator } from './chain/platform.ts';
import { createApp } from './server/app.ts';
import { Accounts, ConsoleSms, openDb } from './accounts/accounts.ts';
import { ConsoleEmail } from './accounts/email.ts';
import { Buyers } from './buyers/buyers.ts';
import { RuleExtractor } from './rules.ts';
import { BotChannel } from './sim/bots.ts';
import { PriceBook } from './prices/priceBook.ts';
import { Ledger } from './money/ledger.ts';
import { NairaOrders } from './orders/nairaOrders.ts';
import { foundTable } from './discovery/hunt.ts';
import { CoinOrders } from './coins/coinOrders.ts';

const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const CAP_USD = 50;
const ownerAbi = parseAbi([
  'function approve(address,uint256) returns (bool)', 'function deposit(uint256)', 'function queueSupplier(bytes32,uint8,address)',
  'function riderPickup(uint256,bool,uint8)', 'function withdraw(uint256)', 'function locked() view returns (uint256)', 'error OverCap()',
]);
const port = 19945 + Math.floor(Math.random() * 400), url = `http://127.0.0.1:${port}`;
const upstream = envValue(process.env, 'XLAYER_RPC') ?? 'https://rpc.xlayer.tech';
const anvil = spawn(ANVIL, ['--fork-url', upstream, '--port', String(port), '--block-time', '1'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill());
const ok = (cond: unknown, what: string) => { if (!cond) throw new Error(`FAILED: ${what}`); console.log(`✓ ${what}`); };

try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })).ok) break; } catch { /* starting */ }
    if (i > 200) throw new Error('fork did not start'); await new Promise((r) => setTimeout(r, 150));
  }
  const p = await xlayerPlatform({ ...process.env, XLAYER_RPC: url, RPC_TIMEOUT_MS: '120000' });
  console.log(`fork of X Layer at block ${await p.pub.getBlockNumber()}; processor ${p.circuits}; ${p.money.describe}`);
  const test = createTestClient({ chain: xLayerChain, mode: 'anvil', transport: http(url, { timeout: 120_000 }) });
  const usdt = async (a: Address) => Number(await p.pub.readContract({ address: p.token, abi: tokenAbi, functionName: 'balanceOf', args: [a] })) / 1e6;
  // The service keys hold only what they hold on mainnet today (the fork copies their balances).
  for (const [k, w] of [['deployer', p.deployer], ['agent', p.agent], ['check service', p.checker]] as const)
    console.log(`  ${k} ${w.account.address}: ${formatEther(await p.pub.getBalance({ address: w.account.address }))} OKB`);

  // The server, exactly as main.ts builds it for coins (memory DB, no Paystack).
  const db = openDb(), ledger = new Ledger(db);
  let buyers: Buyers;
  const orders = new NairaOrders({ db, ledger, evalCircuit: circuitEvaluator(p), supplierStatus: (k, u) => buyers.sellerStatus(k, u), carriers: () => buyers.carrierKeys() });
  buyers = new Buyers(db, p, ledger, orders, { extractor: new RuleExtractor(), channel: new BotChannel(), prices: new PriceBook(), foundDb: db });
  foundTable(db);
  db.prepare("INSERT INTO found_sellers (id, name, address, lat, lng, phone, source, source_url, found_at, kind) VALUES ('found-00000000000000d4', 'Agora Marketplace', 'Egbe, Lagos', 6.6050, 3.3900, '+2349079579400', 'osm', 'https://www.openstreetmap.org/node/1', 0, 'supermarket')").run();
  // StockRun's 1.5% deposit fee goes to the payout wallet (main.ts's default COIN_FEE_ADDRESS).
  const coins = new CoinOrders({ db, platform: p, capTokens: BigInt(CAP_USD * 1e6), log: (l) => console.log(`  [server] ${l}`), fee: { recipient: p.supplierPayout, bps: 150 } });
  const server = createApp({ platform: p, accounts: new Accounts(db, new ConsoleSms(), 'x'.repeat(40), Date.now, null, new ConsoleEmail()), buyers, ledger, prices: new PriceBook(), paystack: null, coins });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, json: await r.json() as any };
  };

  // A new buyer: a fresh wallet with 0 OKB and $60 of real USDT0 (moved on the fork from a holder).
  const buyer = privateKeyToAccount(generatePrivateKey());
  const HOLDER: Address = '0xE64B0f1a50ba340426861F29327E9EAa7fb404AD';
  await test.impersonateAccount({ address: HOLDER }); await test.setBalance({ address: HOLDER, value: parseEther('1') });
  const holder = createWalletClient({ account: HOLDER, chain: xLayerChain, transport: http(url, { timeout: 120_000 }) });
  await p.pub.waitForTransactionReceipt({ hash: await holder.writeContract({ address: p.token, abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [buyer.address, 60_000_000n] }) });
  await test.stopImpersonatingAccount({ address: HOLDER });
  const { message } = (await call(`/api/auth/wallet-message?address=${buyer.address}`)).json;
  ok((await call('/api/auth/wallet', { message, signature: await buyer.signMessage({ message }) })).status === 200, 'buyer signs in with their wallet');

  const deployerBefore = await p.pub.getBalance({ address: p.deployer.account.address });
  const set = (await call('/api/coins/vault', {})).json;
  ok(set.created && set.vault, `StockRun deployed the buyer's vault ${set.vault}`);
  console.log(`  deploy + gas top-up cost StockRun ${formatEther(deployerBefore - await p.pub.getBalance({ address: p.deployer.account.address }))} OKB`);
  const vault = set.vault as Address;
  const bw = createWalletClient({ account: buyer, chain: xLayerChain, transport: http(url, { timeout: 120_000 }) });
  const sign = async (address: Address, functionName: 'approve' | 'deposit' | 'queueSupplier' | 'riderPickup' | 'withdraw', args: readonly unknown[]) => {
    const r = await p.pub.waitForTransactionReceipt({ hash: await bw.writeContract({ address, abi: ownerAbi, functionName, args: args as never }) as Hex });
    if (r.status !== 'success') throw new Error(`${functionName} reverted`);
  };

  const feeBefore = await usdt(p.supplierPayout), walletBefore = await usdt(buyer.address);
  await sign(p.token, 'approve', [vault, 40_600_000n]);                      // $40 + StockRun's 1.5% ($0.60) on top
  await sign(vault, 'deposit', [40_000_000n]);
  ok(await usdt(vault) === 40, 'buyer deposited $40 of USDT0 into their vault');
  ok(Math.abs(await usdt(p.supplierPayout) - feeBefore - 0.6) < 1e-9 && Math.abs(walletBefore - await usdt(buyer.address) - 40.6) < 1e-9,
    'StockRun\'s 1.5% ($0.60) was paid on top, straight to StockRun\'s wallet, in the same transaction');
  await sign(p.token, 'approve', [vault, 20_300_000n]);
  const over = await bw.writeContract({ address: vault, abi: ownerAbi, functionName: 'deposit', args: [20_000_000n] }).then(() => false, (e: Error) => /OverCap/.test(e.message));
  ok(over, 'a further $20 is refused on-chain: the vault holds at most $50');

  const rate = p.money.toNaira(1_000_000n);   // naira per dollar on this server
  const unitNaira = Math.floor((5 * rate) / 1000) * 1000 || 1000;  // about $5 a carton
  const deal = { sellerId: 'found-00000000000000d4', item: 'Indomie carton', quantity: 4, unit: 'carton', unitPriceNaira: unitNaira, category: 'staples', place: { lat: 6.6045, lng: 3.3891, address: 'Ketu, Lagos' } };
  const first = (await call('/api/coins/deals', deal)).json;
  ok(first.status === 'needs_seller' && first.payout === p.supplierPayout, 'new seller: the server asks the wallet to approve them first');
  await sign(vault, 'queueSupplier', [first.seller.key, 1, first.payout]);
  const placed = (await call('/api/coins/deals', deal)).json;
  ok(placed.status === 'locked', `RestockGuard (real circuit #1) locked the order inside the vault: ${placed.message}`);
  const locked = Number(await p.pub.readContract({ address: vault, abi: ownerAbi, functionName: 'locked' })) / 1e6;
  console.log(`  locked in the vault: $${locked}`);

  await sign(vault, 'riderPickup', [0n, true, 3]);
  const payoutBefore = await usdt(p.supplierPayout);
  const settled = (await call('/api/coins/orders/0/settle-pickup', {})).json;
  ok(settled.outcome === 'paid_part' && settled.qty === 3, `PickupCheck (real circuit #2) paid for 3 of 4 (${settled.tx})`);
  const paid = await usdt(p.supplierPayout) - payoutBefore;
  ok(Math.abs(paid - locked * 3 / 4) < 0.000002, `StockRun's payout wallet received $${paid.toFixed(6)} USDT0 from the vault`);
  ok(Number(await p.pub.readContract({ address: vault, abi: ownerAbi, functionName: 'locked' })) === 0, 'the 4th carton\'s coins are free again');

  const [o] = (await call('/api/orders')).json;
  ok(o.money === 'coins' && o.status === 'Delivered' && o.sellerOwedNaira > 0, `order shows in the app; StockRun owes the seller ₦${o.sellerOwedNaira}`);
  const free = await usdt(vault);
  await sign(vault, 'withdraw', [BigInt(Math.round(free * 1e6))]);
  ok(await usdt(vault) === 0, `buyer withdrew the remaining $${free} to their wallet`);
  console.log(`  buyer's wallet OKB left from the one-off top-up: ${formatEther(await p.pub.getBalance({ address: buyer.address }))}`);
  server.close();
  console.log('\nCoin rehearsal passed on the X Layer fork.');
} finally {
  anvil.kill();
}
process.exit(0);
