// The real multi-shop StockRun server: email or wallet sign-in, one vault per shop owner, buyers deposit from their own phone key
// and then tell the agent what to buy.
//   npm run serve            local anvil chain, test money, emailed sign-in codes printed here (for trying the app)
//   npm run serve:xlayer     X Layer MAINNET: real USDT0, the taped-out circuits, real gas
// X Layer needs in ../.env: DEPLOYER_PRIVATE_KEY, AGENT_PRIVATE_KEY, CHECK_SERVICE_PRIVATE_KEY, SUPPLIER_PAYOUT_ADDRESS,
// NGN_PER_USD, SERVER_SECRET (32+ characters), and the GMAIL_* keys for emailed sign-in codes (or SMS=console to print them). Optional: GEMINI_API_KEY
// (photo check and order reading), APP_PORT (8080), DB_FILE (agent/data/stockrun.db), SECURE_COOKIES=1 behind HTTPS.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatEther } from 'viem';
import { createApp } from './app.ts';
import { Accounts, AuthError, openDb } from '../accounts/accounts.ts';
import { Buyers } from '../buyers/buyers.ts';
import { Ledger } from '../money/ledger.ts';
import { Paystack } from '../money/paystack.ts';
import { NairaOrders } from '../orders/nairaOrders.ts';
import { emailFromEnv } from '../accounts/email.ts';
import { PlacesSearch } from '../discovery/places.ts';
import { OsmSearch } from '../discovery/osm.ts';
import { seedOsmSellers } from '../discovery/hunt.ts';
import { Geocoder } from '../discovery/geocode.ts';
import { Payouts, adminList } from '../admin/payouts.ts';
import { Activity } from '../admin/activity.ts';
import { Withdrawals } from '../money/withdrawals.ts';
import { Controls } from '../admin/controls.ts';
import { CoinOrders } from '../coins/coinOrders.ts';
import { PAYSTACK_LOCAL } from '../money/paystack.ts';
import { Listings } from '../business/listings.ts';
import { Chats } from '../business/chat.ts';
import { Posts } from '../business/posts.ts';
import { loadSuppliers, supplierKey, useDemoSellers } from '../tools/suppliers.ts';
import type { Address, Hash } from 'viem';
import { WebSellerSearch } from '../discovery/webSearch.ts';
import { geminiClient } from '../llm.ts';
import { circuitEvaluator, envValue, localPlatform, xlayerPlatform, type Platform } from '../chain/platform.ts';
import { startLocalChain } from '../sim/localChain.ts';
import { defaultExtractor, model } from '../llm.ts';
import { RuleExtractor } from '../rules.ts';
import { BotChannel } from '../sim/bots.ts';
import { PriceBook } from '../prices/priceBook.ts';

const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;
const network = process.argv.find((a) => a.startsWith('--network='))?.slice(10) ?? envValue(env, 'NETWORK') ?? 'local';
if (network !== 'local' && network !== 'xlayer') throw new Error('NETWORK must be local or xlayer');
// Demo (bot) sellers exist on the local test chain only. On X Layer buyers deal with real sellers and real naira.
useDemoSellers(network === 'local');
const port = Number(envValue(env, 'PORT') ?? envValue(env, 'APP_PORT') ?? 8080);   // PORT: set by hosts such as Render

let stopChain = () => {};
let p: Platform;
if (network === 'xlayer') {
  p = await xlayerPlatform(env);
} else {
  const chain = await startLocalChain();
  stopChain = chain.stop;
  // A Sendrelay TEST key books simulated riders for real on the local chain; a live key is never used here.
  const sr = envValue(env, 'SENDRELAY_API_KEY');
  p = localPlatform(chain, { sendrelayKey: sr?.startsWith('sk_test_') ? sr : undefined });
}

const secret = envValue(env, 'SERVER_SECRET') ?? (network === 'local' ? 'local-only-secret-not-for-real-use-0000000' : undefined);
if (!secret || secret.length < 32) throw new Error('Set SERVER_SECRET in .env (32+ random characters). It protects sign-in codes.');
const { mail, kind: mailKind } = emailFromEnv(env, network === 'local');
// Support address shown in the app: SUPPORT_EMAIL, else StockRun's official support Gmail.
const supportEmail = (envValue(env, 'SUPPORT_EMAIL') ?? 'stockrun.codes@gmail.com').match(/[^\s<>]+@[^\s<>]+\.[^\s<>]+/)?.[0] ?? null;

