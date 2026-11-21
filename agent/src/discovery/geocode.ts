// Place search for delivery addresses and the map's search box ("Mile 12", "12 Ikorodu Road, Ketu").
// Three sources, tried in order, so one service refusing does not stop buyers:
//   1. Nominatim (OpenStreetMap). Its policy: identify the app, at most one request a second, cache results.
//      Cloud servers' shared addresses are sometimes refused; after a refusal it is skipped for 10 minutes.
//   2. Photon (komoot), another free OpenStreetMap search.
//   3. data/lagos-areas.json: Lagos areas with their centre points, matched by name in the address (works offline).
// https://operations.osmfoundation.org/policies/nominatim/ · https://photon.komoot.io
import { readFileSync } from 'node:fs';

export interface PlaceHit { name: string; address: string; lat: number; lng: number; kind: string }

const UA = 'StockRun/1.0 (AI buying agent prototype; +https://stockrun.onrender.com)';
const NIGERIA = (lat: number, lng: number) => lat > 4.0 && lat < 14.0 && lng > 2.6 && lng < 14.7;

interface Area { name: string; lat: number; lng: number }
let areasCache: Area[] | null = null;
export function lagosAreas(): Area[] {
  if (!areasCache) areasCache = (JSON.parse(readFileSync(new URL('../../data/lagos-areas.json', import.meta.url), 'utf8')) as { areas: Area[] }).areas;
  return areasCache;
}

const ROAD = /^(road|rd|street|st|avenue|ave|way|expressway|express|close|crescent|lane|drive|motor|highway|bypass|link)\b/;

/**
 * The Lagos area an address names ("12 Ikorodu Road, Ketu" -> Ketu). A name used as part of a street ("Ikorodu Road")
 * does not count; addresses run street, area, city, so the area named last wins, then the longest ("Lekki Phase 1").
 */
export function areaIn(address: string, areas: Area[] = lagosAreas()): PlaceHit | null {
  const text = ` ${address.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  let best: { a: Area; at: number } | null = null;
  for (const a of areas) {
    const needle = ` ${a.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
      if (ROAD.test(text.slice(at + needle.length))) continue;
      if (!best || at > best.at || (at === best.at && a.name.length > best.a.name.length)) best = { a, at };
    }
  }
  return best ? { name: best.a.name, address: 'Lagos', lat: best.a.lat, lng: best.a.lng, kind: 'area (approximate)' } : null;
}

export class Geocoder {
  private fetch: typeof fetch; private now: () => number; private sleep: (ms: number) => Promise<void>; private log: (l: string) => void;
  private cache = new Map<string, { at: number; hits: PlaceHit[] }>();
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;
  private nominatimOffUntil = 0;
  constructor(o: { fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (l: string) => void } = {}) {
    this.fetch = o.fetch ?? fetch; this.now = o.now ?? Date.now; this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = o.log ?? ((l) => console.warn(`[geocode] ${l}`));
  }

  /** Up to 5 places in Nigeria matching `q`, best first. Cached for a day. */
  async search(q: string): Promise<PlaceHit[]> {
    const key = q.trim().toLowerCase().replace(/\s+/g, ' ');
    if (key.length < 3) return [];
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < 24 * 3600_000) return cached.hits;
    let hits = await this.nominatim(key).catch((e) => { this.log(`Nominatim: ${(e as Error).message}`); return [] as PlaceHit[]; });
    if (!hits.length) hits = await this.photon(key).catch((e) => { this.log(`Photon: ${(e as Error).message}`); return [] as PlaceHit[]; });
    if (!hits.length) { const a = areaIn(key); if (a) hits = [a]; }
    if (hits.length) {                                        // misses are not cached: a service may answer next time
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { at: this.now(), hits });
    }
    return hits;
  }

  private async nominatim(key: string): Promise<PlaceHit[]> {
    if (this.now() < this.nominatimOffUntil) return [];
    const run = this.queue.then(async () => {
      const wait = this.last + 1100 - this.now();
      if (wait > 0) await this.sleep(wait);
      this.last = this.now();
      const qs = new URLSearchParams({ q: key, format: 'jsonv2', countrycodes: 'ng', limit: '5', addressdetails: '0' });
      const r = await this.fetch(`https://nominatim.openstreetmap.org/search?${qs}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) {
        if (r.status === 403 || r.status === 429) this.nominatimOffUntil = this.now() + 10 * 60_000;
        throw new Error(`refused (${r.status})`);
      }
      const rows = await r.json() as { name?: string; display_name?: string; lat: string; lon: string; type?: string; category?: string }[];
      return rows.flatMap((p): PlaceHit[] => {
        const lat = Number(p.lat), lng = Number(p.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !NIGERIA(lat, lng)) return [];
        const parts = (p.display_name ?? '').split(',').map((x) => x.trim());
        return [{ name: p.name || parts[0] || key, address: parts.slice(1, 4).join(', '), lat, lng, kind: (p.type ?? p.category ?? 'place').replace(/_/g, ' ') }];
      });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async photon(key: string): Promise<PlaceHit[]> {
    const qs = new URLSearchParams({ q: key, limit: '5', lang: 'en', lat: '6.5244', lon: '3.3792', bbox: '2.6,4.0,14.7,14.0' });
    const r = await this.fetch(`https://photon.komoot.io/api/?${qs}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`refused (${r.status})`);
    const j = await r.json() as { features?: { geometry?: { coordinates?: [number, number] }; properties?: Record<string, string | undefined> }[] };
    return (j.features ?? []).flatMap((f): PlaceHit[] => {
      const [lng, lat] = f.geometry?.coordinates ?? [NaN, NaN], p = f.properties ?? {};
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !NIGERIA(lat, lng) || (p.countrycode && p.countrycode !== 'NG')) return [];
      const name = p.name ?? [p.housenumber, p.street].filter(Boolean).join(' ') ?? key;
      return [{ name: name || key, address: [p.street && p.name ? p.street : undefined, p.district ?? p.locality, p.city ?? p.county, p.state].filter(Boolean).join(', '), lat, lng, kind: (p.osm_value ?? 'place').replace(/_/g, ' ') }];
    });
  }
}
