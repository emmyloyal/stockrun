// The real multi-shop StockRun server: phone sign-in, one vault per shop owner, buyers deposit from their own phone key
// and then tell the agent what to buy.
//   npm run serve            local anvil chain, test money, SMS codes printed here (for trying the app)
//   npm run serve:xlayer     X Layer MAINNET: real USDT0, the taped-out circuits, real gas
// X Layer needs in ../.env: DEPLOYER_PRIVATE_KEY, AGENT_PRIVATE_KEY, CHECK_SERVICE_PRIVATE_KEY, SUPPLIER_PAYOUT_ADDRESS,
// NGN_PER_USD, SERVER_SECRET (32+ characters), and an SMS sender (TWILIO_* or SMS=console). Optional: GEMINI_API_KEY
// (photo check and order reading), APP_PORT (8080), DB_FILE (agent/data/stockrun.db), SECURE_COOKIES=1 behind HTTPS.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatEther } from 'viem';
import { createApp } from './app.ts';
import { Accounts, openDb } from '../accounts/accounts.ts';
import { Shops } from '../accounts/shops.ts';
import { smsFromEnv } from '../accounts/sms.ts';
import { envValue, localPlatform, xlayerPlatform, type Platform } from '../chain/platform.ts';
import { startLocalChain } from '../sim/localChain.ts';
import { defaultExtractor, model } from '../llm.ts';
import { RuleExtractor } from '../rules.ts';
import { BotChannel } from '../sim/bots.ts';
import { GeminiPhotoCounter } from '../check/photoCount.ts';
import { PriceBook } from '../prices/priceBook.ts';

const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;
const network = process.argv.find((a) => a.startsWith('--network='))?.slice(10) ?? envValue(env, 'NETWORK') ?? 'local';
if (network !== 'local' && network !== 'xlayer') throw new Error('NETWORK must be local or xlayer');
const port = Number(envValue(env, 'APP_PORT') ?? 8080);

let stopChain = () => {};
let p: Platform;
if (network === 'xlayer') {
  p = await xlayerPlatform(env);
} else {
  const chain = await startLocalChain();
  stopChain = chain.stop;
  p = localPlatform(chain);
}

const secret = envValue(env, 'SERVER_SECRET') ?? (network === 'local' ? 'local-only-secret-not-for-real-use-0000000' : undefined);
if (!secret || secret.length < 32) throw new Error('Set SERVER_SECRET in .env (32+ random characters). It protects sign-in codes.');
const { sms, kind: smsKind } = smsFromEnv(env, network === 'local');

// Local: a fresh database each run (the chain is fresh too). X Layer: a file, because shops point at real vaults.
const dbFile = network === 'local' ? ':memory:' : envValue(env, 'DB_FILE') ?? fileURLToPath(new URL('../../data/stockrun.db', import.meta.url));
if (dbFile !== ':memory:') mkdirSync(dirname(dbFile), { recursive: true });
const db = openDb(dbFile);
const counter = envValue(env, 'GEMINI_API_KEY') ? new GeminiPhotoCounter() : null;
const extractor = defaultExtractor(new RuleExtractor());
const accounts = new Accounts(db, sms, secret);
// Every supplier in data/suppliers.json is a simulated bot today; real suppliers will come in over WhatsApp.
const shops = new Shops(db, p, { extractor, channel: new BotChannel(), counter, prices: new PriceBook() });

const staticDir = fileURLToPath(new URL('../../../app/dist/', import.meta.url));
const server = createApp({
  platform: p, accounts, shops, staticDir: existsSync(staticDir) ? staticDir : undefined,
  secureCookies: envValue(env, 'SECURE_COOKIES') === '1', log: (l) => console.log(`[server] ${l}`),
});
server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the other server or set APP_PORT.` : `Server error: ${e.message}`);
  stopChain(); process.exit(1);
});
server.listen(port, async () => {
  console.log(`StockRun on http://localhost:${port}  (${network === 'xlayer' ? 'X LAYER MAINNET, real money' : 'local test chain, test money'})`);
  console.log(`Deployer ${p.deployer.account.address}: ${formatEther(await p.pub.getBalance({ address: p.deployer.account.address }))} OKB/ETH for vaults and gas top-ups`);
  console.log(`SMS: ${smsKind}. Reader: ${extractor instanceof RuleExtractor ? 'rule-based' : `Gemini (${model()})`}. Photo check: ${counter ? 'on' : 'OFF (set GEMINI_API_KEY)'}`);
  console.log(`Database: ${dbFile}. Suppliers: simulated bots.`);
  if (!existsSync(staticDir)) console.log('App not built yet: run `npm install && npm run build` in app/, then restart.');
});
const stop = () => { server.close(); stopChain(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