// Local: a fresh database each run (the chain is fresh too). X Layer: a file (accounts, naira ledger, orders).
const dbFile = network === 'local' ? ':memory:' : envValue(env, 'DB_FILE') ?? fileURLToPath(new URL('../../data/stockrun.db', import.meta.url));
if (dbFile !== ':memory:') mkdirSync(dirname(dbFile), { recursive: true });
const db = openDb(dbFile);
const extractor = defaultExtractor(new RuleExtractor());
const log = (l: string) => console.log(`[server] ${l}`);
const ledger = new Ledger(db);
const prices = new PriceBook();
// Naira orders: the ledger holds the money; circuits #1-#3 decide every payment through eval on the platform's chain.
let buyers: Buyers;
// An optional order fee, paid by the buyer on completed pickups (the seller always gets the full agreed price). Off by
// default (FEE_PERCENT=0): StockRun charges its 1.5% on deposits instead (DEPOSIT_FEE_PERCENT below).
const fee = { bps: Math.round(Number(envValue(env, 'FEE_PERCENT') ?? 0) * 100), minKobo: Math.round(Number(envValue(env, 'FEE_MIN_NAIRA') ?? 100) * 100), maxKobo: Math.round(Number(envValue(env, 'FEE_MAX_NAIRA') ?? 10_000) * 100) };
const orders = new NairaOrders({ db, ledger, fee, evalCircuit: circuitEvaluator(p), supplierStatus: (k, u) => buyers.sellerStatus(k, u), carriers: () => buyers.carrierKeys() });
// data/suppliers.json holds simulated bot sellers, used on the local chain only (see useDemoSellers above).
buyers = new Buyers(db, p, ledger, orders, { extractor, channel: new BotChannel(), prices, log, foundDb: db, sellerHidden: (id: string) => listings.hidden(id), sellerDelayMs: Number(envValue(env, 'SELLER_APPROVAL_DELAY_HOURS') ?? 0) * 3600_000, dataDir: network === 'local' ? null : dirname(dbFile) });
const paystackKey = envValue(env, 'PAYSTACK_SECRET_KEY');
const publicUrl = envValue(env, 'PUBLIC_URL') ?? `http://localhost:${port}`;
// Sign-in is by email or wallet. Phone sign-in is off (no SMS sender); accounts made earlier by phone still work.
const noSms = { send: async () => { throw new AuthError(503, 'Phone sign-in is off. Use email or a wallet.'); } };
const accounts = new Accounts(db, noSms, secret, Date.now, null, mail);
// StockRun's fee: DEPOSIT_FEE_PERCENT (1.5) of every naira deposit, paid by the buyer on top. Paystack's own charge is
// also paid by the buyer on top (PAYSTACK_CHARGE_BUYER=0: StockRun absorbs it). The buyer's balance gets the full deposit.
const depositFeeBps = Math.round(Number(envValue(env, 'DEPOSIT_FEE_PERCENT') ?? 1.5) * 100);
const paystack = paystackKey ? new Paystack(db, ledger, { secretKey: paystackKey, callbackUrl: `${publicUrl}/?deposit=done`,
  depositCharge: envValue(env, 'PAYSTACK_CHARGE_BUYER') === '0' ? null : PAYSTACK_LOCAL, depositFeeBps }) : null;
// Free demo naira and real naira must never share a ledger: a live key refuses DEMO_NAIRA.
if (paystack && !paystack.test && envValue(env, 'DEMO_NAIRA') === '1') throw new Error('DEMO_NAIRA=1 hands out free naira, which would mix with real deposits under a live Paystack key. Remove DEMO_NAIRA from .env.');

