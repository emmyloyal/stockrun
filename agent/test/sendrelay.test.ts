import { describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { SendrelayCarrier, verifySendrelayWebhook, stateFromEvent, sendrelayState } from '../src/logistics/sendrelay.ts';
import { compareQuotes, CarrierError, type Carrier, type DeliveryJob } from '../src/logistics/carrier.ts';

const KEY = 'sk_test_abcd1234_secretpart';
const JOB: DeliveryJob = {
  ref: 'shop1-order7',
  pickup: { name: 'Adeyemi Provisions', lat: 6.6045, lng: 3.3891, address: 'Mile 12 Market, Lagos', contactName: 'Mr Adeyemi', contactPhone: '+2348030000001' },
  dropoff: { name: "Ada's Provisions", lat: 6.587, lng: 3.381, address: 'Ojota, Lagos', contactName: 'Ada', contactPhone: '+2348031111111' },
  item: { name: 'Indomie noodles carton (40 x 70g)', quantity: 5, unit: 'carton', valueNaira: 66_500 },
  load: 'standard',
};

/** Records requests and answers from a script. */
function fakeApi(answers: Record<string, { status?: number; body: unknown }>) {
  const calls: { method: string; path: string; headers: Record<string, string>; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ method: init.method!, path, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined });
    const a = answers[`${init.method} ${path}`];
    if (!a) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no route' } }), { status: 404 });
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('Sendrelay connector', () => {
  it('refuses something that is not a Sendrelay key', () => {
    expect(() => new SendrelayCarrier({ apiKey: 'hello' })).toThrow(/does not look like/);
    expect(new SendrelayCarrier({ apiKey: KEY }).test).toBe(true);
    expect(new SendrelayCarrier({ apiKey: 'sk_live_abcd1234_secret' }).test).toBe(false);
  });

  it('quotes each vehicle that fits and keeps the cheapest, in naira from kobo, with the key, both stops and the goods value', async () => {
    const prices: Record<string, number> = { MOTORCYCLE: 235_000, TRICYCLE: 310_000, CAR: 480_000, VAN: 1_010_000 };
    const calls: any[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string); calls.push({ headers: init.headers, body });
      const v = body.preferences.vehicleType[0];
      return new Response(JSON.stringify({ quoteId: `q_${v}`, expiresAt: '2026-11-19T20:00:00Z', total: prices[v], pricingVehicleType: v }), { status: 200 });
    }) as unknown as typeof fetch;
    const q = await new SendrelayCarrier({ apiKey: KEY, fetch: f }).quote(JOB);
    expect(q).toMatchObject({ carrier: 'sendrelay', quoteId: 'q_MOTORCYCLE', priceNaira: 2350, vehicle: 'MOTORCYCLE', test: true });
    expect(calls.map((c) => c.body.preferences.vehicleType[0]).sort()).toEqual(['CAR', 'MOTORCYCLE', 'TRICYCLE', 'VAN']);
    const c = calls[0];
    expect(c.headers['X-Relay-Key']).toBe(KEY);
    expect(c.body.taskType).toBe('PACKAGE_DELIVERY');
    expect(c.body.stages.map((s: any) => s.type)).toEqual(['PICKUP', 'DROPOFF']);
    expect(c.body.stages[0].location).toEqual({ latitude: 6.6045, longitude: 3.3891, address: 'Mile 12 Market, Lagos', countryCode: 'NG' });
    expect(c.body.stages[0].items[0]).toMatchObject({ estimatedValue: 6_650_000, estimatedWeight: 'STANDARD', reference: 'shop1-order7' });
  });

  it('books once per order: idempotency key from our ref, the quoted price as a hard limit, a delivery code and photo', async () => {
    const api = fakeApi({
      'POST /v1/sdk/tasks': { status: 201, body: { task: { id: 'tsk_9', status: 'PENDING', totalFee: 235_000, completionCode: { code: '482913' } }, pricing: { total: 235_000 } } },
    });
    const sr = new SendrelayCarrier({ apiKey: KEY, fetch: api.f });
    const b = await sr.book(JOB, { carrier: 'sendrelay', quoteId: 'q_1', priceNaira: 2350, expiresAt: null, vehicle: 'MOTORCYCLE', test: true });
    expect(b).toEqual({ carrier: 'sendrelay', bookingId: 'tsk_9', ref: 'shop1-order7', state: 'booked', priceNaira: 2350, handoverCode: '482913', test: true });
    const c = api.calls[0];
    expect(c.headers['Idempotency-Key']).toBe('stockrun-shop1-order7');
    expect(c.body).toMatchObject({ quoteId: 'q_1', externalId: 'shop1-order7', priceLimit: 235_000, completionCode: {}, requirePhoto: true, preferences: { vehicleType: ['MOTORCYCLE'] } });
    await expect(sr.book(JOB, { carrier: 'kwik', quoteId: 'x', priceNaira: 1, expiresAt: null, vehicle: null, test: true })).rejects.toThrow(/different carrier/);
  });

  it('turns API errors into a CarrierError with the stable code', async () => {
    const api = fakeApi({ 'POST /v1/sdk/tasks/quote': { status: 422, body: { error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: [{ path: 'stages.0.location', message: 'required' }] } } } });
    const err = await new SendrelayCarrier({ apiKey: KEY, fetch: api.f }).quote(JOB).catch((e) => e);
    expect(err).toBeInstanceOf(CarrierError);
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
    expect(err.message).toMatch(/stages\.0\.location required/);
  });

  it('maps every task status; IN_PROGRESS means the goods are with the rider', () => {
    expect(['SCHEDULED', 'PENDING', 'SEARCHING', 'OFFERED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED'].map(sendrelayState))
      .toEqual(['booked', 'booked', 'searching', 'searching', 'assigned', 'picked_up', 'delivered', 'failed', 'cancelled']);
  });

  it('reads a task: state, rider and drop-off photo', async () => {
    const api = fakeApi({ 'GET /v1/sdk/tasks/tsk_9': { body: { task: { id: 'tsk_9', status: 'COMPLETED', rider: { firstName: 'Tunde', vehicleType: 'MOTORCYCLE' }, stages: [{ type: 'PICKUP' }, { type: 'DROPOFF', completionPhoto: 'https://cdn.example/p.jpg' }] } } } });
    expect(await new SendrelayCarrier({ apiKey: KEY, fetch: api.f }).get('tsk_9')).toMatchObject({ state: 'delivered', rider: { name: 'Tunde', vehicle: 'MOTORCYCLE' }, dropoffPhotoUrl: 'https://cdn.example/p.jpg' });
  });
});

