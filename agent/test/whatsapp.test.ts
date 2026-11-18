import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WhatsAppChannel, parseWebhook, verifySignature, waId } from '../src/channels/whatsapp.ts';
import { createWebhookServer } from '../src/channels/webhook.ts';
import { negotiate, isDeal } from '../src/tools/negotiate.ts';
import { RuleExtractor } from '../src/rules.ts';
import type { OrderLine, Supplier } from '../src/types.ts';

const SECRET = 'test-app-secret';
const sup: Supplier = { id: 's', name: 'Test supplier', market: 'x', lat: 0, lng: 0, whatsapp: '+234 800 000 0001', simulated: true, stocks: [] };
const line: OrderLine = { item: 'Indomie noodles carton (40 x 70g)', quantity: 5, unit: 'carton', category: 'staples', maxUnitPriceNaira: null };
const hook = (messages: object[] = [], statuses: object[] = []) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages, statuses } }] }],
});
const text = (id: string, body: string, from = '2348000000001') => ({ id, from, timestamp: '1', type: 'text', text: { body } });

/** Fake Graph API: records requests, answers like Meta. */
function fakeGraph(fail?: { status: number; code: number; message: string }) {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') });
    if (fail) return new Response(JSON.stringify({ error: { message: fail.message, code: fail.code } }), { status: fail.status });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${calls.length}` }] }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

describe('WhatsApp channel', () => {
  it('sends text to the digits-only number with the bearer token', async () => {
    const g = fakeGraph();
    const ch = new WhatsAppChannel({ token: 'tok', phoneNumberId: '123', fetch: g.fetch });
    await ch.send(sup, 'hello');
    expect(g.calls[0].url).toBe('https://graph.facebook.com/v21.0/123/messages');
    expect(g.calls[0].auth).toBe('Bearer tok');
    expect(g.calls[0].body).toMatchObject({ messaging_product: 'whatsapp', to: '2348000000001', type: 'text', text: { body: 'hello' } });
  });
  it('explains an expired token', async () => {
    const ch = new WhatsAppChannel({ token: 'tok', phoneNumberId: '123', fetch: fakeGraph({ status: 401, code: 190, message: 'Session has expired' }).fetch });
    await expect(ch.send(sup, 'hello')).rejects.toThrow(/token expired/);
  });
  it('queues replies per sender, drops duplicate ids, and times out', async () => {
    const ch = new WhatsAppChannel({ token: 't', phoneNumberId: '1', fetch: fakeGraph().fetch });
    ch.receive({ id: 'a', from: '2348000000001', text: 'first', timestamp: 1 });
    ch.receive({ id: 'a', from: '2348000000001', text: 'first', timestamp: 1 });
    ch.receive({ id: 'b', from: '2349999999999', text: 'someone else', timestamp: 1 });
    expect(await ch.nextReply(sup, 10)).toBe('first');
    expect(await ch.nextReply(sup, 10)).toBeNull();
    const waiting = ch.nextReply(sup, 1000);
    ch.receive({ id: 'c', from: '2348000000001', text: 'later', timestamp: 2 });
    expect(await waiting).toBe('later');
  });
  it('parses text, button and interactive replies, and failed statuses', () => {
    const r = parseWebhook(hook(
      [text('1', ' 13k '), { id: '2', from: '9', type: 'button', button: { text: 'Yes' } },
        { id: '3', from: '9', type: 'interactive', interactive: { button_reply: { title: 'No' } } }, { id: '4', from: '9', type: 'image' }],
      [{ id: 'w1', status: 'failed', recipient_id: '9', errors: [{ code: 131047, title: 'Re-engagement message' }] }, { id: 'w2', status: 'delivered', recipient_id: '9' }],
    ));
    expect(r.messages.map((m) => m.text)).toEqual(['13k', 'Yes', 'No']);
    expect(r.failures).toEqual([{ messageId: 'w1', recipient: '9', code: 131047, title: 'Re-engagement message' }]);
    expect(parseWebhook({ object: 'page' }).messages).toEqual([]);
  });
  it('verifies Meta signatures', () => {
    const body = '{"a":1}';
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifySignature(body, sig, SECRET)).toBe(true);
    expect(verifySignature(body + ' ', sig, SECRET)).toBe(false);
    expect(verifySignature(body, sig, 'other')).toBe(false);
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
    expect(verifySignature(body, 'sha256=zz', SECRET)).toBe(false);
    expect(waId('+234 (801) 234-5678')).toBe('2348012345678');
  });
});

describe('webhook server', () => {
  const start = async () => {
    const ch = new WhatsAppChannel({ token: 't', phoneNumberId: '1', fetch: fakeGraph().fetch });
    const server = createWebhookServer({ channel: ch, verifyToken: 'vt', appSecret: SECRET });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
    return { ch, server, url };
  };
  const post = (url: string, body: string, secret = SECRET) =>
    fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') } });

  it('answers the verification challenge only with the right token', async () => {
    const { server, url } = await start();
    try {
      const ok = await fetch(`${url}?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`);
      expect([ok.status, await ok.text()]).toEqual([200, '42']);
      expect((await fetch(`${url}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`)).status).toBe(403);
    } finally { server.close(); }
  });
  it('delivers signed messages and rejects forged ones', async () => {
    const { ch, server, url } = await start();
    try {
      expect((await post(url, JSON.stringify(hook([text('f', 'forged ₦1 per carton')])), 'attacker')).status).toBe(401);
      expect((await post(url, JSON.stringify(hook([text('g', '₦13,800 per carton')])))).status).toBe(200);
      expect(await ch.nextReply(sup, 1000)).toBe('₦13,800 per carton');
      expect(await ch.nextReply(sup, 10)).toBeNull(); // the forged one never arrived
    } finally { server.close(); }
  });
  it('refuses to start without a verify token or app secret', () => {
    const ch = new WhatsAppChannel({ token: 't', phoneNumberId: '1', fetch: fakeGraph().fetch });
    expect(() => createWebhookServer({ channel: ch, verifyToken: '', appSecret: SECRET })).toThrow(/VERIFY_TOKEN/);
    expect(() => createWebhookServer({ channel: ch, verifyToken: 'vt', appSecret: '' })).toThrow(/APP_SECRET/);
  });
  it('runs a full negotiation over the webhook', async () => {
    const { ch, server, url } = await start();
    try {
      const g = fakeGraph();
      (ch as any).cfg.fetch = async (u: string, init: RequestInit) => {
        const r = await g.fetch(u, init);
        // The "supplier" answers each agent message through the signed webhook.
        const n = g.calls.length;
        const reply = n === 1 ? '14,000 per carton' : n === 2 ? 'Ok deal' : null;
        if (reply) setTimeout(() => post(url, JSON.stringify(hook([text(`r${n}`, reply)]))), 5);
        return r;
      };
      const res = await negotiate(sup, line, 13_500, ch, new RuleExtractor(), { timeoutMs: 2000 });
      expect(isDeal(res) && res.unitPriceNaira).toBe(13_300);
      expect(g.calls.map((c) => c.body.text.body).every((t: string) => !/deposit|advance/i.test(t))).toBe(true);
    } finally { server.close(); }
  });
});