// The AI seller hunt: OpenStreetMap shops (free; on unless SELLER_OSM=off), Google Maps listings (GOOGLE_MAPS_API_KEY) and Gemini web search (SELLER_WEB_SEARCH=on, needs
// billing on the Gemini key). Both bill Google per search after their free allowances, so the hunt is capped per day.
const mapsKey = envValue(env, 'GOOGLE_MAPS_API_KEY'), geminiKey = envValue(env, 'GEMINI_API_KEY');
const generate = geminiKey ? geminiClient(geminiKey) : null;
// Registered stores: admin-approved, LISTING_FEE_NAIRA (2,000) every LISTING_DAYS (30), paid from the StockRun balance.
const geocoder = new Geocoder({ log: (l) => log(`address search: ${l}`) });
const listings = new Listings({ db, ledger, geocoder, feeNaira: Number(envValue(env, 'LISTING_FEE_NAIRA') ?? 2_000), periodDays: Number(envValue(env, 'LISTING_DAYS') ?? 30) });
const hunt = {
  db, log, generate, listings,
  places: mapsKey ? new PlacesSearch({ apiKey: mapsKey }) : null,
  osm: envValue(env, 'SELLER_OSM') === 'off' ? null : new OsmSearch(),
  web: generate && envValue(env, 'SELLER_WEB_SEARCH') === 'on' ? new WebSellerSearch({ generate }) : null,
  perUserDaily: Number(envValue(env, 'HUNT_PER_USER_DAILY') ?? 20), siteDaily: Number(envValue(env, 'HUNT_SITE_DAILY') ?? 300),
};

// The 41 Lagos businesses with a mobile number on OpenStreetMap (data/osm-lagos-sellers.json) start on the map.
log(`OpenStreetMap sellers loaded: ${seedOsmSellers(db)} new`);

// Admin: email accounts in ADMIN_EMAILS watch orders and record the bank transfers that pay naira sellers.
const sellerNames = new Map<string, { name: string; phone: string | null }>();
const sellerOf = (key: Hash) => {
  const k = key.toLowerCase();
  if (!sellerNames.has(k)) {                       // refresh: demo sellers plus every seller found so far
    for (const s of loadSuppliers()) sellerNames.set(supplierKey(s.id).toLowerCase(), { name: `${s.name} (demo)`, phone: null });
    for (const f of db.prepare('SELECT id, name, phone FROM found_sellers').all() as unknown as { id: string; name: string; phone: string }[])
      sellerNames.set(supplierKey(f.id).toLowerCase(), { name: f.name, phone: f.phone });
  }
  return sellerNames.get(k) ?? null;
};
// With Paystack on, approved seller payouts go out automatically (test keys move no money); buyers can withdraw.
// Admin controls: pause switches and frozen/muted accounts (they stop money and posts; they never move money).
const controls = new Controls({ db });
const payouts = new Payouts({ db, ledger, sellerOf, paystack, paused: () => controls.paused('payouts') });
// Withdrawals: up to WITHDRAW_DAILY_NAIRA per person a day (500,000); over WITHDRAW_REVIEW_OVER_NAIRA (200,000) an admin approves first.
const nairaEnv = (k: string, d: number) => { const n = Number(envValue(env, k) ?? d); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : d * 100; };
const withdrawals = paystack ? new Withdrawals(db, ledger, paystack, Date.now, { dailyLimitKobo: nairaEnv('WITHDRAW_DAILY_NAIRA', 500_000), reviewOverKobo: nairaEnv('WITHDRAW_REVIEW_OVER_NAIRA', 200_000) }) : null;
// Coin orders through each buyer's own vault. The vault is unaudited, so deposits stop at COIN_VAULT_CAP_USD (default
// $50; on the local chain the test token is naira, so the cap is that many dollars' worth at ₦1,500).
const capUsd = Number(envValue(env, 'COIN_VAULT_CAP_USD') ?? 50);
// StockRun's 1.5% on every coin deposit (COIN_DEPOSIT_FEE_PERCENT), paid on top by the buyer's wallet straight to
// COIN_FEE_ADDRESS (default: StockRun's payout wallet). Fixed in each vault when it is created.
const coinFeeBps = Math.round(Number(envValue(env, 'COIN_DEPOSIT_FEE_PERCENT') ?? 1.5) * 100);
const coinFeeTo = (envValue(env, 'COIN_FEE_ADDRESS') ?? p.supplierPayout) as Address;
const coins = envValue(env, 'COIN_ORDERS') === 'off' || !(capUsd > 0) ? null : new CoinOrders({ db, platform: p, log, fee: coinFeeBps > 0 ? { recipient: coinFeeTo, bps: coinFeeBps } : null,
  capTokens: network === 'xlayer' ? BigInt(Math.round(capUsd * 1e6)) : p.money.toToken(capUsd * 1_500) });