describe('Sendrelay webhooks', () => {
  const raw = randomBytes(32);
  const secret = `whsec_${raw.toString('base64url')}`;
  const body = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'task.status.in_progress', data: { taskId: 'tsk_9', status: 'IN_PROGRESS', revision: 3 } }));
  const sign = (t: number, b = body, key = raw) => `t=${t},v1=${createHmac('sha256', key).update(Buffer.concat([Buffer.from(`${t}.`), b])).digest('hex')}`;
  const now = 1_795_000_000_000, t = now / 1000;

  it('accepts a correctly signed, fresh event', () => {
    const ev = verifySendrelayWebhook(body, sign(t), secret, now);
    expect(ev.data.taskId).toBe('tsk_9');
    expect(stateFromEvent(ev)).toBe('picked_up');
  });
  it('rejects a changed body, a wrong secret, a stale timestamp and a malformed header', () => {
    expect(() => verifySendrelayWebhook(Buffer.from(body.toString().replace('tsk_9', 'tsk_8')), sign(t), secret, now)).toThrow(/does not match/);
    expect(() => verifySendrelayWebhook(body, sign(t, body, randomBytes(32)), secret, now)).toThrow(/does not match/);
    expect(() => verifySendrelayWebhook(body, sign(t - 301), secret, now)).toThrow(/outside 5 minutes/);
    expect(() => verifySendrelayWebhook(body, 'v1=abc', secret, now)).toThrow(/bad or missing/);
  });
});

describe('comparing carriers', () => {
  const fake = (id: string, price: number | Error): Carrier => ({
    id, name: id, quote: async () => { if (price instanceof Error) throw price; return { carrier: id, quoteId: `${id}-q`, priceNaira: price, expiresAt: null, vehicle: null, test: true }; },
    book: async () => { throw new Error('no'); }, get: async () => { throw new Error('no'); }, cancel: async () => {}, trackingLink: async () => null,
  });
  it('lists quotes cheapest first and reports carriers that failed', async () => {
    const r = await compareQuotes([fake('a', 3000), fake('b', 2100), fake('c', new Error('no riders'))], JOB);
    expect(r.quotes.map((q) => q.carrier)).toEqual(['b', 'a']);
    expect(r.failed).toEqual([{ carrier: 'c', error: 'no riders' }]);
  });
});
