// Local demo of the whole app: a vault on a local anvil chain, simulated suppliers, the agent, the photo check and the
// owner/rider app, all on http://localhost:8080.
//   cd app && npm run build      (once, or after changing the app)
//   cd agent && npm run app
// Nothing touches a real network or real money. Suppliers are bots; the owner and rider sign in the browser with anvil's
// public test keys. The photo check uses Gemini when GEMINI_API_KEY is set.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http } from 'viem';
import { anvil } from 'viem/chains';
import { createApi } from './api.ts';
import { defaultExtractor, model } from '../llm.ts';
import { RuleExtractor } from '../rules.ts';
import { BotChannel } from '../sim/bots.ts';
import { startLocalChain, accounts, DEMO_SHOP, TOKEN_PER_NAIRA } from '../sim/localChain.ts';
import { CheckService } from '../check/checkService.ts';
import { GeminiPhotoCounter } from '../check/photoCount.ts';
import { JobStore } from '../check/jobs.ts';
import { PriceBook } from '../prices/priceBook.ts';
import { fixedRate } from '../chain/money.ts';

const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const port = Number(process.env.APP_PORT ?? 8080);

// Anvil's well-known PUBLIC test keys (same as src/sim/localChain.ts). Local chain only.
const DEMO_KEYS = {
  owner: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  rider: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
};

const chain = await startLocalChain();
const jobs = new JobStore();
const extractor = defaultExtractor(new RuleExtractor());
const checker = createWalletClient({ account: accounts.checker, chain: anvil, transport: http(chain.url) });
const check = process.env.GEMINI_API_KEY ? new CheckService(chain.vault, chain.pub, checker, new GeminiPhotoCounter(), jobs) : null;
const staticDir = fileURLToPath(new URL('../../../app/dist/', import.meta.url));

const server = createApi({
  pub: chain.pub, vault: chain.vault, chainId: anvil.id, jobs, check, money: fixedRate(TOKEN_PER_NAIRA), rpcUrl: chain.url,
  agent: { extractor, channel: new BotChannel(), vault: chain.vaultClient, riders: chain.riders, shop: DEMO_SHOP, money: fixedRate(TOKEN_PER_NAIRA), jobs, prices: new PriceBook() },
  staticDir: existsSync(staticDir) ? staticDir : undefined,
  demoKeys: DEMO_KEYS,
  log: (l) => console.log(`[app] ${l}`),
});
server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE'
    ? `Port ${port} is already in use (another StockRun demo still running?). Stop it, or set APP_PORT in .env.`
    : `Server error: ${e.message}`);
  chain.stop();
  process.exit(1);
});
server.listen(port, () => {
  console.log(`StockRun demo on http://localhost:${port}`);
  console.log(`Chain: local anvil (${chain.url}), vault ${chain.vault}`);
  console.log(`Reader: ${extractor instanceof RuleExtractor ? 'rule-based' : `Gemini (${model()})`}. Photo check: ${check ? 'on' : 'OFF (set GEMINI_API_KEY)'}`);
  if (!existsSync(staticDir)) console.log('App not built yet: run `npm install && npm run build` in app/, then restart.');
});
const stop = () => { server.close(); chain.stop(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
