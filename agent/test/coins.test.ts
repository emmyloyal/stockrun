// Coin orders over HTTP on a local chain: the buyer's own vault, owned by their wallet. StockRun deploys it; the
// buyer's wallet deposits (capped), approves the seller (instant through StockRun's payout wallet) and signs their
// count; RestockGuard and PickupCheck decide inside the vault. The server never holds or moves the coins itself.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createWalletClient, http, parseAbi, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { createApp } from '../src/server/app.ts';
import { Accounts, ConsoleSms, openDb } from '../src/accounts/accounts.ts';
import { ConsoleEmail } from '../src/accounts/email.ts';
import { Buyers } from '../src/buyers/buyers.ts';
import { circuitEvaluator, localPlatform, tokenAbi, type Platform } from '../src/chain/platform.ts';
import { startLocalChain, localChainAvailable, type LocalChain } from '../src/sim/localChain.ts';
import { RuleExtractor } from '../src/rules.ts';
import { BotChannel } from '../src/sim/bots.ts';
import { PriceBook } from '../src/prices/priceBook.ts';
import { Ledger } from '../src/money/ledger.ts';
import { NairaOrders } from '../src/orders/nairaOrders.ts';
import { foundTable } from '../src/discovery/hunt.ts';
import { CoinOrders } from '../src/coins/coinOrders.ts';

const MILE12 = { lat: 6.6045, lng: 3.3891, address: '12 Ikorodu Road, Ketu, Lagos' };
const ownerAbi = parseAbi([
  'function deposit(uint256 amount)', 'function queueSupplier(bytes32 id, uint8 status_, address payout_)',
  'function riderPickup(uint256 id, bool atSupplier, uint8 riderCount)', 'function withdraw(uint256 amount)',
  'function locked() view returns (uint256)', 'function owner() view returns (address)', 'error OverCap()',
]);

