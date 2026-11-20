// Publish the built app (app/dist) to DeWEB on X Layer, under our circuit #1: name 1.2.433.tape,
// served at https://1-2-433.tapekit.org. Contracts and signatures are the ones the tapekit.org gateway itself uses
// (TAP-10; checked against the deployed bytecode on 2026-11-20).
//
//   npm run deweb:publish -- --api https://stockrun.example     rehearsal on a LOCAL FORK of mainnet (default)
//   npm run deweb:publish -- --api https://stockrun.example --live
//
// Steps: open circuit #1's container (one-time fee, read live: 0.08 OKB on 2026-11-20) -> write each file in
// 24,000-byte chunks (putFile + appendChunk), skipping files already on chain with the same SHA-256 -> SPA fallback
// to index.html -> bind the name (monthly fee read live; 0 OKB on 2026-11-20).
// `stockrun-config.json` tells the app where its server is, so moving the server is a one-file update.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createTestClient, createWalletClient, formatEther, http, parseAbi, parseEther, parseGwei, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { envValue, xLayerChain, xlayerFees } from '../chain/platform.ts';
import { ANVIL } from '../sim/localChain.ts';

const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const LIVE = process.argv.includes('--live');
const API = arg('api');
const CIRCUIT = BigInt(arg('circuit') ?? '1');
const MONTHS = BigInt(arg('months') ?? '12');
if (API && !/^https:\/\/[^/]+$/.test(API)) throw new Error('--api must be an https origin with no path, e.g. https://stockrun.example');

const OPENER = '0x536adD8F30f03b69f6fbF29d425A816A0dC50106', REGISTRY = '0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6', BINDING = '0x68809Fd2fb343aA57D0aeB7f33Defe477c9666f9';
const FACTORY = '0x1f09DAeFA827f02CBb40967cc91b259763760761';
const deployment = JSON.parse(readFileSync(new URL('../../../deployments/xlayer.json', import.meta.url), 'utf8')) as { processor: `0x${string}` };
const CPU = deployment.processor;
const CHUNK = 24_000;
const OPEN_FEE_SELECTOR = '0xc57981b5';   // opener's fee getter (unnamed in the docs; 0.08 OKB on 2026-11-20, verified by simulation)

const abi = parseAbi([
  'function ownerOf(uint256) view returns (address)',
  'function accountOf(address,uint256) view returns (address)', 'function isOpened(address,uint256) view returns (bool)', 'function open(address,uint256) payable returns (address)',
  'function putFile(address,string,string,bytes32,bytes)', 'function appendChunk(address,string,uint256,bytes)', 'function setFallback(address,string)',
  'function fallbackPath(address) view returns (string)',
  'function monthlyFee() view returns (uint256)', 'function bind(string,address,uint256) payable', 'function isLive(string,address) view returns (bool)',
  'function cpuCount() view returns (uint256)', 'function cpuAt(uint256) view returns (address)',
]);
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// ---------------------------------------------------------------- the files
const dist = fileURLToPath(new URL('../../../app/dist/', import.meta.url));
if (!existsSync(join(dist, 'index.html'))) throw new Error('Build the app first: cd app && npm run build');
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]);
const files = walk(dist).map((f) => ({ path: relative(dist, f).split(sep).join('/'), data: readFileSync(f) }));
if (API) files.push({ path: 'stockrun-config.json', data: Buffer.from(JSON.stringify({ api: API }) + '\n') });
for (const f of files) if (!TYPES[f.path.slice(f.path.lastIndexOf('.'))]) throw new Error(`no content type for ${f.path}`);
if (files.some((f) => f.data.length > 350 * CHUNK)) throw new Error('a file is over the 8.4 MB DeWEB limit');

// ---------------------------------------------------------------- chain: a local fork (default) or X Layer itself
let url = envValue(process.env, 'XLAYER_RPC') ?? 'https://rpc.xlayer.tech', stopFork = () => {};
if (!LIVE) {
  const port = 20545 + Math.floor(Math.random() * 400);
  const fork = spawn(ANVIL, ['--fork-url', url, '--port', String(port), '--block-time', '1'], { stdio: 'ignore' });
  stopFork = () => fork.kill(); process.on('exit', stopFork);
  url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) { try { if ((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })).ok) break; } catch {} if (i > 200) throw new Error('fork did not start'); await new Promise((r) => setTimeout(r, 150)); }
}
const transport = http(url, { timeout: 120_000 });
const pub = createPublicClient({ chain: xLayerChain, transport });
const key = envValue(process.env, 'DEPLOYER_PRIVATE_KEY'); if (!key) throw new Error('DEPLOYER_PRIVATE_KEY is not set');
const me = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
const wallet = createWalletClient({ account: me, chain: xLayerChain, transport });
if ((await pub.getChainId()) !== 196) throw new Error('not X Layer');

let gas = 0n, feesPaid = 0n;
const send = async (label: string, req: Parameters<typeof wallet.writeContract>[0]) => {
  const hash = await wallet.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (r.status !== 'success') throw new Error(`${label} reverted (${hash})`);
  gas += r.gasUsed; feesPaid += (req as { value?: bigint }).value ?? 0n;
  return hash;
};

