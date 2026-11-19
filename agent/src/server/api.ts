// HTTP API for the owner and rider app. It never holds the owner's or rider's key: their own steps (approveOrder,
// ownerConfirm, riderPickup, riderArrive) are signed in their browser and sent through /rpc. This server only runs the
// agent (agent key: propose) and the photo check (check key: attest), and lets anyone ask the vault to settle.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { Address, PublicClient } from 'viem';
import { handleOrder, type AgentDeps } from '../agent.ts';
import { checkAbi, STATUS, type CheckResult, type CheckService } from '../check/checkService.ts';
import type { JobStore, Job } from '../check/jobs.ts';
import type { MediaType } from '../check/photoCount.ts';

export interface ApiDeps {
  pub: PublicClient;
  vault: Address;
  chainId: number;
  agent: AgentDeps;
  check: CheckService | null;          // null when no photo model is configured
  jobs: JobStore;
  tokenPerNaira: bigint;
  rpcUrl: string;                      // chain RPC that /rpc forwards to
  staticDir?: string;                  // built app (app/dist)
  /** Demo only: anvil's public test keys, so the local demo can sign as owner and rider in the browser. */
  demoKeys?: { owner: string; rider: string };
  log?: (line: string) => void;
}

const STATUS_NAME = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k])) as Record<number, string>;
const MAX_BODY = 8 * 1024 * 1024;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
/** Browser wallets may read the chain and send their own signed transactions; test-node controls (time travel etc.) are refused. */
const RPC_ALLOWED = /^(eth_|net_version$|web3_clientVersion$)/;

