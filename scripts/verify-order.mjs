#!/usr/bin/env node
// Re-check a StockRun order's payment decisions against the TapeOut circuits on X Layer.
//
//   node scripts/verify-order.mjs <orderId>
//
// It fetches the order's saved circuit evidence (circuit, block, packed input and output) from the live app, calls
// the circuit's read-only eval(circuitId, input) on X Layer itself, and compares the result with what StockRun saved.
// No install, no wallet, no gas: Node 18+ only.
//
// Options:  --server <url>   app to read the evidence from (default https://stockrun-ai.duckdns.org)
//           --rpc <url>      X Layer RPC (default https://rpc.xlayer.tech)
//           --file <path>    read the evidence from a saved JSON file instead of the app

import { readFileSync } from 'node:fs';

const DEPLOYMENT = {
  chainId: 196,
  processor: '0x34efCc0a3191A48Feec787252E6d817b063A4017',
  circuitIds: { restock: 1, pickup: 2, delivery: 3 },
};
const NAMES = { restock: 'RestockGuard', pickup: 'PickupCheck', delivery: 'DeliveryCheck' };
const EVAL = '0x934d06ea'; // eval(uint256,bytes)

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const server = opt('--server', 'https://stockrun-ai.duckdns.org').replace(/\/$/, '');
const rpc = opt('--rpc', 'https://rpc.xlayer.tech');
const file = opt('--file');
const orderId = args[0];
if (!file && !/^\d+$/.test(orderId ?? '')) {
  console.error('Usage: node scripts/verify-order.mjs <orderId> [--server url] [--rpc url] [--file evidence.json]');
  process.exit(2);
}

const hex = (s) => s.replace(/^0x/, '').toLowerCase();
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
function encodeEval(circuitId, input) {
  const b = hex(input), len = b.length / 2, padded = b.padEnd(Math.ceil(len / 32) * 64, '0');
  return EVAL + word(circuitId) + word(64) + word(len) + padded;
}
function decodeBytes(ret) {
  const d = hex(ret), off = Number(BigInt('0x' + d.slice(0, 64))) * 2, len = Number(BigInt('0x' + d.slice(off, off + 64)));
  return '0x' + d.slice(off + 64, off + 64 + len * 2);
}
async function call(method, params) {
  const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
  return j.result;
}

const saved = file
  ? JSON.parse(readFileSync(file, 'utf8'))
  : await fetch(`${server}/api/orders/${orderId}/evidence`).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `${server} answered ${r.status}`);
      return j;
    });

const chainId = Number(await call('eth_chainId', []));
if (chainId !== DEPLOYMENT.chainId) throw new Error(`RPC is on chain ${chainId}, not X Layer (${DEPLOYMENT.chainId}).`);
if (saved.processor && saved.processor.toLowerCase() !== DEPLOYMENT.processor.toLowerCase())
  console.log(`! The app reports processor ${saved.processor}; checking against the taped-out ${DEPLOYMENT.processor}.`);

console.log(`Order #${saved.orderId ?? orderId}: ${saved.evidence.length} circuit decision(s)`);
console.log(`Processor ${DEPLOYMENT.processor} on X Layer (chain ${chainId})\n`);
if (!saved.evidence.length) { console.log('This order has no circuit decisions yet.'); process.exit(0); }

let bad = 0;
for (const [i, e] of saved.evidence.entries()) {
  const expectedId = DEPLOYMENT.circuitIds[e.circuit];
  const label = `${i + 1}. ${NAMES[e.circuit] ?? e.circuit} #${e.circuitId} at block ${Number(e.block).toLocaleString('en')}`;
  if (String(expectedId) !== String(e.circuitId)) { console.log(`✗ ${label}: saved circuit ID should be ${expectedId}`); bad++; continue; }
  const tx = { to: DEPLOYMENT.processor, data: encodeEval(e.circuitId, e.input) };
  let out, where = 'at the saved block';
  try {
    const raw = await call('eth_call', [tx, '0x' + BigInt(e.block).toString(16)]);
    if (hex(raw) === '') throw new Error('empty');   // no code at that block
    out = decodeBytes(raw);
  } catch {
    // Public RPCs often don't keep old state. The netlist is frozen, so the latest block gives the same answer.
    out = decodeBytes(await call('eth_call', [tx, 'latest'])); where = 'at the latest block (the RPC has no state for the saved block; the circuit is frozen)';
  }
  const ok = hex(out) === hex(e.output);
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  console.log(`    input   ${e.input}`);
  console.log(`    saved   ${e.output}`);
  console.log(`    X Layer ${out}  (${where})`);
}
console.log(bad ? `\n${bad} decision(s) did NOT match.` : '\nEvery saved decision matches what the circuit returns on X Layer.');
process.exit(bad ? 1 : 0);
