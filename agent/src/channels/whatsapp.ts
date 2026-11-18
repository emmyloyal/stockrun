// WhatsApp Cloud API channel: the real SupplierChannel (docs/WHATSAPP.md).
// Outgoing: plain text messages through the Graph API. Meta only delivers free-form text inside the 24-hour window that
// opens when the supplier messages us; outside it, Meta accepts the request but later reports a failed status
// (error 131047), which we record in `failures`. Business-initiated first contact needs an approved template (not yet registered).
// Incoming: the webhook server (webhook.ts) calls `receive` for every message Meta delivers.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SupplierChannel } from '../tools/negotiate.ts';
import type { Supplier } from '../types.ts';

export interface WhatsAppConfig { token: string; phoneNumberId: string; apiVersion?: string; fetch?: typeof fetch }
export interface Inbound { id: string; from: string; text: string; timestamp: number }
export interface Failure { messageId: string; recipient: string; code: number | null; title: string }

/** WhatsApp ids are digits only: "+234 801..." -> "234801...". */
export const waId = (phone: string) => phone.replace(/\D/g, '');

export class WhatsAppError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null) { super(message); this.name = 'WhatsAppError'; this.code = code; }
}

export class WhatsAppChannel implements SupplierChannel {
  private cfg: Required<WhatsAppConfig>;
  private inbox = new Map<string, string[]>();
  private waiters = new Map<string, (text: string) => void>();
  private seen = new Set<string>();        // Meta retries webhooks: drop duplicate message ids
  readonly failures: Failure[] = [];
  readonly sent: { id: string; to: string; text: string }[] = [];

  constructor(cfg: WhatsAppConfig) {
    if (!cfg.token || !cfg.phoneNumberId) throw new Error('WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID must be set in .env');
    this.cfg = { apiVersion: 'v21.0', fetch: globalThis.fetch, ...cfg };
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env) {
    return new WhatsAppChannel({ token: env.WHATSAPP_TOKEN ?? '', phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? '' });
  }

  async send(to: Supplier, text: string): Promise<void> {
    const recipient = waId(to.whatsapp);
    const res = await this.cfg.fetch(`https://graph.facebook.com/${this.cfg.apiVersion}/${this.cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, type: 'text', text: { preview_url: false, body: text } }),
    });
    const body = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number } };
    if (!res.ok || !body.messages?.[0]?.id) {
      const code = body.error?.code ?? null;
      const hint = code === 190 ? ' (access token expired: generate a new one and update WHATSAPP_TOKEN in .env)'
        : code === 131030 ? ' (recipient is not on the test number\'s allowed list)' : '';
      throw new WhatsAppError(`WhatsApp send failed: ${body.error?.message ?? res.status}${hint}`, code);
    }
    this.sent.push({ id: body.messages[0].id, to: recipient, text });
  }

  /** Called by the webhook for each inbound message. Duplicates (same id) are ignored. */
  receive(m: Inbound): void {
    if (this.seen.has(m.id)) return;
    this.seen.add(m.id);
    const from = waId(m.from);
    const waiter = this.waiters.get(from);
    if (waiter) { this.waiters.delete(from); waiter(m.text); return; }
    const q = this.inbox.get(from) ?? [];
    q.push(m.text);
    this.inbox.set(from, q);
  }

  recordFailure(f: Failure): void { this.failures.push(f); }

  nextReply(from: Supplier, timeoutMs: number): Promise<string | null> {
    const id = waId(from.whatsapp);
    const queued = this.inbox.get(id)?.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters.delete(id); resolve(null); }, timeoutMs);
      this.waiters.set(id, (text) => { clearTimeout(timer); resolve(text); });
    });
  }

  /** Drop anything already queued from this contact (e.g. the "hi" that opened the 24-hour window). */
  clear(from: Supplier): void { this.inbox.delete(waId(from.whatsapp)); }
}

// ---------- webhook payload ----------
interface WebhookBody {
  object?: string;
  entry?: { changes?: { field?: string; value?: {
    messages?: { id: string; from: string; timestamp?: string; type: string; text?: { body?: string }; button?: { text?: string };
      interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } } }[];
    statuses?: { id: string; status: string; recipient_id: string; errors?: { code?: number; title?: string; message?: string }[] }[];
  } }[] }[];
}

/** Pull text messages and failed delivery statuses out of a Cloud API webhook body. Other message types are skipped. */
export function parseWebhook(raw: unknown): { messages: Inbound[]; failures: Failure[] } {
  const body = raw as WebhookBody;
  const messages: Inbound[] = [], failures: Failure[] = [];
  if (body?.object !== 'whatsapp_business_account') return { messages, failures };
  for (const e of body.entry ?? []) for (const c of e.changes ?? []) {
    if (c.field !== 'messages' || !c.value) continue;
    for (const m of c.value.messages ?? []) {
      const text = m.type === 'text' ? m.text?.body
        : m.type === 'button' ? m.button?.text
        : m.type === 'interactive' ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title)
        : undefined;
      if (typeof text === 'string' && text.trim()) messages.push({ id: m.id, from: m.from, text: text.trim(), timestamp: Number(m.timestamp ?? 0) });
    }
    for (const s of c.value.statuses ?? []) if (s.status === 'failed') {
      const err = s.errors?.[0];
      failures.push({ messageId: s.id, recipient: s.recipient_id, code: err?.code ?? null, title: err?.title ?? err?.message ?? 'failed' });
    }
  }
  return { messages, failures };
}

/** Check Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the app secret). */
export function verifySignature(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=') || !appSecret) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
