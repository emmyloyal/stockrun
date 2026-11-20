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
const orders = new NairaOrders({ db, ledger, evalCircuit: circuitEvaluator(p), supplierStatus: (k) => buyers.sellerStatus(k), carriers: () => buyers.carrierKeys() });
// Every seller in data/suppliers.json is a simulated bot today; real sellers will come in over WhatsApp.
buyers = new Buyers(db, p, ledger, orders, { extractor, channel: new BotChannel(), prices, log, dataDir: network === 'local' ? null : dirname(dbFile) });
const paystackKey = envValue(env, 'PAYSTACK_SECRET_KEY');
const publicUrl = envValue(env, 'PUBLIC_URL') ?? `http://localhost:${port}`;
// Sign-in is by email or wallet. Phone sign-in is off (no SMS sender); accounts made earlier by phone still work.
const noSms = { send: async () => { throw new AuthError(503, 'Phone sign-in is off. Use email or a wallet.'); } };
const accounts = new Accounts(db, noSms, secret, Date.now, null, mail);
const paystack = paystackKey ? new Paystack(db, ledger, { secretKey: paystackKey, callbackUrl: `${publicUrl}/?deposit=done` }) : null;

// The AI seller hunt: Google Maps listings (GOOGLE_MAPS_API_KEY) and Gemini web search (SELLER_WEB_SEARCH=on, needs
// billing on the Gemini key). Both bill Google per search after their free allowances, so the hunt is capped per day.
const mapsKey = envValue(env, 'GOOGLE_MAPS_API_KEY'), geminiKey = envValue(env, 'GEMINI_API_KEY');
const generate = geminiKey ? geminiClient(geminiKey) : null;
const hunt = {
  db, log, generate,
  places: mapsKey ? new PlacesSearch({ apiKey: mapsKey }) : null,
  web: generate && envValue(env, 'SELLER_WEB_SEARCH') === 'on' ? new WebSellerSearch({ generate }) : null,
  perUserDaily: Number(envValue(env, 'HUNT_PER_USER_DAILY') ?? 5), siteDaily: Number(envValue(env, 'HUNT_SITE_DAILY') ?? 50),
};

const staticDir = fileURLToPath(new URL('../../../app/dist/', import.meta.url));
const server = createApp({
  platform: p, accounts, buyers, ledger, prices, paystack, hunt, demoNaira: network === 'local' || envValue(env, 'DEMO_NAIRA') === '1',
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
  try { await buyers.dispatcher.poll(buyers.dispatchSets()); } catch (e) { log(`dispatch poll: ${(e as Error).message}`); } finally { polling = false; }
}, 20_000);
server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the other server or set APP_PORT.` : `Server error: ${e.message}`);
  stopChain(); process.exit(1);
});
server.listen(port, async () => {
  console.log(`StockRun on http://localhost:${port}  (${network === 'xlayer' ? 'X LAYER MAINNET, real money' : 'local test chain, test money'})`);
  console.log(`Deployer ${p.deployer.account.address}: ${formatEther(await p.pub.getBalance({ address: p.deployer.account.address }))} OKB/ETH for vaults and gas top-ups`);
  console.log(`Seller hunt: Google Maps ${hunt.places ? 'on' : 'off (set GOOGLE_MAPS_API_KEY)'}, web search ${hunt.web ? 'on' : 'off'}.`);
  console.log(`Email: ${mailKind}. Reader: ${extractor instanceof RuleExtractor ? 'rule-based' : `Gemini (${model()})`}.`);
  console.log(`Naira: ${paystack ? `Paystack (${paystack.test ? 'TEST mode, no real money' : 'LIVE'}), held by StockRun in a ledger` : network === 'local' ? 'test naira button (local only)' : 'deposits OFF (set PAYSTACK_SECRET_KEY)'}`);
  console.log(`Demo naira (free, not real money): ${network === 'local' || envValue(env, 'DEMO_NAIRA') === '1' ? 'ON' : 'off'}. Database: ${dbFile}. Sellers: simulated bots.`);
  console.log(`Logistics: ${p.carriers.map((c) => `${c.name}${c.connector ? '' : ' (no booking API)'}`).join(', ') || 'none (self-pickup only)'}`);
  if (!existsSync(staticDir)) console.log('App not built yet: run `npm install && npm run build` in app/, then restart.');
});
const stop = () => { clearInterval(poll); server.close(); stopChain(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
