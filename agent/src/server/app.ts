// Multi-shop HTTP server for real owners and riders.
// - Sign-in: phone number + SMS code -> HttpOnly session cookie. Every write must be JSON (with SameSite=Lax cookies,
//   that stops other websites from posting on a user's behalf).
// - Keys stay on phones: owners and riders sign their own vault steps in the browser and send them through /rpc.
//   This server holds only the deployer key (creates vaults), the agent key (proposes) and the check key (attests).
// - Owners see only their own shop. Riders see and act only on jobs booked to their own key.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { parseAbi, type Address, type Hex } from 'viem';
import { handleOrder } from '../agent.ts';
import { checkAbi, STATUS, type CheckResult } from '../check/checkService.ts';
import type { Job } from '../check/jobs.ts';
import type { MediaType } from '../check/photoCount.ts';
import { haversineKm, loadSuppliers, supplierKey } from '../tools/suppliers.ts';
import { ageText } from '../prices/priceBook.ts';
import { Accounts, AuthError, linkMessage, type Role, type User } from '../accounts/accounts.ts';
import type { Shops, ShopRuntime } from '../accounts/shops.ts';
import { tokenAbi, type Platform } from '../chain/platform.ts';
import { verifySendrelayWebhook } from '../logistics/sendrelay.ts';

export interface AppOptions {
  platform: Platform;
  accounts: Accounts;
  shops: Shops;
  staticDir?: string;
  secureCookies?: boolean;     // true behind HTTPS
  /**
   * Other sites allowed to call this server (CORS), e.g. the app on DeWEB: ['https://1-2-433.tapekit.org']. They sign
   * in with a bearer token (returned by /api/auth/verify) instead of the cookie: browsers block third-party cookies,
   * and a header is never sent by the browser on its own, so other pages cannot act for a signed-in person.
   */
  allowedOrigins?: string[];
  /** whsec_... from registering this server's /api/webhooks/sendrelay with Sendrelay; webhooks are refused without it. */
  sendrelayWebhookSecret?: string;
  log?: (line: string) => void;
}

const vaultReadAbi = parseAbi([
  'function locked() view returns (uint256)', 'function weeklyBudget() view returns (uint256)', 'function spentThisWeek() view returns (uint256)',
  'function limit() view returns (uint256)',
  'function pendingSupplierStatus(bytes32) view returns (uint8)', 'function supplierEffectiveAt(bytes32) view returns (uint256)',
  'function applySupplier(bytes32)',
]);
const STATUS_NAME = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k])) as Record<number, string>;
const MAX_BODY = 8 * 1024 * 1024;
const COOKIE = 'sr_session';
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
const RPC_ALLOWED = /^(eth_|net_version$|web3_clientVersion$)/;

type Ctx = { user: User | null; token: string | undefined; body: any; ip: string; m: RegExpMatchArray; url: URL };
type Handler = (c: Ctx, res: ServerResponse) => Promise<unknown>;