try {
  const okb0 = await pub.getBalance({ address: me.address });
  if (!LIVE) await createTestClient({ chain: xLayerChain, mode: 'anvil', transport }).setBalance({ address: me.address, value: okb0 + parseEther('1') }); // fork only

  // Who we are on DeWEB: circuit #CIRCUIT of our processor, at its index in the factory.
  if ((await pub.readContract({ address: CPU, abi, functionName: 'ownerOf', args: [CIRCUIT] })).toLowerCase() !== me.address.toLowerCase()) throw new Error(`the deployer does not hold circuit #${CIRCUIT}`);
  const count = await pub.readContract({ address: FACTORY, abi, functionName: 'cpuCount' });
  let index = -1n;
  for (let i = count - 1n; i >= 0n && index < 0n; i--) if ((await pub.readContract({ address: FACTORY, abi, functionName: 'cpuAt', args: [i] })).toLowerCase() === CPU.toLowerCase()) index = i;
  if (index < 0n) throw new Error('processor not found in the factory');
  const name = `${CIRCUIT}.2.${index}.tape`, host = `https://${CIRCUIT}-2-${index}.tapekit.org/`;
  const container = await pub.readContract({ address: OPENER, abi, functionName: 'accountOf', args: [CPU, CIRCUIT] });
  console.log(`${LIVE ? 'LIVE on X Layer' : 'REHEARSAL on a local fork of X Layer'}: ${name} (${host}), container ${container}`);

  // 1. Open the container (one-time).
  if (!(await pub.readContract({ address: OPENER, abi, functionName: 'isOpened', args: [CPU, CIRCUIT] }))) {
    const fee = BigInt((await pub.call({ to: OPENER, data: OPEN_FEE_SELECTOR })).data ?? '0x0');
    console.log(`opening the container: ${formatEther(fee)} OKB (one-time)`);
    await send('open', { address: OPENER, abi, functionName: 'open', args: [CPU, CIRCUIT], value: fee } as never);
  } else console.log('container already open');

  // 2. Files, chunked; unchanged files (same SHA-256 in the FileSet log) are skipped.
  const fileSet = parseAbi(['event FileSet(address indexed container, string path, uint32 chunks, bytes32 sha256, string contentType)'])[0];
  const onChain = new Map<string, Hex>();
  try {
    for (const l of await pub.getLogs({ address: REGISTRY, event: fileSet, args: { container }, fromBlock: (await pub.getBlockNumber()) - 500_000n })) onChain.set(String(l.args.path), l.args.sha256 as Hex);
  } catch { /* no history: write everything */ }
  let bytes = 0;
  for (const f of files) {
    const sha = toHex(createHash('sha256').update(f.data).digest());
    if (onChain.get(f.path) === sha) { console.log(`  ${f.path}: unchanged`); continue; }
    const chunks = Math.max(1, Math.ceil(f.data.length / CHUNK));
    const type = TYPES[f.path.slice(f.path.lastIndexOf('.'))];
    await send(`putFile ${f.path}`, { address: REGISTRY, abi, functionName: 'putFile', args: [container, f.path, type, sha, toHex(f.data.subarray(0, CHUNK))] } as never);
    for (let i = 1; i < chunks; i++) await send(`appendChunk ${f.path} ${i}`, { address: REGISTRY, abi, functionName: 'appendChunk', args: [container, f.path, BigInt(i), toHex(f.data.subarray(i * CHUNK, (i + 1) * CHUNK))] } as never);
    bytes += f.data.length;
    console.log(`  ${f.path}: ${f.data.length.toLocaleString()} bytes in ${chunks} chunk(s), ${type}`);
  }

  // 3. Single-page app: unknown paths serve index.html.
  if ((await pub.readContract({ address: REGISTRY, abi, functionName: 'fallbackPath', args: [container] })) !== 'index.html')
    await send('setFallback', { address: REGISTRY, abi, functionName: 'setFallback', args: [container, 'index.html'] } as never);

  // 4. Bind the name.
  if (!(await pub.readContract({ address: BINDING, abi, functionName: 'isLive', args: [name, container] }))) {
    const monthly = await pub.readContract({ address: BINDING, abi, functionName: 'monthlyFee' });
    console.log(`binding ${name} for ${MONTHS} months: ${formatEther(monthly * MONTHS)} OKB`);
    await send('bind', { address: BINDING, abi, functionName: 'bind', args: [name, container, MONTHS], value: monthly * MONTHS } as never);
  }
  const live = await pub.readContract({ address: BINDING, abi, functionName: 'isLive', args: [name, container] });

  const worst = xlayerFees(parseGwei('0.02')).maxFeePerGas;
  console.log(`\nwrote ${bytes.toLocaleString()} bytes; gas ${gas.toLocaleString()} = ${formatEther(gas * worst)} OKB at mainnet price; fees ${formatEther(feesPaid)} OKB`);
  console.log(`total ≈ ${formatEther(gas * worst + feesPaid)} OKB; deployer holds ${formatEther(okb0)} OKB on mainnet`);
  console.log(`name live: ${live}. ${LIVE ? `Open ${host}` : 'REHEARSAL ONLY: nothing was sent to X Layer. Re-run with --live to publish.'}`);
} finally { stopFork(); }