export function createApi(d: ApiDeps): Server {
  const lastCheck = new Map<string, CheckResult>();
  const log = d.log ?? (() => {});

  async function orderView(job: Job) {
    const o = await d.pub.readContract({ address: d.vault, abi: checkAbi, functionName: 'orders', args: [BigInt(job.orderId)] });
    const naira = (x: bigint) => Number(x / d.tokenPerNaira);
    return {
      ...job,
      status: STATUS_NAME[o[8]] ?? 'Unknown',
      ordered: o[3], unitPriceNaira: naira(o[6]), riderFeeNaira: naira(o[7]),
      pickup: { atSupplier: o[10], riderCounted: o[11], riderCount: o[12], aiCounted: o[13], aiCount: o[14], damage: o[15], picked: o[16] },
      delivery: { atShop: o[17], arrivedAt: Number(o[18]), aiCounted: o[19], delivered: o[20], damage: o[21], ownerOk: o[22], ownerIssue: o[23] },
      lastCheck: lastCheck.get(job.orderId) ?? null,
    };
  }

  const routes: [string, RegExp, (m: RegExpMatchArray, body: any) => Promise<unknown>][] = [
    ['GET', /^\/api\/config$/, async () => ({ chainId: d.chainId, vault: d.vault, photoCheck: !!d.check, demoKeys: d.demoKeys ?? null })],
    ['GET', /^\/api\/orders$/, async () => Promise.all(d.jobs.all().sort((a, b) => b.createdAt - a.createdAt).map(orderView))],
    ['GET', /^\/api\/riders\/(0x[0-9a-fA-F]{40})\/jobs$/, async (m) => Promise.all(d.jobs.forRider(m[1] as Address).sort((a, b) => b.createdAt - a.createdAt).map(orderView))],
    ['POST', /^\/api\/orders$/, async (_m, body) => {
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 2000) throw new HttpError(400, 'Send the order as text (up to 2,000 characters).');
      const report = await handleOrder(text, d.agent);
      return { message: report.message, problems: report.problems };
    }],
    ['POST', /^\/api\/orders\/(\d+)\/photo$/, async (m, body) => {
      if (!d.check) throw new HttpError(503, 'Photo check is off: set GEMINI_API_KEY in .env and restart.');
      const stage = body?.stage === 'delivery' ? 'delivery' : body?.stage === 'pickup' ? 'pickup' : null;
      const mediaType = body?.mediaType as MediaType;
      if (!stage) throw new HttpError(400, 'stage must be pickup or delivery');
      if (typeof body?.data !== 'string') throw new HttpError(400, 'data must be the photo as base64');
      const r = await (stage === 'pickup' ? d.check.pickup : d.check.delivery).call(d.check, BigInt(m[1]), { data: Buffer.from(body.data, 'base64'), mediaType });
      lastCheck.set(m[1], r);
      log(`photo ${stage} #${m[1]}: ${r.status}${'message' in r ? ` (${r.message})` : ''}`);
      return r;
    }],
    ['POST', /^\/api\/orders\/(\d+)\/confirm-count$/, async (m, body) => {
      if (!d.check) throw new HttpError(503, 'Photo check is off: set GEMINI_API_KEY in .env and restart.');
      const stage = body?.stage === 'delivery' ? 'delivery' : 'pickup';
      const r = await d.check.confirmShort(BigInt(m[1]), stage);
      lastCheck.set(m[1], r);
      log(`confirmed short ${stage} #${m[1]}: ${r.status}`);
      return r;
    }],
    ['POST', /^\/api\/orders\/(\d+)\/settle$/, async (m, body) => {
      if (!d.check) throw new HttpError(503, 'Settlement runs through the check service, which is off.');
      const stage = body?.stage === 'delivery' ? 'delivery' : 'pickup';
      try {
        const r = await d.check.settle(BigInt(m[1]), stage);
        const prev = lastCheck.get(m[1]);
        const merged = { ...r, aiCount: prev && 'aiCount' in prev ? prev.aiCount : 0, damage: prev && 'damage' in prev ? prev.damage : false, attestTx: prev && 'attestTx' in prev ? prev.attestTx : r.settleTx } as CheckResult;
        lastCheck.set(m[1], merged);
        return merged;
      } catch { throw new HttpError(409, 'Not ready to settle yet: both the photo check and the rider\'s step are needed.'); }
    }],
  ];

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/rpc' && req.method === 'POST') return await proxyRpc(req, res, d.rpcUrl);
      const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
      if (route) {
        const body = req.method === 'POST' ? await readJson(req) : undefined;
        return send(res, 200, await route[2](url.pathname.match(route[1])!, body));
      }
      if (req.method === 'GET' && d.staticDir) return serveStatic(res, d.staticDir, url.pathname);
      send(res, 404, { error: 'not found' });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`error: ${(e as Error).stack ?? e}`);
      send(res, status, { error: status === 500 ? 'Something went wrong. Nothing was paid; try again.' : (e as Error).message });
    }
  });
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new HttpError(413, 'Photo too large: under 5 MB please.'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}
async function readJson(req: IncomingMessage) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Body must be JSON.'); }
}

async function proxyRpc(req: IncomingMessage, res: ServerResponse, rpcUrl: string) {
  const raw = await readBody(req);
  let calls: { method?: string }[];
  try { const j = JSON.parse(raw.toString('utf8')); calls = Array.isArray(j) ? j : [j]; } catch { return send(res, 400, { error: 'bad JSON-RPC' }); }
  if (!calls.every((c) => typeof c.method === 'string' && RPC_ALLOWED.test(c.method))) return send(res, 403, { error: 'RPC method not allowed' });
  const r = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw.toString('utf8') });
  res.writeHead(r.status, { 'Content-Type': 'application/json' });
  res.end(Buffer.from(await r.arrayBuffer()));
}

function serveStatic(res: ServerResponse, dir: string, path: string) {
  const safe = normalize(path).replace(/^([/\\])+/, '');
  if (safe.split(/[/\\]/).includes('..')) return send(res, 400, { error: 'bad path' });
  let file = join(dir, safe);
  if (!safe || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html'); // single-page app
  if (!existsSync(file)) return send(res, 404, { error: 'App not built: run `npm run build` in app/.' });
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}
