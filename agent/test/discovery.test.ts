import { describe, expect, it } from 'vitest';
import { openDb } from '../src/accounts/accounts.ts';
import { PlacesSearch } from '../src/discovery/places.ts';
import { WebSellerSearch, fetchPageText, nationalDigits, pageHasNumber } from '../src/discovery/webSearch.ts';
import { fallbackPlan, foundSeller, huntSellers } from '../src/discovery/hunt.ts';
import type { Generate } from '../src/llm.ts';

const KETU = { lat: 6.5965, lng: 3.3878, address: '12 Ikorodu Road, Ketu, Lagos' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const html = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
const place = (id: string, name: string, lat: number, lng: number, phone: string | null, extra: Record<string, unknown> = {}) =>
  ({ id, displayName: { text: name }, formattedAddress: `${name} address`, location: { latitude: lat, longitude: lng }, internationalPhoneNumber: phone ?? undefined, googleMapsUri: `https://maps.google.com/?cid=${id}`, businessStatus: 'OPERATIONAL', ...extra });

describe('phone numbers on pages', () => {
  it('reads Nigerian mobiles in any usual form and finds them in page text', () => {
    expect(nationalDigits('+234 803 123 4567')).toBe('8031234567');
    expect(nationalDigits('0803-123-4567')).toBe('8031234567');
    expect(nationalDigits('01 234 5678')).toBeNull();             // landline: not WhatsApp
    expect(pageHasNumber('Call or WhatsApp: 0803 123 4567 for orders', '+2348031234567')).toBe(true);
    expect(pageHasNumber('wa: +234-803-123-4567', '08031234567')).toBe(true);
    expect(pageHasNumber('tel 080312345678', '08031234567')).toBe(false);   // longer number, not this one
    expect(pageHasNumber('0803 123 4566', '08031234567')).toBe(false);
  });

  it('refuses unsafe pages: http, IP addresses, and redirects to internal hosts', async () => {
    const calls: string[] = [];
    const f = (async (u: URL) => { calls.push(String(u)); return new Response('', { status: 302, headers: { location: 'https://127.0.0.1/admin' } }); }) as unknown as typeof fetch;
    expect(await fetchPageText('http://example.com/', f)).toBeNull();
    expect(await fetchPageText('https://10.0.0.1/', f)).toBeNull();
    const pass = async (u: string) => { try { const x = new URL(u); return /^\d/.test(x.hostname) ? null : x; } catch { return null; } };
    expect(await fetchPageText('https://shop.example/', f, pass)).toBeNull();     // followed the redirect, refused the IP
    expect(calls).toEqual(['https://shop.example/']);
  });
});

describe('Google Maps search', () => {
  it('asks only for the fields it uses and maps listings', async () => {
    let headers: Record<string, string> = {}, body: any;
    const f = (async (_u: string, init: RequestInit) => { headers = init.headers as Record<string, string>; body = JSON.parse(String(init.body)); return json({ places: [place('p1', 'Mile 12 Provisions', 6.6089, 3.3967, '+234 803 111 2222')] }); }) as unknown as typeof fetch;
    const r = await new PlacesSearch({ apiKey: 'k', fetch: f }).search('Indomie wholesale', KETU, 20_000);
    expect(headers['X-Goog-Api-Key']).toBe('k');
    expect(headers['X-Goog-FieldMask']).toContain('places.internationalPhoneNumber');
    expect(body).toMatchObject({ textQuery: 'Indomie wholesale', regionCode: 'NG', locationBias: { circle: { radius: 20_000 } } });
    expect(r[0]).toMatchObject({ name: 'Mile 12 Provisions', phone: '+234 803 111 2222', open: true });
  });

  it('reports Google errors', async () => {
    const f = (async () => json({ error: { status: 'PERMISSION_DENIED', message: 'API key not valid' } }, 403)) as unknown as typeof fetch;
    await expect(new PlacesSearch({ apiKey: 'k', fetch: f }).search('x', KETU)).rejects.toThrow(/403 PERMISSION_DENIED: API key not valid/);
  });
});

/** A Gemini stand-in: the planner gets JSON, the web searcher gets claims plus grounding sources. */
const gemini = (plan: unknown, claims: unknown, sources: string[] = []): Generate => (async (p: any) => {
  const grounded = p.config?.tools?.length;
  return {
    text: JSON.stringify(grounded ? claims : plan),
    candidates: [{ finishReason: 'STOP', groundingMetadata: { groundingChunks: sources.map((uri) => ({ web: { uri } })) } }],
  };
}) as unknown as Generate;

describe('the seller hunt', () => {
  it('keeps nearby open sellers with mobile numbers, drops landlines, closed and far ones, and merges duplicates', async () => {
    const searched: string[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      const q = JSON.parse(String(init.body)).textQuery; searched.push(q);
      return json({ places: [
        place('a', 'Adeyemi Provisions', 6.6089, 3.3967, '0803 111 2222'),
        place('b', 'Landline Depot', 6.60, 3.39, '+234 1 234 5678'),
        place('c', 'Closed Store', 6.60, 3.39, '0805 000 0000', { businessStatus: 'CLOSED_PERMANENTLY' }),
        place('d', 'Far Away Ltd', 9.07, 7.49, '0806 000 0000'),          // Abuja
        place('e', 'No Phone Ventures', 6.60, 3.39, null),
      ] });
    }) as unknown as typeof fetch;
    const db = openDb();
    const plan = { queries: ['Indomie noodles wholesale', 'Dufil distributor'], markets: ['Mile 12'] };
    const r = await huntSellers('Indomie noodles carton', KETU, { places: new PlacesSearch({ apiKey: 'k', fetch: f }), generate: gemini(plan, {}), db });
    expect(searched).toEqual(plan.queries);
    expect(r.sellers).toHaveLength(1);
    expect(r.sellers[0]).toMatchObject({ name: 'Adeyemi Provisions', phone: '+2348031112222', source: 'maps' });
    expect(r.sellers[0].km).toBeLessThan(3);
    expect(foundSeller(db, r.sellers[0].id)).toMatchObject({ phone: '+2348031112222' });
  });

  it('keeps a web find only when the cited page really shows the number, and pins it through Google Maps', async () => {
    const pages: Record<string, string> = {
      'https://jiji.ng/real-shop': '<p>Bulk Indomie. WhatsApp <a href="https://wa.me/2348092223333">us</a></p>',
      'https://made-up.example/': '<p>Nothing to see</p>',
    };
    const fetchPage = (async (u: URL) => html(pages[String(u)] ?? '')) as unknown as typeof fetch;
    const allow = async (u: string) => new URL(u);
    const claims = { sellers: [
      { name: 'Real Shop', area: 'Ketu', phone: '0809 222 3333', sourceUrl: 'https://jiji.ng/real-shop' },
      { name: 'Invented Shop', area: 'Ketu', phone: '0807 444 5555', sourceUrl: 'https://made-up.example/' },
    ] };
    const { WebSellerSearch: W } = await import('../src/discovery/webSearch.ts');
    const web = new W({ generate: gemini({}, claims, ['https://jiji.ng/real-shop']), fetch: fetchPage, check: allow });
    const mapsFetch = (async (_u: string, init: RequestInit) => {
      const q = JSON.parse(String(init.body)).textQuery as string;
      return json({ places: q.startsWith('Real Shop') ? [place('r', 'Real Shop', 6.598, 3.389, null)] : [] });
    }) as unknown as typeof fetch;
    const r = await huntSellers('Indomie', KETU, { web, places: new PlacesSearch({ apiKey: 'k', fetch: mapsFetch }), db: openDb() });
    expect(r.sellers.map((s) => [s.name, s.phone, s.source, s.sourceUrl])).toEqual([['Real Shop', '+2348092223333', 'web', 'https://jiji.ng/real-shop']]);
    expect(r.dropped).toBeGreaterThanOrEqual(1);              // the invented number
  });

  it('plans without AI when no model is available', async () => {
    expect(fallbackPlan('Golden Penny semovita').queries[0]).toBe('Golden Penny semovita wholesale');
    const r = await huntSellers('rice', KETU, { db: openDb() });
    expect(r.sellers).toEqual([]);
  });
});

void WebSellerSearch;
