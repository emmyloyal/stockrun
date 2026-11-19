// Sendrelay connector (https://docs.sendrelay.com.ng). Plain fetch, server side only: the API key never reaches a browser.
// - Auth: header X-Relay-Key. Keys are sk_test_... (simulated riders, no money) or sk_live_... (real riders, wallet debit).
// - Money: kobo in the API, whole naira here (prices are rounded up to ₦50 by Sendrelay, so no fractions are lost).
// - Booking: POST /v1/sdk/tasks with a required Idempotency-Key; we use the job ref, so a retry never books twice.
// - Proof: a 6-digit completion code the rider must enter at the shop, and a required drop-off photo.
// - Status: IN_PROGRESS means the first pickup is done, i.e. the goods are with the rider.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { CarrierError, type Booking, type BookingUpdate, type Carrier, type CarrierQuote, type DeliveryJob, type DeliveryState } from './carrier.ts';

export const SENDRELAY_API = 'https://api.sendrelay.com.ng';
const KEY_SHAPE = /^sk_(test|live)_[A-Za-z0-9]+_[A-Za-z0-9_-]+$/;

const STATE: Record<string, DeliveryState> = {
  SCHEDULED: 'booked', PENDING: 'booked', SEARCHING: 'searching', OFFERED: 'searching', ASSIGNED: 'assigned',
  IN_PROGRESS: 'picked_up', COMPLETED: 'delivered', FAILED: 'failed', CANCELLED: 'cancelled',
};
export const sendrelayState = (status: string): DeliveryState => STATE[status] ?? 'booked';

const WEIGHT = { light: 'LIGHT', standard: 'STANDARD', heavy: 'HEAVY', freight: 'FREIGHT' } as const;
const SIZE = { light: 'BOX', standard: 'BOX', heavy: 'LARGE_BOX', freight: 'FREIGHT' } as const;
const VEHICLES = { light: ['MOTORCYCLE', 'TRICYCLE', 'CAR'], standard: ['MOTORCYCLE', 'TRICYCLE', 'CAR', 'VAN'], heavy: ['TRICYCLE', 'VAN', 'TRUCK'], freight: ['VAN', 'TRUCK'] } as const;

const kobo = (naira: number) => Math.round(naira * 100);
const naira = (k: number) => Math.ceil(k / 100);

export interface SendrelayOptions { apiKey: string; fetch?: typeof fetch; baseUrl?: string }

export class SendrelayCarrier implements Carrier {
  readonly id = 'sendrelay';
  readonly name = 'Sendrelay';
  readonly test: boolean;
  private key: string; private fetch: typeof fetch; private base: string;

  constructor(o: SendrelayOptions) {
    if (!KEY_SHAPE.test(o.apiKey)) throw new Error('SENDRELAY_API_KEY does not look like a Sendrelay key (sk_test_... or sk_live_...)');
    this.key = o.apiKey; this.test = o.apiKey.startsWith('sk_test_');
    this.fetch = o.fetch ?? fetch; this.base = o.baseUrl ?? SENDRELAY_API;
  }

  private async call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { 'X-Relay-Key': this.key, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const r = await this.fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    const json = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
    if (!r.ok) {
      const e = json?.error ?? {};
      const detail = Array.isArray(e.details) ? `: ${e.details.map((d: any) => `${d.path} ${d.message}`).join('; ')}` : '';
      throw new CarrierError(this.id, r.status, e.code ?? `HTTP_${r.status}`, (e.message ?? 'request failed') + detail);
    }
    return json as T;
  }

  /** The task body shared by quote and create. */
  private task(job: DeliveryJob) {
    const stop = (p: DeliveryJob['pickup']) => ({ location: { latitude: p.lat, longitude: p.lng, address: p.address, countryCode: 'NG' }, contact: { name: p.contactName, phone: p.contactPhone } });
    return {
      taskType: 'PACKAGE_DELIVERY',
      stages: [
        { type: 'PICKUP', ...stop(job.pickup), instructions: `StockRun order ${job.ref}: collect ${job.item.quantity} ${job.item.unit}(s) of ${job.item.name} from ${job.pickup.name}.`,
          items: [{ name: `${job.item.quantity} x ${job.item.name}`.slice(0, 120), estimatedValue: Math.max(1, kobo(job.item.valueNaira)), estimatedWeight: WEIGHT[job.load], estimatedSize: SIZE[job.load], reference: job.ref.slice(0, 128) }] },
        { type: 'DROPOFF', ...stop(job.dropoff), instructions: `Deliver to ${job.dropoff.name}. Ask the shop owner for the delivery code.` },
      ],
      preferences: { vehicleType: VEHICLES[job.load] },
    };
  }

  async quote(job: DeliveryJob): Promise<CarrierQuote> {
    const q = await this.call<{ quoteId: string; expiresAt: string; total: number; pricingVehicleType?: string }>('POST', '/v1/sdk/tasks/quote', this.task(job));
    return { carrier: this.id, quoteId: q.quoteId, priceNaira: naira(q.total), expiresAt: Date.parse(q.expiresAt) || null, vehicle: q.pricingVehicleType ?? null, test: this.test };
  }

