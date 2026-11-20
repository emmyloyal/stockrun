// Web search for sellers who publish a phone or WhatsApp number (Jiji listings, shop sites, Instagram bios...).
// Gemini searches Google (grounding) and reports what it found. The model can invent numbers, so nothing it says is
// trusted: each number is kept only if the server itself downloads the cited page and finds that number on it.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { models, type Generate } from '../llm.ts';

export interface WebClaim { name: string; area: string; phone: string; sourceUrl: string }
export interface WebFind extends WebClaim { /** The page the number was found on (after redirects). */ verifiedUrl: string }

const ClaimsSchema = z.object({
  sellers: z.array(z.object({
    name: z.string(), area: z.string(), phone: z.string(),
    sourceUrl: z.string().describe('The exact page where this phone number is published'),
  })).max(10),
});

const system = `You find real businesses in Nigeria that sell a product, using Google Search. Only report a business when a
web page you found publishes its phone or WhatsApp number. Copy the number exactly as written on the page and give that
page's URL. Never guess or complete a number. If you find none, return an empty list.
Answer with JSON only: {"sellers":[{"name":"","area":"","phone":"","sourceUrl":""}]}`;

/** Digits of a Nigerian number as its 10 national significant digits ("0803 123 4567" / "+234 803..." -> "8031234567"). */
export function nationalDigits(phone: string): string | null {
  const d = phone.replace(/\D/g, '');
  const m = d.match(/^(?:234|0)?([789][01]\d{8})$/);
  return m ? m[1] : null;
}

/** Does the page text contain this number, written in any usual way (+234, 0, spaces, dashes, dots)? */
export function pageHasNumber(pageText: string, phone: string): boolean {
  const want = nationalDigits(phone);
  if (!want) return false;
  // Collapse digit runs broken by separators, then look for the 10 digits with a 0/234 prefix or none.
  const digits = pageText.replace(/(\d)[\s\-.()/]{1,3}(?=\d)/g, '$1');
  return new RegExp(`(?:^|\\D)(?:\\+?234|0)?${want}(?!\\d)`).test(digits);
}

const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^f[cd]/i, /^fe80/i, /^::ffff:(127|10|192\.168|169\.254)\./i];

/** Only public https pages: no IP literals, no hosts that resolve to private or internal addresses. */
async function safeUrl(raw: string): Promise<URL | null> {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  try {
    const addrs = await lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => PRIVATE.some((p) => p.test(a.address)))) return null;
  } catch { return null; }
  return u;
}

/** Download a page's text (redirects followed by hand so each hop is checked; 1.5 MB, 10 s). Null when not allowed. */
export async function fetchPageText(raw: string, f: typeof fetch = fetch, check: (u: string) => Promise<URL | null> = safeUrl): Promise<{ url: string; text: string } | null> {
  let next = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await check(next);
    if (!u) return null;
    const r = await f(u, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'StockRunBot/1.0 (seller number check)', Accept: 'text/html,text/plain' } }).catch(() => null);
    if (!r) return null;
    if (r.status >= 300 && r.status < 400) { const loc = r.headers.get('location'); if (!loc) return null; next = new URL(loc, u).toString(); continue; }
    if (!r.ok || !/text\/|html|json/.test(r.headers.get('content-type') ?? 'text/html')) return null;
    const reader = r.body?.getReader(); if (!reader) return null;
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length; chunks.push(value);
      if (size > 1_500_000) { await reader.cancel(); break; }
    }
    const html = Buffer.concat(chunks).toString('utf8');
    // Numbers often live only in tel:/wa.me links, inside tags: collect those first, then drop the markup.
    const linked = [...html.matchAll(/(?:tel:|wa\.me\/|phone=)(\+?[\d%\-.]{7,20})/gi)].map((m) => { try { return decodeURIComponent(m[1]); } catch { return m[1]; } });
    const visible = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ');
    return { url: u.toString(), text: `${visible}\n${linked.join('\n')}` };
  }
  return null;
}

export class WebSellerSearch {
  private generate: Generate; private fetch: typeof fetch; private check?: (u: string) => Promise<URL | null>;
  constructor(o: { generate: Generate; fetch?: typeof fetch; check?: (u: string) => Promise<URL | null> }) {
    this.generate = o.generate; this.fetch = o.fetch ?? fetch; this.check = o.check;
  }

  /** Sellers of `product` near `area` whose number is on the page cited. Unverifiable claims are dropped, not trusted. */
  async find(product: string, area: string): Promise<{ found: WebFind[]; dropped: number; sources: string[] }> {
    let res: Awaited<ReturnType<Generate>> | null = null;
    for (const m of models()) {
      try {
        res = await this.generate({
          model: m,
          contents: [{ role: 'user', parts: [{ text: `Product: ${product}\nNear: ${area}, Nigeria\nFind up to 6 sellers (wholesalers, distributors or shops).` }] }],
          config: { systemInstruction: system, tools: [{ googleSearch: {} }], maxOutputTokens: 3000 },
        });
        break;
      } catch (e) { console.warn(`[web search] ${m} failed: ${(e as Error).message.slice(0, 160)}`); }
    }
    if (!res?.text) return { found: [], dropped: 0, sources: [] };
    const sources = (res.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []).map((c) => c.web?.uri).filter((u): u is string => !!u);
    const json = res.text.slice(res.text.indexOf('{'), res.text.lastIndexOf('}') + 1);
    let claims: WebClaim[] = [];
    try { const p = ClaimsSchema.safeParse(JSON.parse(json)); if (p.success) claims = p.data.sellers; } catch { /* nothing usable */ }

    const found: WebFind[] = []; let dropped = 0;
    for (const c of claims) {
      if (!nationalDigits(c.phone)) { dropped++; continue; }
      // Check the page the model cited, then the search results Google returned, until one shows the number.
      let ok: WebFind | null = null;
      for (const url of [c.sourceUrl, ...sources].filter((u, i, a) => u && a.indexOf(u) === i).slice(0, 4)) {
        const page = await fetchPageText(url, this.fetch, this.check);
        if (page && pageHasNumber(page.text, c.phone)) { ok = { ...c, verifiedUrl: page.url }; break; }
      }
      if (ok) found.push(ok); else dropped++;
    }
    return { found, dropped, sources };
  }
}