const admins = adminList(envValue(env, 'ADMIN_EMAILS'));

const staticDir = fileURLToPath(new URL('../../../app/dist/', import.meta.url));
const server = createApp({
  platform: p, accounts, buyers, ledger, prices, paystack, hunt, payouts, admins, controls, activity: new Activity(db), withdrawals, coins, linkSecret: secret, publicUrl, supportEmail, geocoder, listings, chats: new Chats({ db, listings }), posts: listings ? new Posts({ db, listings }) : null, demoNaira: network === 'local' || envValue(env, 'DEMO_NAIRA') === '1',
  staticDir: existsSync(staticDir) ? staticDir : undefined,
  secureCookies: envValue(env, 'SECURE_COOKIES') === '1', log,
  sendrelayWebhookSecret: envValue(env, 'SENDRELAY_WEBHOOK_SECRET'),
  // e.g. ALLOWED_ORIGINS=https://1-2-433.tapekit.org (the app on DeWEB), comma-separated
  allowedOrigins: (envValue(env, 'ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
});
// Check open deliveries with each company every 20 s, so the vault keeps up even when webhooks cannot reach us.
let polling = false;
const poll = setInterval(async () => {
  if (polling) return; polling = true;
  try { await buyers.dispatcher.poll(buyers.dispatchSets()); } catch (e) { log(`dispatch poll: ${(e as Error).message}`); }
  try { const n = await payouts.sweep(); if (n) log(`paid ${n} seller payout(s) through Paystack`); } catch (e) { log(`payout sweep: ${(e as Error).message}`); } finally { polling = false; }
}, 20_000);
server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the other server or set APP_PORT.` : `Server error: ${e.message}`);
  stopChain(); process.exit(1);
});
server.listen(port, async () => {
  console.log(`StockRun on http://localhost:${port}  (${network === 'xlayer' ? 'X LAYER MAINNET, real money' : 'local test chain, test money'})`);
  console.log(`Deployer ${p.deployer.account.address}: ${formatEther(await p.pub.getBalance({ address: p.deployer.account.address }))} OKB/ETH for vaults and gas top-ups`);
  console.log(`Seller hunt: OpenStreetMap ${hunt.osm ? 'on' : 'off'}, Google Maps ${hunt.places ? 'on' : 'off (set GOOGLE_MAPS_API_KEY)'}, web search ${hunt.web ? 'on' : 'off'}.`);
  console.log(`Admins: ${admins.size ? [...admins].join(', ') : 'none (set ADMIN_EMAILS)'}. Email: ${mailKind}. Reader: ${extractor instanceof RuleExtractor ? 'rule-based' : `Gemini (${model()})`}.`);
  console.log(`Naira: ${paystack ? `Paystack (${paystack.test ? 'TEST mode, no real money' : 'LIVE'}), held by StockRun in a ledger` : network === 'local' ? 'test naira button (local only)' : 'deposits OFF (set PAYSTACK_SECRET_KEY)'}`);
  console.log(`Demo naira (free, not real money): ${network === 'local' || envValue(env, 'DEMO_NAIRA') === '1' ? 'ON' : 'off'}. Database: ${dbFile}. Demo bot sellers: ${network === 'local' ? 'ON (local only)' : 'off'}.`);
  console.log(`Logistics: ${p.carriers.map((c) => `${c.name}${c.connector ? '' : ' (no booking API)'}`).join(', ') || 'none (self-pickup only)'}`);
  if (!existsSync(staticDir)) console.log('App not built yet: run `npm install && npm run build` in app/, then restart.');
});
const stop = () => { clearInterval(poll); server.close(); stopChain(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
