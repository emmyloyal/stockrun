// StockRun HTTP server: anyone in Nigeria signs in (phone code or wallet), keeps a profile, deposits naira (Paystack)
// and asks the agent for what they want with a budget and a delivery pin.
// - Sessions: HttpOnly cookie on the same origin, or a bearer token for the app hosted elsewhere (DeWEB).
//   Every write must be JSON (with SameSite=Lax cookies that stops other websites posting for a signed-in person).
// - Naira is held by StockRun in a ledger (not on-chain); every payment decision is still a TapeOut circuit's.
// - People see only their own money, requests and orders.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { formatEther, type Hex } from 'viem';
import { STATUS, type CheckResult } from '../check/checkService.ts';
import { haversineKm, loadSuppliers, supplierKey } from '../tools/suppliers.ts';
import { ageText, type PriceBook } from '../prices/priceBook.ts';
import { Accounts, AuthError, type User } from '../accounts/accounts.ts';
import type { Buyers } from '../buyers/buyers.ts';
import { tokenAbi, type Platform } from '../chain/platform.ts';
import { verifySendrelayWebhook } from '../logistics/sendrelay.ts';
import { kobo, toNaira, LedgerError, type Ledger } from '../money/ledger.ts';
import { PaystackError, type Paystack } from '../money/paystack.ts';
import { SELF_HANDLER } from '../orders/nairaOrders.ts';
import { RESTOCK_REASONS } from '../tools/vault.ts';
import { PICKUP_REASONS, DELIVERY_REASONS } from '../check/checkService.ts';

export interface AppOptions {
  platform: Platform;
  accounts: Accounts;
  buyers: Buyers;
  ledger: Ledger;
  prices: PriceBook;
  /** Free demo naira for trying the app (labelled "not real money"); capped per tap and per day. */
  demoNaira?: boolean;
  /** Paystack for naira deposits; null: deposits are off (or test naira on the local chain). */
  paystack: Paystack | null;
  staticDir?: string;
  secureCookies?: boolean;     // true behind HTTPS
  /** Other sites allowed to call this server (CORS), e.g. the app on DeWEB. They sign in with a bearer token. */
  allowedOrigins?: string[];
  /** whsec_... from registering /api/webhooks/sendrelay with Sendrelay; webhooks are refused without it. */
  sendrelayWebhookSecret?: string;
  log?: (line: string) => void;
}

const STATUS_NAME = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k])) as Record<number, string>;
const MAX_BODY = 8 * 1024 * 1024;
const COOKIE = 'sr_session';
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
const RPC_ALLOWED = /^(eth_|net_version$|web3_clientVersion$)/;

type Ctx = { user: User | null; token: string | undefined; body: any; ip: string; m: RegExpMatchArray; url: URL };
type Handler = (c: Ctx, res: ServerResponse) => Promise<unknown>;

