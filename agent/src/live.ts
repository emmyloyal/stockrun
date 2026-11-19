// Live WhatsApp test: YOU play the supplier on your own phone, and the agent haggles with you for real.
//   npm run live
// Needs in ../.env: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TEST_RECIPIENT, WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET,
// plus a public HTTPS tunnel to this machine (see agent/README.md "Live WhatsApp test").
// Only negotiation runs here. No vault, no chain, no money: nothing is bought.
import { WhatsAppChannel } from './channels/whatsapp.ts';
import { createWebhookServer } from './channels/webhook.ts';
import { defaultExtractor, model } from './llm.ts';
import { RuleExtractor } from './rules.ts';
import { negotiate, isDeal } from './tools/negotiate.ts';
import type { OrderLine, Supplier } from './types.ts';

process.loadEnvFile(new URL('../../.env', import.meta.url));
const env = process.env;
const recipient = (env.WHATSAPP_TEST_RECIPIENT ?? '').replace(/#.*/, '').replace(/\D/g, '');
if (!recipient) throw new Error('Set WHATSAPP_TEST_RECIPIENT in .env (your number, e.g. 2348012345678)');
const port = Number(env.WEBHOOK_PORT ?? 8787);

const channel = WhatsAppChannel.fromEnv(env);
const server = createWebhookServer({
  channel, verifyToken: env.WHATSAPP_VERIFY_TOKEN ?? '', appSecret: env.WHATSAPP_APP_SECRET ?? '', port,
  log: (l) => console.log(`[webhook] ${l}`),
});
await new Promise<void>((r) => server.listen(port, r));

const you: Supplier = {
  id: 'live-test-you', name: 'Test supplier', market: 'your phone', lat: 6.6, lng: 3.38,
  whatsapp: recipient, simulated: false, stocks: [],
};
const line: OrderLine = { item: 'Indomie noodles carton (40 x 70g)', quantity: 5, unit: 'carton', category: 'staples', maxUnitPriceNaira: null };
const LIST_PRICE = 13_500; // catalogue price for the demo; the agent's ceiling is list + 5% = ₦14,200

const extractor = defaultExtractor(new RuleExtractor());
console.log(`Webhook listening on http://localhost:${port}/webhook`);
console.log(`Reader: ${extractor instanceof RuleExtractor ? 'rule-based (no GEMINI_API_KEY found)' : `Gemini (${model()})`}`);
console.log(`\n1. Send "hi" from your phone to the test number (this opens WhatsApp's 24-hour window).`);
console.log(`2. The agent will ask you for a price. Reply like a supplier: "13,800 per carton", "ok", "no stock"...\n`);

const waitMin = Number(env.LIVE_WAIT_MIN ?? 60);
const hi = await channel.nextReply(you, waitMin * 60_000);
if (hi === null) { console.log(`No message within ${waitMin} minutes. Is the webhook connected? Stopping.`); server.close(); process.exit(1); }
channel.clear(you);

try {
  const result = await negotiate(you, line, LIST_PRICE, channel, extractor, { timeoutMs: 5 * 60_000 });
  console.log('\n--- transcript\n' + result.transcript.join('\n'));
  console.log('\n--- result: ' + (isDeal(result) ? `deal at ₦${result.unitPriceNaira.toLocaleString('en-NG')} per carton (nothing was bought: no vault in this test)` : `no deal (${result.reason})`));
} finally {
  if (channel.failures.length) console.log('\nDelivery failures reported by Meta:', channel.failures);
  server.close();
}
