import { describe, expect, it } from 'vitest';
import { openDb } from '../src/accounts/accounts.ts';
import { PlacesSearch } from '../src/discovery/places.ts';
import { OsmSearch } from '../src/discovery/osm.ts';
import { WebSellerSearch, fetchPageText, nationalDigits, pageHasNumber } from '../src/discovery/webSearch.ts';
import { fallbackPlan, foundNear, foundSeller, huntSellers, seedOsmSellers } from '../src/discovery/hunt.ts';
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
    const plan = { queries: ['Indomie noodles wholesale', 'Dufil distributor'], markets: ['Mile 12'], shopTypes: ['wholesale'] };
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

describe('OpenStreetMap search', () => {
  it('asks Overpass for shops of the chosen types with a phone, and ignores made-up types', async () => {
    let query = '';
    const f = (async (url: string, init: RequestInit) => {
      expect(url).toContain('overpass');
      expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/^StockRun/);
      query = new URLSearchParams(String(init.body)).get('data')!;
      return json({ elements: [
        { type: 'node', id: 1, lat: 6.60, lon: 3.39, tags: { name: 'Agora Marketplace', shop: 'supermarket', phone: '0803 222 1111; 01 555 0000' } },
        { type: 'way', id: 2, center: { lat: 6.61, lon: 3.40 }, tags: { name: 'Shaddash', shop: 'supermarket', 'contact:whatsapp': '+234 905 000 1111' } },
        { type: 'node', id: 3, lat: 6.6, lon: 3.39, tags: { shop: 'kiosk', phone: '0803 000 0000' } },     // no name: skipped
      ] });
    }) as unknown as typeof fetch;
    const r = await new OsmSearch({ fetch: f }).search(['supermarket', 'wholesale', 'not_a_shop_type'], KETU, 10_000);
    expect(query).toContain('around:10000,6.5965,3.3878');
    expect(query).toContain('^(supermarket|wholesale)$');
    expect(r.map((l) => [l.name, l.phone, l.mapsUrl])).toEqual([
      ['Agora Marketplace', '0803 222 1111', 'https://www.openstreetmap.org/node/1'],
      ['Shaddash', '+234 905 000 1111', 'https://www.openstreetmap.org/way/2'],
    ]);
  });

  it('falls back to Nominatim, one request a second, when no Overpass server answers', async () => {
    const urls: string[] = []; const waits: number[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      if (url.includes('overpass')) throw new Error('connection reset');
      return json([{ osm_type: 'node', osm_id: 9, lat: '6.6', lon: '3.39', name: 'Old English Superstores', type: 'supermarket', display_name: 'Old English, Ikorodu Road, Ketu, Lagos', extratags: { phone: '0809 111 2222' } }]);
    }) as unknown as typeof fetch;
    const r = await new OsmSearch({ fetch: f, sleep: async (ms) => { waits.push(ms); } }).search(['supermarket', 'convenience'], KETU);
    expect(urls.filter((u) => u.includes('nominatim'))).toHaveLength(2);
    expect(waits).toEqual([1100]);
    expect(r).toHaveLength(1);                                   // the same place from both searches counts once
    expect(r[0]).toMatchObject({ name: 'Old English Superstores', phone: '0809 111 2222' });
  });

  it('feeds the hunt: OSM shops with a mobile become found sellers', async () => {
    const f = (async () => json({ elements: [{ type: 'node', id: 7, lat: 6.60, lon: 3.39, tags: { name: 'Agora Marketplace', shop: 'supermarket', phone: '0803 222 1111' } }] })) as unknown as typeof fetch;
    const r = await huntSellers('Indomie', KETU, { osm: new OsmSearch({ fetch: f }), db: openDb() });
    expect(r.sellers[0]).toMatchObject({ name: 'Agora Marketplace', phone: '+2348032221111', source: 'osm', sourceUrl: 'https://www.openstreetmap.org/node/7' });
  });
});

describe('the OpenStreetMap Lagos sellers', () => {
  it('load once (not again on restart), carry the OSM credit, and come back closest first', async () => {
    const { readFileSync } = await import('node:fs');
    const data = JSON.parse(readFileSync(new URL('../data/osm-lagos-sellers.json', import.meta.url), 'utf8'));
    expect(data.attribution).toMatch(/OpenStreetMap contributors/);
    expect(data.sellers.length).toBe(41);
    for (const x of data.sellers) expect(x.phone).toMatch(/^\+234[789][01]\d{8}$/);
    const db = openDb();
    expect(seedOsmSellers(db)).toBe(41);
    expect(seedOsmSellers(db)).toBe(0);
    const near = foundNear(db, KETU, 100);
    expect(near.length).toBe(41);
    expect(near[0].km).toBeLessThanOrEqual(near[1].km);
    expect(near[0]).toMatchObject({ source: 'osm' });
    expect(near[0].sourceUrl).toMatch(/^https:\/\/www\.openstreetmap\.org\//);
  });
});