  async book(job: DeliveryJob, quote: CarrierQuote): Promise<Booking> {
    if (quote.carrier !== this.id) throw new Error('quote is from a different carrier');
    const r = await this.call<{ task: SendrelayTask; pricing?: { total: number } }>('POST', '/v1/sdk/tasks', {
      ...this.task(job), quoteId: quote.quoteId ?? undefined, externalId: job.ref,
      completionCode: {}, requirePhoto: true,
      // Never pay more than the quote the owner's order was checked against (RestockGuard saw this price).
      priceLimit: kobo(quote.priceNaira),
      notes: 'Booked by StockRun. The shop owner gives you the delivery code at the door.',
    }, `stockrun-${job.ref}`);
    const t = r.task;
    return {
      carrier: this.id, bookingId: t.id, ref: job.ref, state: sendrelayState(t.status),
      priceNaira: naira(r.pricing?.total ?? t.totalFee ?? kobo(quote.priceNaira)),
      handoverCode: t.completionCode?.code ?? null, test: this.test,
    };
  }

  async get(bookingId: string): Promise<BookingUpdate> {
    const { task } = await this.call<{ task: SendrelayTask }>('GET', `/v1/sdk/tasks/${encodeURIComponent(bookingId)}`);
    return toUpdate(task);
  }

  async cancel(bookingId: string): Promise<void> {
    await this.call('DELETE', `/v1/sdk/tasks/${encodeURIComponent(bookingId)}/cancel`);
  }

  async trackingLink(bookingId: string): Promise<string | null> {
    const r = await this.call<{ url?: string }>('POST', `/v1/sdk/tasks/${encodeURIComponent(bookingId)}/tracking-link`, {});
    return r.url ?? null;
  }
}

interface SendrelayTask {
  id: string; status: string; totalFee?: number; failureReason?: string; updatedAt?: string;
  completionCode?: { code?: string } | null;
  rider?: { firstName?: string; name?: string; vehicleType?: string; vehicle?: { type?: string } } | null;
  stages?: { type: string; completionPhoto?: string | { url?: string } | null }[];
}

function toUpdate(t: SendrelayTask): BookingUpdate {
  const drop = t.stages?.filter((s) => s.type === 'DROPOFF').at(-1)?.completionPhoto;
  return {
    bookingId: t.id, state: sendrelayState(t.status),
    rider: t.rider ? { name: t.rider.firstName ?? t.rider.name ?? null, vehicle: t.rider.vehicleType ?? t.rider.vehicle?.type ?? null } : null,
    failureReason: t.failureReason ?? null,
    dropoffPhotoUrl: typeof drop === 'string' ? drop : drop?.url ?? null,
    at: Date.parse(t.updatedAt ?? '') || Date.now(),
  };
}

// ---------------------------------------------------------------- webhooks
export interface SendrelayEvent { id: string; type: string; timestamp?: string; data: { taskId: string; status?: string; revision?: number; [k: string]: unknown } }

/**
 * Verify a webhook (docs: webhooks/signature-verification). Header X-Relay-Signature: `t=<unix s>,v1=<64 hex>`.
 * Signed text is `${t}.` + the exact raw body; HMAC-SHA256 with the secret minus `whsec_`, base64url-decoded to bytes.
 * Rejects anything older or newer than 5 minutes. Returns the parsed event, or throws.
 */
export function verifySendrelayWebhook(rawBody: Buffer, signatureHeader: string | undefined, secret: string, nowMs = Date.now()): SendrelayEvent {
  const m = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(signatureHeader ?? '');
  if (!m) throw new Error('bad or missing X-Relay-Signature');
  const t = Number(m[1]);
  if (Math.abs(nowMs / 1000 - t) > 300) throw new Error('webhook timestamp outside 5 minutes');
  if (!secret.startsWith('whsec_')) throw new Error('SENDRELAY_WEBHOOK_SECRET must start with whsec_');
  const key = Buffer.from(secret.slice(6), 'base64url');
  const want = createHmac('sha256', key).update(Buffer.concat([Buffer.from(`${t}.`), rawBody])).digest();
  const got = Buffer.from(m[2], 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error('webhook signature does not match');
  const ev = JSON.parse(rawBody.toString('utf8')) as SendrelayEvent;
  if (!ev?.id || !ev?.data?.taskId) throw new Error('webhook body has no event id or task id');
  return ev;
}

/** The delivery state a task.status.* event moves to, or null for events that are not status changes. */
export function stateFromEvent(ev: SendrelayEvent): DeliveryState | null {
  if (ev.type === 'task.stage.arrived') return 'at_dropoff';      // caller checks it is the drop-off stage
  const m = /^task\.status\.(\w+)$/.exec(ev.type);
  return m ? sendrelayState(m[1].toUpperCase()) : null;
}