export function createApp(o: AppOptions): Server {
  const { platform: p, accounts, buyers, ledger, paystack } = o;
  const log = o.log ?? (() => {});
  const lastCheck = new Map<string, CheckResult>();
  const codeRequests = new Map<string, number[]>();         // per-IP limit on SMS sends

  const need = (c: Ctx): User => { if (!c.user) throw new AuthError(401, 'Sign in first.'); return c.user; };
  const signedIn = (res: ServerResponse, r: { user: User; token: string }) => {
    res.setHeader('Set-Cookie', cookie(r.token, 30 * 24 * 3600, o.secureCookies));
    log(`signed in: user ${r.user.id} (${r.user.phone ? 'phone' : 'wallet'})`);
    return { user: r.user, token: r.token };   // the token is for apps on another origin (DeWEB): `Authorization: Bearer`
  };
  const money = (userId: number) => { const b = ledger.balance(userId); return { availableNaira: toNaira(b.availableKobo), heldNaira: toNaira(b.heldKobo) }; };
  const wrap = async <T>(f: () => Promise<T> | T): Promise<T> => {
    try { return await f(); }
    catch (e) { if (e instanceof LedgerError || e instanceof PaystackError) throw new AuthError(e.status, e.message); throw e; }
  };

  function orderView(userId: number, orderId: string) {
    const rt = buyers.runtime(userId), job = rt.jobs.get(orderId), r = buyers.orders.get(orderId);
    if (!job || !r || r.user_id !== userId) return null;
    return {
      ...job, money: 'naira' as const, self: r.rider.toLowerCase() === SELF_HANDLER.toLowerCase(),
      status: STATUS_NAME[r.status] ?? 'Unknown', ordered: r.ordered, unitPriceNaira: toNaira(r.unit_price), riderFeeNaira: toNaira(r.rider_fee),
      pickup: { atSupplier: !!r.at_supplier, riderCounted: !!r.rider_counted, riderCount: r.rider_count, aiCounted: !!r.ai_counted, aiCount: r.ai_count, damage: !!r.pickup_damage, picked: r.picked },
      delivery: { atShop: !!r.at_shop, arrivedAt: r.arrived_at, aiCounted: !!r.ai_delivered, delivered: r.delivered, damage: !!r.delivery_damage, ownerOk: !!r.owner_ok, ownerIssue: !!r.owner_issue },
      evidence: JSON.parse(r.evidence), lastCheck: lastCheck.get(`${userId}:${orderId}`) ?? null,
    };
  }
  const myOrder = (c: Ctx) => {
    const u = need(c), r = buyers.orders.get(c.m[1]);
    if (!r || r.user_id !== u.id) throw new AuthError(404, 'No such order.');
    return { u, r, rt: buyers.runtime(u.id) };
  };
  const remember = (userId: number, orderId: string, r: { outcome: string; qty: number; reason: number; tx: string }, stage: 'pickup' | 'delivery') => {
    const message = (stage === 'pickup' ? PICKUP_REASONS : DELIVERY_REASONS)[r.outcome === 'short' ? 4 : r.reason] ?? '';
    const v = { status: 'settled', outcome: r.outcome, qty: r.qty, reason: r.reason, message } as unknown as CheckResult;
    lastCheck.set(`${userId}:${orderId}`, v);
    return v;
  };

  const routes: [string, RegExp, Handler][] = [
    // ---------------------------------------------------------------- sign-in
    ['POST', /^\/api\/auth\/code$/, async (c) => {
      const t = Date.now(), hits = (codeRequests.get(c.ip) ?? []).filter((x) => x > t - 3600_000);
      if (hits.length >= 20) throw new AuthError(429, 'Too many sign-in attempts from this network. Try again later.');
      codeRequests.set(c.ip, [...hits, t]);
      await accounts.requestCode(String(c.body?.phone ?? ''));
      return { sent: true };
    }],
    ['POST', /^\/api\/auth\/verify$/, async (c, res) => signedIn(res, accounts.verifyCode(String(c.body?.phone ?? ''), String(c.body?.code ?? '')))],
    ['GET', /^\/api\/auth\/wallet-message$/, async (c) => accounts.walletChallenge(c.url.searchParams.get('address') ?? '')],
    ['POST', /^\/api\/auth\/wallet$/, async (c, res) => signedIn(res, await accounts.verifyWallet(String(c.body?.message ?? ''), String(c.body?.signature ?? '0x') as Hex))],
    ['POST', /^\/api\/auth\/logout$/, async (c, res) => {
      if (c.token) accounts.signOut(c.token);
      res.setHeader('Set-Cookie', cookie('', 0, o.secureCookies));
      return { ok: true };
    }],

    // ---------------------------------------------------------------- me
    ['GET', /^\/api\/config$/, async () => ({
      chainId: p.chain.id, network: p.name, token: p.token, tokenSymbol: p.tokenSymbol, explorerTx: p.explorerTx,
      naira: { paystack: !!paystack, test: paystack?.test ?? true, testCredit: !!o.demoNaira || (!paystack && !!p.faucet) },
      logistics: p.carriers.map((x) => ({ id: x.id, name: x.name, api: !!x.connector })),
    })],
    ['GET', /^\/api\/me$/, async (c) => (c.user ? { user: c.user, naira: money(c.user.id) } : { user: null })],
    ['POST', /^\/api\/me\/profile$/, async (c) => ({ user: accounts.setProfile(need(c), c.body ?? {}) })],
    ['POST', /^\/api\/me\/avatar$/, async (c) => {
      const u = need(c);
      if (typeof c.body?.data !== 'string') throw new AuthError(400, 'Send the picture as base64.');
      return { user: accounts.setAvatar(u, Buffer.from(c.body.data, 'base64'), String(c.body?.mediaType ?? '')) };
    }],
    ['POST', /^\/api\/me\/phone$/, async (c) => ({ user: accounts.addPhone(need(c), String(c.body?.phone ?? ''), String(c.body?.code ?? '')) })],
    ['POST', /^\/api\/me\/wallet$/, async (c) => ({ user: await accounts.addWallet(need(c), String(c.body?.message ?? ''), String(c.body?.signature ?? '0x') as Hex) })],
    /** Coins in the connected wallet on X Layer (read from the chain; StockRun never holds them). */
    ['GET', /^\/api\/me\/coins$/, async (c) => {
      const u = need(c);
      if (!u.wallet) return { wallet: null };
      const [okb, token] = await Promise.all([
        p.pub.getBalance({ address: u.wallet }),
        p.pub.readContract({ address: p.token, abi: tokenAbi, functionName: 'balanceOf', args: [u.wallet] }),
      ]);
      return { wallet: u.wallet, network: p.name, okb: formatEther(okb), token: { symbol: p.tokenSymbol, amount: p.money.toNaira(token) === 0 ? '0' : String(Number(token) / 1e6), naira: p.money.toNaira(token) } };
    }],
    ['GET', /^\/api\/users\/(\d+)$/, async (c) => {
      const prof = accounts.publicProfile(Number(c.m[1]));
      if (!prof) throw new AuthError(404, 'No such user.');
      return prof;
    }],

    // ---------------------------------------------------------------- naira
    ['POST', /^\/api\/naira\/deposit$/, async (c) => {
      const u = need(c);
      if (!paystack) throw new AuthError(503, 'Naira deposits are not switched on yet on this server.');
      return wrap(() => paystack.start(u.id, kobo(Number(c.body?.amountNaira)), String(c.body?.email ?? '').trim()));
    }],
    ['POST', /^\/api\/naira\/confirm$/, async (c) => {
      const u = need(c);
      if (!paystack) throw new AuthError(503, 'Naira deposits are not switched on yet on this server.');
      const r = await wrap(() => paystack.confirm(String(c.body?.reference ?? ''), u.id));
      return { ...r, amountNaira: toNaira(r.amountKobo), naira: money(u.id) };
    }],
    ['GET', /^\/api\/naira\/history$/, async (c) => ledger.history(need(c).id).map((m) => ({ ...m, amountNaira: toNaira(m.amountKobo) }))],
    /** Demo naira to try StockRun without money: on the local chain, or when the server switches it on. Labelled. */
    ['POST', /^\/api\/dev\/naira$/, async (c) => {
      const u = need(c);
      if (!o.demoNaira && (paystack || !p.faucet)) throw new AuthError(404, 'Demo naira is not switched on here.');
      const n = Math.round(Number(c.body?.amountNaira));
      if (!(n >= 100 && n <= 500_000)) throw new AuthError(400, 'Demo naira: from ₦100 to ₦500,000 at a time.');
      if (ledger.demoSince(u.id, Date.now() - 24 * 3600_000) + kobo(n) > kobo(2_000_000)) throw new AuthError(429, 'That is the demo limit for today (₦2,000,000).');
      ledger.demoCredit(u.id, `${u.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kobo(n));
      return { naira: money(u.id) };
    }],

    // ---------------------------------------------------------------- requests and orders
    ['POST', /^\/api\/requests$/, async (c) => wrap(() => buyers.request(need(c), c.body ?? {}))],
    ['GET', /^\/api\/requests$/, async (c) => buyers.requests(need(c).id)],
    ['GET', /^\/api\/orders$/, async (c) => {
      const u = need(c), rt = buyers.runtime(u.id);
      await buyers.dispatcher.bookPending(rt.dispatch).catch(() => {});   // e.g. an order the buyer just approved
      return rt.jobs.all().sort((a, b) => b.createdAt - a.createdAt).map((j) => orderView(u.id, j.orderId)).filter(Boolean);
    }],
    ['POST', /^\/api\/orders\/(\d+)\/approve$/, async (c) => {
      const { u, rt } = myOrder(c);
      const r = await wrap(() => buyers.orders.approve(u.id, Number(c.m[1])));
      await buyers.dispatcher.bookPending(rt.dispatch).catch(() => {});
      return { result: r.status, reason: 'reason' in r ? RESTOCK_REASONS[r.reason] ?? '' : '' };
    }],
    /** Self-pickup: the buyer's count at the seller pays the seller (PickupCheck decides). */
    ['POST', /^\/api\/orders\/(\d+)\/collect$/, async (c) => {
      const { u, r } = myOrder(c);
      if (r.rider.toLowerCase() !== SELF_HANDLER.toLowerCase()) throw new AuthError(409, 'A logistics company is collecting this order.');
      const n = Number(c.body?.count);
      try { buyers.orders.handlerPickup(SELF_HANDLER, r.id, true, n); } catch (e) { throw new AuthError(409, (e as Error).message); }
      const s = await wrap(() => buyers.runtime(u.id).naira.settlePickup(c.m[1]));
      return remember(u.id, c.m[1], s, 'pickup');
    }],
    /** Logistics delivery: the buyer's count at the door decides the fee (DeliveryCheck). */
    ['POST', /^\/api\/orders\/(\d+)\/received$/, async (c) => {
      const { u, rt } = myOrder(c);
      try { return await buyers.dispatcher.ownerCount(rt.dispatch, c.m[1], Number(c.body?.count)); }
      catch (e) { throw new AuthError(409, (e as Error).message); }
      finally { void u; }
    }],

    // ---------------------------------------------------------------- the map
    /** Verified sellers near a point, with their latest prices. Public: anyone can look before signing in. */
    ['GET', /^\/api\/map$/, async (c) => {
      const lat = Number(c.url.searchParams.get('lat')), lng = Number(c.url.searchParams.get('lng'));
      const radius = Math.min(100, Math.max(1, Number(c.url.searchParams.get('radius') ?? 25)));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new AuthError(400, 'lat and lng are needed.');
      const sellers = loadSuppliers().map((s) => ({ s, km: haversineKm({ lat, lng }, s) })).filter((x) => x.km <= radius).sort((a, b) => a.km - b.km).slice(0, 50);
      return {
        center: { lat, lng }, radiusKm: radius,
        sellers: sellers.map(({ s, km }) => ({
          id: s.id, key: supplierKey(s.id), name: s.name, market: s.market, lat: s.lat, lng: s.lng, simulated: s.simulated, verified: buyers.sellerStatus(supplierKey(s.id)) === 1,
          km: Math.round(km * 10) / 10,
          prices: s.stocks.map((st) => {
            const latest = o.prices.latest(s.id, st.item);
            return latest ? { item: st.item, priceNaira: latest.unitPriceNaira, source: latest.source, age: ageText(latest.at) } : { item: st.item, priceNaira: st.listPriceNaira, source: 'catalogue', age: null };
          }),
        })),
      };
    }],
  ];

  // Sendrelay status webhooks: signature checked on the raw body; each event once; the task is re-read from Sendrelay.
  const seenEvents = new Set<string>();
  async function sendrelayWebhook(req: IncomingMessage, res: ServerResponse) {
    if (!o.sendrelayWebhookSecret) return send(res, 404, { error: 'not found' });
    const raw = await readBody(req);
    let ev;
    try { ev = verifySendrelayWebhook(raw, req.headers['x-relay-signature'] as string | undefined, o.sendrelayWebhookSecret); }
    catch (e) { log(`sendrelay webhook refused: ${(e as Error).message}`); return send(res, 401, { error: 'bad signature' }); }
    send(res, 200, { ok: true });
    if (seenEvents.has(ev.id)) return;
    seenEvents.add(ev.id);
    const entry = buyers.dispatcher.entries.find((e) => e.id === 'sendrelay');
    const found = buyers.dispatcher.find(buyers.dispatchSets(), ev.data.taskId);
    if (!entry?.connector || !found) return;
    try { await buyers.dispatcher.apply(found.shop, found.orderId, await entry.connector.get(ev.data.taskId)); }
    catch (e) { log(`sendrelay ${ev.type} for order ${found.orderId}: ${(e as Error).message}`); }
  }
  // Paystack webhooks: signature checked on the raw body, then the payment is verified with Paystack before crediting.
  async function paystackWebhook(req: IncomingMessage, res: ServerResponse) {
    if (!paystack) return send(res, 404, { error: 'not found' });
    const raw = await readBody(req);
    let ev;
    try { ev = paystack.verifyWebhook(raw, req.headers['x-paystack-signature'] as string | undefined); }
    catch { return send(res, 401, { error: 'bad signature' }); }
    send(res, 200, { ok: true });
    if (ev.event === 'charge.success' && ev.reference) await paystack.confirm(ev.reference).catch((e) => log(`paystack ${ev.reference}: ${(e as Error).message}`));
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = req.headers.origin;
    if (origin && o.allowedOrigins?.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    }
    const bearer = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const token = bearer ?? readCookie(req.headers.cookie, COOKIE);
    const user = accounts.session(token);
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() || req.socket.remoteAddress || '?';
    try {
      if (url.pathname === '/api/webhooks/sendrelay' && req.method === 'POST') return await sendrelayWebhook(req, res);
      if (url.pathname === '/api/webhooks/paystack' && req.method === 'POST') return await paystackWebhook(req, res);
      const avatar = /^\/api\/users\/(\d+)\/avatar$/.exec(url.pathname);
      if (avatar && req.method === 'GET') {
        const a = accounts.avatar(Number(avatar[1]));
        if (!a) return send(res, 404, { error: 'no picture' });
        res.writeHead(200, { 'Content-Type': a.type, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
        return res.end(a.data);
      }
      if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json'))
        throw new AuthError(415, 'Send JSON.');
      if (url.pathname === '/rpc' && req.method === 'POST') {
        if (!user) throw new AuthError(401, 'Sign in first.');
        return await proxyRpc(req, res, p.rpcUrl);
      }
      const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
      if (route) {
        const body = req.method === 'POST' ? await readJson(req) : undefined;
        const m = url.pathname.match(route[1])!;
        return send(res, 200, await route[2]({ user, token, body, ip, m, url }, res));
      }
      if (req.method === 'GET' && o.staticDir) return serveStatic(res, o.staticDir, url.pathname);
      send(res, 404, { error: 'not found' });
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 500;
      if (status === 500) log(`error: ${(e as Error).stack ?? e}`);
      send(res, status, { error: status === 500 ? 'Something went wrong. Nothing was paid; try again.' : (e as Error).message });
    }
  });
}

function cookie(token: string, maxAge: number, secure?: boolean) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function readCookie(header: string | undefined, name: string) {
  return header?.split(';').map((s) => s.trim().split('=')).find(([k]) => k === name)?.[1];
}
function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new AuthError(413, 'Too large: photos under 5 MB please.'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}
async function readJson(req: IncomingMessage) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new AuthError(400, 'Body must be JSON.'); }
}
async function proxyRpc(req: IncomingMessage, res: ServerResponse, rpcUrl: string) {
  const raw = await readBody(req);
  let calls: { method?: string }[];
  try { const j = JSON.parse(raw.toString('utf8')); calls = Array.isArray(j) ? j : [j]; } catch { return send(res, 400, { error: 'bad JSON-RPC' }); }
  if (!calls.length || calls.length > 20 || !calls.every((c) => typeof c.method === 'string' && RPC_ALLOWED.test(c.method))) return send(res, 403, { error: 'RPC method not allowed' });
  const r = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw.toString('utf8') });
  res.writeHead(r.status, { 'Content-Type': 'application/json' });
  res.end(Buffer.from(await r.arrayBuffer()));
}
function serveStatic(res: ServerResponse, dir: string, path: string) {
  const safe = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
  if (safe.split(/[/\\]/).includes('..')) return send(res, 400, { error: 'bad path' });
  let file = join(dir, safe);
  if (!safe || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
  if (!existsSync(file)) return send(res, 404, { error: 'App not built: run `npm run build` in app/.' });
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}
