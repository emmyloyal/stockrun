// Place search for the map's search box ("Mile 12", "Ikeja City Mall"), through OpenStreetMap's Nominatim.
// Nominatim's policy: identify the app, at most one request a second, cache results. All three are done here, so
// every app user's searches share one polite queue. https://operations.osmfoundation.org/policies/nominatim/
export interface PlaceHit { name: string; address: string; lat: number; lng: number; kind: string }

const UA = 'StockRun/1.0 (AI buying agent prototype; +https://stockrun.onrender.com)';

export class Geocoder {
  private fetch: typeof fetch; private now: () => number; private sleep: (ms: number) => Promise<void>;
  private cache = new Map<string, { at: number; hits: PlaceHit[] }>();
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;
  constructor(o: { fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.fetch = o.fetch ?? fetch; this.now = o.now ?? Date.now; this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Up to 5 places in Nigeria matching `q`, best first. Cached for a day; requests are spaced a second apart. */
  async search(q: string): Promise<PlaceHit[]> {
    const key = q.trim().toLowerCase().replace(/\s+/g, ' ');
    if (key.length < 3) return [];
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < 24 * 3600_000) return hit.hits;
    const run = this.queue.then(async () => {
      const wait = this.last + 1100 - this.now();
      if (wait > 0) await this.sleep(wait);
      this.last = this.now();
      const qs = new URLSearchParams({ q: key, format: 'jsonv2', countrycodes: 'ng', limit: '5', addressdetails: '0' });
      const r = await this.fetch(`https://nominatim.openstreetmap.org/search?${qs}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`place search failed (${r.status})`);
      const rows = await r.json() as { name?: string; display_name?: string; lat: string; lon: string; type?: string; category?: string }[];
      return rows.flatMap((p): PlaceHit[] => {
        const lat = Number(p.lat), lng = Number(p.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
        const parts = (p.display_name ?? '').split(',').map((x) => x.trim());
        return [{ name: p.name || parts[0] || key, address: parts.slice(p.name ? 1 : 1, 4).join(', '), lat, lng, kind: (p.type ?? p.category ?? 'place').replace(/_/g, ' ') }];
      });
    });
    this.queue = run.catch(() => undefined);
    const hits = await run;
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { at: this.now(), hits });
    return hits;
  }
}
