// Local demo: one order through the whole agent, against a vault on a local anvil chain.
//   npm run demo -- "5 cartons of Indomie, 10 bags of rice at 80k, within 5 km"
// Uses Gemini to read text when GEMINI_API_KEY is set (in ../.env or the environment),
// otherwise the rule-based reader. Suppliers are simulated bots; nothing touches a real network.
import { existsSync } from 'node:fs';
import { handleOrder } from './agent.ts';
import { defaultExtractor, model } from './llm.ts';
import { RuleExtractor } from './rules.ts';
import { BotChannel } from './sim/bots.ts';
import { PriceBook } from './prices/priceBook.ts';
import { startLocalChain, DEMO_SHOP, TOKEN_PER_NAIRA } from './sim/localChain.ts';

const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const text = process.argv.slice(2).join(' ') || '5 cartons of Indomie, 10 bags of rice at 80k, 5 crates of beer, 3 cartons of spaghetti, within 15 km';
const chain = await startLocalChain();
try {
  const channel = new BotChannel();
  const extractor = defaultExtractor(new RuleExtractor());
  console.log(`Reader: ${extractor instanceof RuleExtractor ? 'rule-based (no GEMINI_API_KEY found)' : `Gemini (${model()})`}`);
  console.log(`Vault (local anvil): ${chain.vault}\n\nOwner: ${text}\n`);
  const report = await handleOrder(text, {
    extractor, channel, prices: new PriceBook(), vault: chain.vaultClient, riders: chain.riders, shop: DEMO_SHOP, tokenPerNaira: TOKEN_PER_NAIRA,
  });
  for (const o of report.outcomes) if (o.kind === 'proposed') console.log(`--- WhatsApp with ${o.deal.supplier.name} (simulated)\n${o.deal.transcript.join('\n')}\n`);
  console.log(`--- StockRun -> owner\n${report.message}`);
} finally {
  chain.stop();
}
