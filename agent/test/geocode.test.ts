import { describe, expect, it } from 'vitest';
import { Geocoder, areaIn } from '../src/discovery/geocode.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const quiet = { sleep: async () => {}, log: () => {} };

describe('finding a delivery address', () => {
  it('uses Nominatim when it answers', async () => {
    const f = (async (url: string) => {
      expect(url).toContain('nominatim');
      return json([{ name: 'Ikorodu Road', display_name: 'Ikorodu Road, Mile 12, Kosofe, Lagos', lat: '6.6115', lon: '3.4191', type: 'trunk' }]);
    }) as unknown as typeof fetch;
    const [hit] = await new Geocoder({ fetch: f, ...quiet }).search('12 Ikorodu Road, Ketu');
    expect(hit).toMatchObject({ name: 'Ikorodu Road', lat: 6.6115, lng: 3.4191 });
  });

  it('falls back to Photon when Nominatim refuses, and leaves Nominatim alone for 10 minutes', async () => {
    let t = 1_000_000; const urls: string[] = []; const logs: string[] = [];
    const f = (async (url: string) => {
      urls.push(url.split('?')[0]);
      if (url.includes('nominatim')) return new Response('blocked', { status: 403 });
      return json({ features: [{ geometry: { coordinates: [3.3516, 6.6016] }, properties: { name: 'Ikeja', countrycode: 'NG', state: 'Lagos', osm_value: 'suburb' } }] });
    }) as unknown as typeof fetch;
    const g = new Geocoder({ fetch: f, now: () => t, sleep: async () => {}, log: (l) => logs.push(l) });
    expect((await g.search('Ikeja'))[0]).toMatchObject({ name: 'Ikeja', lat: 6.6016, lng: 3.3516 });
    expect(logs[0]).toMatch(/Nominatim: refused \(403\)/);
    await g.search('Yaba');
    expect(urls.filter((u) => u.includes('nominatim'))).toHaveLength(1);          // skipped the second time
    t += 11 * 60_000;
    await g.search('Surulere');
    expect(urls.filter((u) => u.includes('nominatim'))).toHaveLength(2);          // tried again after 10 minutes
  });

  it('falls back to the Lagos area named in the address when every service fails', async () => {
    const f = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const [hit] = await new Geocoder({ fetch: f, ...quiet }).search('12 Ikorodu Road, Ketu');
    expect(hit).toMatchObject({ name: 'Ketu', kind: 'area (approximate)' });
    expect(hit.lat).toBeCloseTo(6.593, 2);
  });

  it('matches area names as whole words, longest first, and ignores Nigeria-outside results', async () => {
    expect(areaIn('Plot 5, Admiralty Way, Lekki Phase 1')?.name).toBe('Lekki Phase 1');
    expect(areaIn('Allen Avenue, Ikeja GRA, Lagos')?.name).toBe('Ikeja GRA');
    expect(areaIn('ikeja')?.name).toBe('Ikeja');
    expect(areaIn('Yabatech hostel')).toBeNull();                                   // "yaba" inside a word is not Yaba
    expect(areaIn('Somewhere in Abuja')).toBeNull();
    const f = (async (url: string) => url.includes('nominatim') ? json([{ name: 'Lagos, Portugal', lat: '37.1', lon: '-8.6' }]) : json({ features: [] })) as unknown as typeof fetch;
    expect(await new Geocoder({ fetch: f, ...quiet }).search('Lagos')).toEqual([]);   // not in Nigeria, no area named "Lagos"
  });
});

describe('area names inside street names', () => {
  it('does not mistake a street for the area', () => {
    expect(areaIn('12 Ikorodu Road, Ketu')?.name).toBe('Ketu');
    expect(areaIn('Agege Motor Road, Mushin, Lagos')?.name).toBe('Mushin');
    expect(areaIn('Ikorodu')?.name).toBe('Ikorodu');
    expect(areaIn('Ikeja Along, Ikorodu')?.name).toBe('Ikorodu');                  // the area named last
  });
});
