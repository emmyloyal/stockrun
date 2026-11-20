// Google Maps business listings through the Places API (New) Text Search. Each result is a real listing with a map pin
// and, when the business gave one, a phone number: these come from Google's data, never from the AI.
// Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
export interface Listing {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  /** As Google lists it, e.g. "+234 803 123 4567"; null when the business has none. */
  phone: string | null;
  mapsUrl: string | null;
  types: string[];
  rating: number | null;
  open: boolean;           // false when Google marks it closed (temporarily or for good)
}

// Phone numbers are an "Enterprise" field: keep the mask to what we use, since the mask sets the price per call.
const FIELDS = ['places.id', 'places.displayName', 'places.formattedAddress', 'places.location', 'places.internationalPhoneNumber',
  'places.nationalPhoneNumber', 'places.googleMapsUri', 'places.types', 'places.rating', 'places.businessStatus'].join(',');

export class PlacesSearch {
  private key: string; private fetch: typeof fetch;
  constructor(o: { apiKey: string; fetch?: typeof fetch }) { this.key = o.apiKey; this.fetch = o.fetch ?? fetch; }

  /** Businesses matching `query` near a point (results outside the circle can still appear, ranked lower). */
  async search(query: string, near: { lat: number; lng: number }, radiusM = 15_000, max = 10): Promise<Listing[]> {
    const r = await this.fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.key, 'X-Goog-FieldMask': FIELDS },
      body: JSON.stringify({
        textQuery: query, regionCode: 'NG', languageCode: 'en', pageSize: Math.min(20, max),
        locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: Math.min(50_000, radiusM) } },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json().catch(() => ({})) as { places?: RawPlace[]; error?: { message?: string; status?: string } };
    if (!r.ok) throw new Error(`Google Maps search failed (${r.status} ${j.error?.status ?? ''}: ${j.error?.message ?? 'no detail'})`);
    return (j.places ?? []).flatMap((p): Listing[] => {
      const lat = p.location?.latitude, lng = p.location?.longitude;
      if (!p.id || typeof lat !== 'number' || typeof lng !== 'number') return [];
      return [{
        placeId: p.id, name: p.displayName?.text?.trim() || 'Unnamed business', address: p.formattedAddress ?? '', lat, lng,
        phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null, mapsUrl: p.googleMapsUri ?? null,
        types: p.types ?? [], rating: typeof p.rating === 'number' ? p.rating : null,
        open: !p.businessStatus || p.businessStatus === 'OPERATIONAL',
      }];
    });
  }
}

interface RawPlace {
  id?: string; displayName?: { text?: string }; formattedAddress?: string; location?: { latitude?: number; longitude?: number };
  internationalPhoneNumber?: string; nationalPhoneNumber?: string; googleMapsUri?: string; types?: string[]; rating?: number; businessStatus?: string;
}
