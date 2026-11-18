// Webhook server for the WhatsApp Cloud API.
//   GET  /webhook  Meta's one-time verification (hub.verify_token must match WHATSAPP_VERIFY_TOKEN).
//   POST /webhook  Message and status events. Unsigned or wrongly signed requests are rejected with 401,
//                  so nobody who finds the URL can inject fake supplier replies.
import { createServer, type Server } from 'node:http';
import { parseWebhook, verifySignature, type WhatsAppChannel } from './whatsapp.ts';

export interface WebhookOptions { channel: WhatsAppChannel; verifyToken: string; appSecret: string; port?: number; log?: (line: string) => void }

const MAX_BODY = 1_000_000;

export function createWebhookServer(o: WebhookOptions): Server {
  if (!o.verifyToken) throw new Error('WHATSAPP_VERIFY_TOKEN must be set in .env');
  if (!o.appSecret) throw new Error('WHATSAPP_APP_SECRET must be set in .env (Meta app > App settings > Basic > App secret)');
  const log = o.log ?? (() => {});
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/webhook') { res.writeHead(404).end(); return; }

    if (req.method === 'GET') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === o.verifyToken;
      if (ok) log('Meta verified the webhook.');
      res.writeHead(ok ? 200 : 403, { 'Content-Type': 'text/plain' }).end(ok ? (url.searchParams.get('hub.challenge') ?? '') : 'forbidden');
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (!verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined, o.appSecret)) {
        log('Rejected a webhook call with a missing or wrong signature.');
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200).end(); // answer fast; Meta retries slow or failed deliveries
      let json: unknown;
      try { json = JSON.parse(raw.toString('utf8')); } catch { return; }
      const { messages, failures } = parseWebhook(json);
      for (const m of messages) { log(`<- ${m.from}: ${m.text}`); o.channel.receive(m); }
      for (const f of failures) {
        log(`!! delivery to ${f.recipient} failed: ${f.code ?? ''} ${f.title}${f.code === 131047 ? ' (more than 24 h since they last messaged us; they need to message the number first)' : ''}`);
        o.channel.recordFailure(f);
      }
    });
  });
}