describe.skipIf(!localChainAvailable())('coin orders through the buyer\'s own vault', () => {
  let chain: LocalChain; let p: Platform; let server: Server; let base: string;
  const CAP_NAIRA = 75_000;
  const FEE_WALLET = privateKeyToAccount(generatePrivateKey()).address;   // StockRun's fee wallet for this test

  function person() {
    let cookie = '';
    const call = async (path: string, body?: unknown) => {
      const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      const text = await r.text();
      return { status: r.status, json: (() => { try { return JSON.parse(text); } catch { return text; } })() as any };
    };
    return { call };
  }
  async function walletUser() {
    const key = generatePrivateKey(), account = privateKeyToAccount(key), who = person();
    const { message } = (await who.call(`/api/auth/wallet-message?address=${account.address}`)).json;
    expect((await who.call('/api/auth/wallet', { message, signature: await account.signMessage({ message }) })).status).toBe(200);
    await p.faucet!(account.address);                                       // test token and gas: local chain only
    const wallet = createWalletClient({ account, chain: anvil, transport: http(chain.url) });
    const send = async (address: Address, abi: typeof ownerAbi | typeof tokenAbi, functionName: string, args: unknown[]) => {
      const hash = await wallet.writeContract({ address, abi: abi as never, functionName: functionName as never, args: args as never });
      const r = await p.pub.waitForTransactionReceipt({ hash });
      expect(r.status).toBe('success');
    };
    return { ...who, account, send };
  }
  const balance = (a: Address) => p.pub.readContract({ address: p.token, abi: tokenAbi, functionName: 'balanceOf', args: [a] });

  beforeAll(async () => {
    chain = await startLocalChain();
    p = localPlatform(chain);
    const db = openDb(), ledger = new Ledger(db);
    let buyers: Buyers;
    const orders = new NairaOrders({ db, ledger, evalCircuit: circuitEvaluator(p), supplierStatus: (k, u) => buyers.sellerStatus(k, u), carriers: () => buyers.carrierKeys() });
    buyers = new Buyers(db, p, ledger, orders, { extractor: new RuleExtractor(), channel: new BotChannel(), prices: new PriceBook(), foundDb: db });
    foundTable(db);
    db.prepare("INSERT INTO found_sellers (id, name, address, lat, lng, phone, source, source_url, found_at, kind) VALUES (?, ?, ?, ?, ?, ?, 'osm', 'https://www.openstreetmap.org/node/1', 0, 'supermarket')")
      .run('found-00000000000000c3', 'Agora Marketplace', 'Egbe, Lagos', 6.6050, 3.3900, '+2349079579400');
    const coins = new CoinOrders({ db, platform: p, capTokens: p.money.toToken(CAP_NAIRA), fee: { recipient: FEE_WALLET, bps: 150 } });
    server = createApp({ platform: p, accounts: new Accounts(db, new ConsoleSms(), 'x'.repeat(40), Date.now, null, new ConsoleEmail()), buyers, ledger, prices: new PriceBook(), paystack: null, coins });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(() => { server?.close(); chain?.stop(); });

  it('set up, deposit under the cap, approve the seller at once, order, count at pickup: the vault pays what was counted', async () => {
    const ada = await walletUser();
    expect((await ada.call('/api/config')).json.coins).toMatchObject({ capNaira: CAP_NAIRA, payout: p.supplierPayout });
    const deal = { sellerId: 'found-00000000000000c3', item: 'Indomie carton', quantity: 4, unit: 'carton', unitPriceNaira: 10_000, category: 'staples', place: MILE12 };
    expect((await ada.call('/api/coins/deals', deal)).status).toBe(409);                                // no vault yet

    const set = (await ada.call('/api/coins/vault', {})).json;
    expect(set.created).toBe(true);
    const vault = set.vault as Address;
    expect(await p.pub.readContract({ address: vault, abi: ownerAbi, functionName: 'owner' })).toBe(ada.account.address);
    expect((await ada.call('/api/coins/vault', {})).json).toMatchObject({ vault, created: false });       // once per buyer

    // Deposit from the buyer's own wallet; the cap is enforced by the vault itself. StockRun's 1.5% is paid on top,
    // straight to StockRun's fee wallet, in the same transaction; the vault gets the full deposit.
    const walletBefore = await balance(ada.account.address);
    await ada.send(p.token, tokenAbi, 'approve', [vault, p.money.toToken(1_000_000)]);
    await ada.send(vault, ownerAbi, 'deposit', [p.money.toToken(60_000)]);
    await expect(ada.send(vault, ownerAbi, 'deposit', [p.money.toToken(20_000)])).rejects.toThrow(/OverCap/);
    expect((await ada.call('/api/me/coins')).json.vault).toMatchObject({ vault, depositFeeBps: 150, naira: { balance: 60_000, free: 60_000 } });
    expect(await balance(FEE_WALLET)).toBe(p.money.toToken(900));                                       // 1.5% of 60,000
    expect(walletBefore - await balance(ada.account.address)).toBe(p.money.toToken(60_900));

    // First try: the seller is not in the vault yet, so nothing is proposed; the wallet approves them (instant).
    const first = (await ada.call('/api/coins/deals', deal)).json;
    expect(first).toMatchObject({ status: 'needs_seller', payout: p.supplierPayout });
    await ada.send(vault, ownerAbi, 'queueSupplier', [first.seller.key, 1, first.payout]);

    const placed = (await ada.call('/api/coins/deals', deal)).json;
    expect(placed).toMatchObject({ status: 'locked', orderId: 'coin-0', tx: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(await p.pub.readContract({ address: vault, abi: ownerAbi, functionName: 'locked' })).toBe(p.money.toToken(40_000));

    // The server cannot settle before the buyer's wallet signs the count.
    expect((await ada.call('/api/coins/orders/0/settle-pickup', {})).status).toBe(409);
    await ada.send(vault, ownerAbi, 'riderPickup', [0n, true, 3]);                    // 3 of 4 cartons
    const payoutBefore = await balance(p.supplierPayout);
    const settled = (await ada.call('/api/coins/orders/0/settle-pickup', {})).json;
    expect(settled).toMatchObject({ status: 'settled', outcome: 'paid_part', qty: 3 });
    expect(await balance(p.supplierPayout) - payoutBefore).toBe(p.money.toToken(30_000));      // paid by the vault
    expect(await p.pub.readContract({ address: vault, abi: ownerAbi, functionName: 'locked' })).toBe(0n);

    const [o] = (await ada.call('/api/orders')).json;
    expect(o).toMatchObject({ orderId: 'coin-0', money: 'coins', status: 'Delivered', ordered: 4, pickup: { picked: 3 }, sellerOwedNaira: 30_000 });
    expect(o.txs.map((t: { label: string }) => t.label)).toEqual(['RestockGuard locked it', 'PickupCheck paid']);
    expect((await ada.call('/api/me/coins')).json.vault.naira).toEqual({ balance: 30_000, free: 30_000 });
  }, 120_000);

  it('another person cannot use or settle someone else\'s coin order', async () => {
    const bisi = await walletUser();
    expect((await bisi.call('/api/coins/orders/0/settle-pickup', {})).status).toBe(409);   // no coin account
    await bisi.call('/api/coins/vault', {});
    expect((await bisi.call('/api/coins/orders/0/settle-pickup', {})).status).toBe(404);   // not her order
  }, 120_000);

  it('an email-only account has to connect a wallet first', async () => {
    const who = person();
    expect((await who.call('/api/coins/vault', {})).status).toBe(401);
  });
});