export function createApp(o: AppOptions): Server {
  const { platform: p, accounts, shops } = o;
  const log = o.log ?? (() => {});
  const lastCheck = new Map<string, CheckResult>();         // `${shopId}:${orderId}`
  const codeRequests = new Map<string, number[]>();         // per-IP limit on SMS sends
  const naira = (x: bigint) => p.money.toNaira(x);

  const need = (c: Ctx, role?: Role): User => {
    if (!c.user) throw new AuthError(401, 'Sign in first.');
    if (role && c.user.role !== role) throw new AuthError(403, `This needs a ${role} account.`);
    return c.user;
  };
  const ownerShop = (c: Ctx): ShopRuntime => {
    const u = need(c, 'owner');
    const shop = shops.forOwner(u.id);
    if (!shop) throw new AuthError(409, 'Set up your shop first.');
    return shops.runtime(shop);
  };
  /** A job the signed-in rider is booked on. */
  const riderJob = (c: Ctx): { rt: ShopRuntime; job: Job } => {
    const u = need(c, 'rider');
    const shop = shops.all().find((s) => s.id === Number(c.m[1]));
    const rt = shop && shops.runtime(shop);
    const job = rt?.jobs.get(c.m[2]);
    if (!rt || !job || !u.address || job.rider.toLowerCase() !== u.address.toLowerCase()) throw new AuthError(404, 'No such job for you.');
    return { rt, job };
  };

  async function orderView(rt: ShopRuntime, job: Job) {
    const r = await p.pub.readContract({ address: rt.shop.vault, abi: checkAbi, functionName: 'orders', args: [BigInt(job.orderId)] });
    return {
      ...job, shopId: rt.shop.id, vault: rt.shop.vault,
      status: STATUS_NAME[r[8]] ?? 'Unknown', ordered: r[3], unitPriceNaira: naira(r[6]), riderFeeNaira: naira(r[7]),
      pickup: { atSupplier: r[10], riderCounted: r[11], riderCount: r[12], aiCounted: r[13], aiCount: r[14], damage: r[15], picked: r[16] },
      delivery: { atShop: r[17], arrivedAt: Number(r[18]), aiCounted: r[19], delivered: r[20], damage: r[21], ownerOk: r[22], ownerIssue: r[23] },
      lastCheck: lastCheck.get(`${rt.shop.id}:${job.orderId}`) ?? null,
    };
  }
  /**
   * Finish supplier approvals the owner queued once their 24 h wait is over. applySupplier only carries out what the
   * owner's key already decided (status and payout address), and anyone may call it, so the deployer pays this gas
   * instead of asking the owner to sign a second time. Best effort: a failure leaves the approval pending.
   */
  async function applyDueSuppliers(rt: ShopRuntime) {
    const now = (await p.pub.getBlock()).timestamp;
    for (const s of loadSuppliers()) {
      const key = supplierKey(s.id);
      const at = await p.pub.readContract({ address: rt.shop.vault, abi: vaultReadAbi, functionName: 'supplierEffectiveAt', args: [key] });
      if (at === 0n || at > now) continue;
      try {
        const hash = await p.deployer.writeContract({ address: rt.shop.vault, abi: vaultReadAbi, functionName: 'applySupplier', args: [key] });
        await p.pub.waitForTransactionReceipt({ hash });
        log(`shop ${rt.shop.id}: supplier ${s.id} approval applied (${hash})`);
      } catch (e) { log(`shop ${rt.shop.id}: could not apply ${s.id}: ${(e as Error).message.split('\n')[0]}`); }
    }
  }
  const stageOf = (b: any) => (b?.stage === 'delivery' ? 'delivery' : b?.stage === 'pickup' ? 'pickup' : null);

  const routes: [string, RegExp, Handler][] = [
    // ---------------------------------------------------------------- sign-in
    ['POST', /^\/api\/auth\/code$/, async (c) => {
      const t = Date.now(), hits = (codeRequests.get(c.ip) ?? []).filter((x) => x > t - 3600_000);
      if (hits.length >= 20) throw new AuthError(429, 'Too many sign-in attempts from this network. Try again later.');
      codeRequests.set(c.ip, [...hits, t]);
      await accounts.requestCode(String(c.body?.phone ?? ''));
      return { sent: true };
    }],
    ['POST', /^\/api\/auth\/verify$/, async (c, res) => {
      const role = 'owner';   // shop owners only: no rider accounts (logistics companies or the owner collect goods)
      const { user, token } = accounts.verifyCode(String(c.body?.phone ?? ''), String(c.body?.code ?? ''), role);
      res.setHeader('Set-Cookie', cookie(token, 30 * 24 * 3600, o.secureCookies));
      log(`signed in: user ${user.id} (${user.role})`);
      return { user, token };   // for apps on another origin (DeWEB), which send it as `Authorization: Bearer`
    }],
    ['POST', /^\/api\/auth\/logout$/, async (c, res) => {
      if (c.token) accounts.signOut(c.token);
      res.setHeader('Set-Cookie', cookie('', 0, o.secureCookies));
      return { ok: true };
    }],

    // ---------------------------------------------------------------- the signed-in person
    ['GET', /^\/api\/config$/, async () => ({
      chainId: p.chain.id, network: p.name, token: p.token, tokenSymbol: p.tokenSymbol, explorerTx: p.explorerTx,
      photoCheck: shops.photoCheckOn, testMoney: !!p.faucet, devTime: !!p.advanceTime,
    })],
    ['GET', /^\/api\/me$/, async (c) => {
      if (!c.user) return { user: null };
      return {
        user: c.user,
        shop: c.user.role === 'owner' ? shops.forOwner(c.user.id) : null,
        rider: c.user.role === 'rider' ? shops.rider(c.user.id) : null,
        hasBackup: !!accounts.backup(c.user),
      };
    }],
    ['GET', /^\/api\/me\/link-message$/, async (c) => {
      const u = need(c);
      const address = c.url.searchParams.get('address') ?? '';
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new AuthError(400, 'address must be a 0x address');
      return { message: linkMessage(u.id, address as Address) };
    }],
    ['POST', /^\/api\/me\/key$/, async (c) => {
      const u = need(c);
      return { user: await accounts.linkAddress(u, c.body?.address as Address, c.body?.signature as Hex) };
    }],
    ['GET', /^\/api\/me\/backup$/, async (c) => ({ backup: accounts.backup(need(c)) })],
    ['POST', /^\/api\/me\/backup$/, async (c) => { accounts.saveBackup(need(c), c.body ?? {}); return { ok: true }; }],
    ['POST', /^\/api\/me\/gas$/, async (c) => shops.ensureGas(need(c))],
    /** Token amount (base units, as a string) for a naira amount, at the server's rate. The phone signs that amount. */
    ['GET', /^\/api\/money\/to-token$/, async (c) => {
      need(c);
      const n = Number(c.url.searchParams.get('naira'));
      if (!Number.isInteger(n) || n < 1 || n > 100_000_000) throw new AuthError(400, 'naira must be a whole number from 1 to 100,000,000');
      return { naira: n, amount: p.money.toToken(n).toString(), symbol: p.tokenSymbol };
    }],
    ['POST', /^\/api\/me\/test-money$/, async (c) => {
      const u = need(c);
      if (!p.faucet) throw new AuthError(404, 'Test money only exists on the test network.');
      if (!u.address) throw new AuthError(409, 'Set up the key on your phone first.');
      await p.faucet(u.address);
      return { ok: true };
    }],

    // ---------------------------------------------------------------- owner
    ['POST', /^\/api\/shop$/, async (c) => {
      const shop = await shops.create(need(c, 'owner'), c.body ?? {});
      log(`shop ${shop.id} "${shop.name}" created, vault ${shop.vault}`);
      return { shop };
    }],
    ['GET', /^\/api\/shop\/money$/, async (c) => {
      const rt = ownerShop(c), v = rt.shop.vault, read = (functionName: 'locked' | 'weeklyBudget' | 'spentThisWeek' | 'limit') =>
        p.pub.readContract({ address: v, abi: vaultReadAbi, functionName });
      const [vaultBal, walletBal, locked, budget, spent, limit] = await Promise.all([
        p.pub.readContract({ address: p.token, abi: tokenAbi, functionName: 'balanceOf', args: [v] }),
        p.pub.readContract({ address: p.token, abi: tokenAbi, functionName: 'balanceOf', args: [need(c).address!] }),
        read('locked'), read('weeklyBudget'), read('spentThisWeek'), read('limit'),
      ]);
      const unitNaira = (x: bigint) => naira(x);
      return {
        vault: v, token: p.token, network: p.name,
        vaultNaira: naira(vaultBal), lockedNaira: naira(locked),
        availableNaira: Math.max(0, naira(vaultBal) - naira(locked)),
        walletNaira: naira(walletBal), weeklyBudgetNaira: unitNaira(budget), spentThisWeekNaira: unitNaira(spent), limitNaira: unitNaira(limit),
      };
    }],
    ['POST', /^\/api\/orders$/, async (c) => {
      const rt = ownerShop(c);
      const text = typeof c.body?.text === 'string' ? c.body.text.trim() : '';
      if (!text || text.length > 2000) throw new AuthError(400, 'Send the order as text (up to 2,000 characters).');
      await applyDueSuppliers(rt).catch(() => {});
      const report = await handleOrder(text, rt.agent, { delivery: c.body?.delivery === 'self' ? 'self' : 'logistics' });
      await shops.dispatcher.bookPending(rt.dispatch).catch((e) => log(`booking: ${(e as Error).message}`));
      return { message: report.message, problems: report.problems };
    }],
    ['GET', /^\/api\/orders$/, async (c) => {
      const rt = ownerShop(c);
      await shops.dispatcher.bookPending(rt.dispatch).catch(() => {});   // e.g. an ask-owner order the owner just approved
      return Promise.all(rt.jobs.all().sort((a, b) => b.createdAt - a.createdAt).map((j) => orderView(rt, j)));
    }],
    ['POST', /^\/api\/orders\/(\d+)\/settle$/, async (c) => {
      const rt = ownerShop(c), stage = stageOf(c.body);
      if (!stage) throw new AuthError(400, 'stage must be pickup or delivery.');
      if (!rt.jobs.get(c.m[1])) throw new AuthError(404, 'No such order in your shop.');
      try { const r = await rt.settler.settle(BigInt(c.m[1]), stage); lastCheck.set(`${rt.shop.id}:${c.m[1]}`, r as CheckResult); return r; }
      catch { throw new AuthError(409, 'Not ready to settle yet.'); }
    }],
    /** The owner's count at the door for a logistics delivery (the check service attests it; it decides the fee). */
    ['POST', /^\/api\/orders\/(\d+)\/received$/, async (c) => {
      const rt = ownerShop(c);
      if (!rt.jobs.get(c.m[1])) throw new AuthError(404, 'No such order in your shop.');
      try { return await shops.dispatcher.ownerCount(rt.dispatch, c.m[1], Number(c.body?.count)); }
      catch (e) { throw new AuthError(409, (e as Error).message); }
    }],
    ['GET', /^\/api\/map$/, async (c) => {
      const rt = ownerShop(c), shop = rt.agent.shop;
      await applyDueSuppliers(rt).catch(() => {});
      const read = (functionName: 'pendingSupplierStatus' | 'supplierEffectiveAt', key: Hex) =>
        p.pub.readContract({ address: rt.shop.vault, abi: vaultReadAbi, functionName, args: [key] });
      const suppliers = await Promise.all(loadSuppliers().map(async (s) => ({
        id: s.id, key: supplierKey(s.id), name: s.name, market: s.market, lat: s.lat, lng: s.lng, simulated: s.simulated,
        status: Number(await rt.vault.supplierStatus(supplierKey(s.id))),
        // A queued approval: the status it will take and when (unix seconds, chain time); null when nothing is queued.
        pending: await (async () => {
          const at = await read('supplierEffectiveAt', supplierKey(s.id));
          return at === 0n ? null : { status: Number(await read('pendingSupplierStatus', supplierKey(s.id))), effectiveAt: Number(at) };
        })(),
        km: Math.round(haversineKm(shop, s) * 10) / 10,
        prices: s.stocks.map((st) => {
          const latest = rt.agent.prices?.latest(s.id, st.item);
          return latest ? { item: st.item, priceNaira: latest.unitPriceNaira, source: latest.source, age: ageText(latest.at) }
            : { item: st.item, priceNaira: st.listPriceNaira, source: 'catalogue', age: null };
        }),
      })));
      return { shop, supplierPayout: p.supplierPayout, suppliers: suppliers.filter((s) => s.status !== 3) };
    }],

    // ---------------------------------------------------------------- rider
    ['POST', /^\/api\/rider\/profile$/, async (c) => ({ rider: await shops.setRider(need(c, 'rider'), c.body ?? {}) })],
    ['GET', /^\/api\/rider\/jobs$/, async (c) => {
      const u = need(c, 'rider');
      if (!u.address) return [];
      const views = [];
      for (const shop of shops.all()) {
        const rt = shops.runtime(shop);
        for (const j of rt.jobs.forRider(u.address)) views.push(await orderView(rt, j));
      }
      return views.sort((a, b) => b.createdAt - a.createdAt);
    }],
    ['POST', /^\/api\/jobs\/(\d+)\/(\d+)\/photo$/, async (c) => {
      const { rt, job } = riderJob(c), stage = stageOf(c.body);
      if (!rt.check) throw new AuthError(503, 'Photo check is off on this server.');
      if (!stage) throw new AuthError(400, 'stage must be pickup or delivery');
      if (typeof c.body?.data !== 'string') throw new AuthError(400, 'data must be the photo as base64');
      const photo = { data: Buffer.from(c.body.data, 'base64'), mediaType: c.body.mediaType as MediaType };
      const r = await (stage === 'pickup' ? rt.check.pickup(BigInt(job.orderId), photo) : rt.check.delivery(BigInt(job.orderId), photo));
      lastCheck.set(`${rt.shop.id}:${job.orderId}`, r);
      log(`photo ${stage} shop ${rt.shop.id} #${job.orderId}: ${r.status}`);
      return r;
    }],
    ['POST', /^\/api\/jobs\/(\d+)\/(\d+)\/confirm-count$/, async (c) => {
      const { rt, job } = riderJob(c), stage = stageOf(c.body);
      if (!rt.check || !stage) throw new AuthError(400, 'stage must be pickup or delivery');
      const r = await rt.check.confirmShort(BigInt(job.orderId), stage);
      lastCheck.set(`${rt.shop.id}:${job.orderId}`, r);
      return r;
    }],
    ['POST', /^\/api\/jobs\/(\d+)\/(\d+)\/settle$/, async (c) => {
      const { rt, job } = riderJob(c), stage = stageOf(c.body);
      if (!rt.check || !stage) throw new AuthError(400, 'stage must be pickup or delivery');
      try { const r = await rt.check.settle(BigInt(job.orderId), stage); lastCheck.set(`${rt.shop.id}:${job.orderId}`, r as CheckResult); return r; }
      catch { throw new AuthError(409, 'Not ready to settle yet: both the photo check and your step are needed.'); }
    }],

    // ---------------------------------------------------------------- test network only
    ['POST', /^\/api\/dev\/advance-day$/, async (c) => {
      need(c);
      if (!p.advanceTime) throw new AuthError(404, 'Not available on this network.');
      await p.advanceTime(86_400);
      return { ok: true };
    }],
  ];

  // Sendrelay status webhooks: signature checked on the raw body; each event once; the task is then re-read from
  // Sendrelay (the authoritative state) and applied. Answered at once, processed after (Sendrelay waits 10 s at most).
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
    const entry = shops.dispatcher.entries.find((e) => e.id === 'sendrelay');
    const shopsNow = shops.dispatchShops(), found = shops.dispatcher.find(shopsNow, ev.data.taskId);
    if (!entry?.connector || !found) return;
    try { await shops.dispatcher.apply(found.shop, found.orderId, await entry.connector.get(ev.data.taskId)); }
    catch (e) { log(`sendrelay ${ev.type} for order ${found.orderId}: ${(e as Error).message}`); }
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
