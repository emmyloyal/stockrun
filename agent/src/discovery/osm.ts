// OpenStreetMap shops near a point: free, community-mapped, and thin in Lagos (few shops have a phone number mapped).
// Overpass (bulk query by area) first; Nominatim (place search) when no Overpass server answers.
// Usage policies: identify the app, at most one Nominatim request a second, small volumes.
// https://operations.osmfoundation.org/policies/nominatim/ · https://wiki.openstreetmap.org/wiki/Overpass_API
import type { Listing } from './places.ts';

/** OSM shop=* values the hunt may ask for (the AI picks from these; anything else is ignored). */
export const OSM_SHOP_TYPES = ['supermarket', 'convenience', 'wholesale', 'general', 'variety_store', 'kiosk', 'food', 'grocery',
  'beverages', 'alcohol', 'bakery', 'butcher', 'greengrocer', 'farm', 'chemist', 'cosmetics', 'hardware', 'doityourself',
  'electronics', 'mobile_phone', 'computer', 'clothes', 'shoes', 'fabric', 'furniture', 'household_linen', 'houseware',
  'baby_goods', 'stationery', 'trade', 'building_materials', 'gas', 'agrarian', 'pet', 'toys', 'sports'] as const;
export const GROCERY_TYPES = ['supermarket', 'convenience', 'wholesale', 'general', 'variety_store', 'food', 'grocery'];

const UA = 'StockRun/1.0 (AI buying agent prototype; +https://stockrun.onrender.com)';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

interface OsmTags { name?: string; shop?: string; phone?: string; 'contact:phone'?: string; 'contact:whatsapp'?: string; mobile?: string; 'contact:mobile'?: string;
  'addr:street'?: string; 'addr:housenumber'?: string; 'addr:suburb'?: string; 'addr:city'?: string; disused?: string; [k: string]: string | undefined }

/** First listed number, preferring WhatsApp/mobile tags ("0803...; 0805..." -> "0803..."). */
const phoneOf = (t: OsmTags) => (t['contact:whatsapp'] ?? t.mobile ?? t['contact:mobile'] ?? t.phone ?? t['contact:phone'] ?? '').split(/[;,/]/)[0].trim() || null;
const addressOf = (t: OsmTags, fallback: string) =>
  [[t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '), t['addr:suburb'], t['addr:city']].filter(Boolean).join(', ') || fallback;

export class OsmSearch {
  private fetch: typeof fetch; private sleep: (ms: number) => Promise<void>;
  constructor(o: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}) {
    this.fetch = o.fetch ?? fetch; this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Named shops of these types near a point that have a phone number mapped. */
  async search(types: string[], near: { lat: number; lng: number }, radiusM = 15_000): Promise<Listing[]> {
    const shopTypes = [...new Set(types.filter((t) => (OSM_SHOP_TYPES as readonly string[]).includes(t)))].slice(0, 8);
    if (!shopTypes.length) return [];
    for (const url of OVERPASS) {
      const r = await this.overpass(url, shopTypes, near, Math.min(radiusM, 30_000)).catch(() => null);
      if (r) return r;
    }
    return this.nominatim(shopTypes, near, Math.min(radiusM, 30_000));
  }

  private async overpass(url: string, types: string[], near: { lat: number; lng: number }, radiusM: number): Promise<Listing[] | null> {
    const around = `(around:${Math.round(radiusM)},${near.lat},${near.lng})`;
    const re = `^(${types.join('|')})$`;
    const q = `[out:json][timeout:25];(${['phone', 'contact:phone', 'contact:whatsapp', 'mobile'].map((k) => `nwr${around}["shop"~"${re}"]["${k}"];`).join('')});out tags center 150;`;
    const r = await this.fetch(url, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return null;
    const j = await r.json() as { elements?: { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: OsmTags }[] };
    return (j.elements ?? []).flatMap((e): Listing[] => {
      const t = e.tags ?? {}, lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
      if (!t.name || typeof lat !== 'number' || typeof lng !== 'number') return [];
      return [{ placeId: `osm-${e.type}-${e.id}`, name: t.name, address: addressOf(t, ''), lat, lng, phone: phoneOf(t),
        mapsUrl: `https://www.openstreetmap.org/${e.type}/${e.id}`, types: t.shop ? [t.shop] : [], rating: null, open: !t.disused }];
    });
  }

  private async nominatim(types: string[], near: { lat: number; lng: number }, radiusM: number): Promise<Listing[]> {
    const d = radiusM / 111_000, dl = d / Math.cos((near.lat * Math.PI) / 180);
    const out = new Map<string, Listing>();
    for (const [i, type] of types.slice(0, 4).entries()) {
      if (i > 0) await this.sleep(1100);                                // Nominatim: at most 1 request a second
      const qs = new URLSearchParams({ q: type.replace('_', ' '), format: 'jsonv2', extratags: '1', addressdetails: '1', countrycodes: 'ng', bounded: '1', limit: '40',
        viewbox: [near.lng - dl, near.lat + d, near.lng + dl, near.lat - d].map((x) => x.toFixed(5)).join(',') });
      const r = await this.fetch(`https://nominatim.openstreetmap.org/search?${qs}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
      if (!r?.ok) continue;
      const rows = await r.json().catch(() => []) as { osm_type: string; osm_id: number; lat: string; lon: string; name?: string; type?: string; display_name?: string; extratags?: OsmTags }[];
      for (const p of rows) {
        const t = p.extratags ?? {}, lat = Number(p.lat), lng = Number(p.lon);
        if (!p.name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        out.set(`${p.osm_type}${p.osm_id}`, { placeId: `osm-${p.osm_type}-${p.osm_id}`, name: p.name, address: p.display_name?.split(',').slice(1, 4).join(',').trim() ?? '',
          lat, lng, phone: phoneOf(t), mapsUrl: `https://www.openstreetmap.org/${p.osm_type}/${p.osm_id}`, types: p.type ? [p.type] : [], rating: null, open: !t.disused });
      }
    }
    return [...out.values()];
  }
}
