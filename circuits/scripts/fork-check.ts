// Checks a deployed TapeOut circuit against our TAP-02 simulator (read-only RPC calls; no keys, no gas).
// Confirms the eval() selector, the return encoding and the LSB-first bit packing on the target chain.
//
//   node scripts/fork-check.ts <processor> <circuitId> [samples=64] [rpc=https://rpc.xlayer.tech]

import { evalNetlist, type Circuit } from '../sim/netlist.ts';

const [processor, idArg, samplesArg, rpcArg] = process.argv.slice(2);
if (!processor || !idArg) { console.error('usage: fork-check.ts <processor> <circuitId> [samples] [rpc]'); process.exit(2); }
const RPC = rpcArg ?? process.env.XLAYER_RPC ?? 'https://rpc.xlayer.tech';
const id = BigInt(idArg);
const samples = Number(samplesArg ?? 64);

const SEL = { eval: '934d06ea', circuitInfo: '084d60f1', netlist: '3fc4be56' };
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => Uint8Array.from((h.replace(/^0x/, '').match(/../g) ?? []).map((x) => parseInt(x, 16)));
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');

let rpcId = 0;
async function call(data: string): Promise<string> {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'eth_call', params: [{ to: processor, data: '0x' + data }, 'latest'] }),
  });
  const j = await res.json() as { result?: string; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result!.replace(/^0x/, '');
}

function decodeBytes(ret: string): Uint8Array {
  const off = Number(BigInt('0x' + ret.slice(0, 64))) * 2;
  const len = Number(BigInt('0x' + ret.slice(off, off + 64)));
  return unhex(ret.slice(off + 64, off + 64 + len * 2));
}

function encodeEval(input: Uint8Array): string {
  const padded = hex(input).padEnd(Math.ceil(input.length / 32) * 64, '0');
  return SEL.eval + word(id) + word(0x40) + word(input.length) + padded;
}

async function main() {
  const info = await call(SEL.circuitInfo + word(id));
  const [nIn, nOut, nState, gates] = [0, 1, 2, 3].map((k) => Number(BigInt('0x' + info.slice(k * 64, k * 64 + 64))));
  console.log(`circuit ${processor}#${id}: nIn=${nIn} nOut=${nOut} nState=${nState} gateCount=${gates}`);
  if (nState > 0) throw new Error('circuit has LATCH state; eval() not applicable');
  const c: Circuit = { netlist: decodeBytes(await call(SEL.netlist + word(id))), nIn, nOut };
  console.log(`netlist: ${c.netlist.length} bytes`);

  const nBytes = Math.ceil(nIn / 8);
  const vectors: Uint8Array[] = [new Uint8Array(nBytes), new Uint8Array(nBytes).fill(255)];
  for (let i = 0; i < nIn; i++) { const v = new Uint8Array(nBytes); v[i >> 3] = 1 << (i & 7); vectors.push(v); } // one-hot: pins bit order
  if (nIn <= 12) { vectors.length = 0; for (let x = 0; x < 2 ** nIn; x++) vectors.push(Uint8Array.from({ length: nBytes }, (_, k) => (x >> (8 * k)) & 255)); }
  else for (let s = 0; s < samples; s++) vectors.push(Uint8Array.from({ length: nBytes }, () => Math.floor(Math.random() * 256)));
  for (const v of vectors) if (nIn % 8) v[nBytes - 1] &= (1 << (nIn % 8)) - 1;

  let bad = 0;
  for (const v of vectors) {
    const chain = decodeBytes(await call(encodeEval(v)));
    const sim = evalNetlist(c, v);
    if (hex(chain) !== hex(sim)) { bad++; if (bad <= 5) console.log(`MISMATCH in=${hex(v)} chain=${hex(chain)} sim=${hex(sim)}`); }
    if (chain.length !== Math.ceil(nOut / 8)) { console.log(`unexpected output length ${chain.length}`); bad++; }
  }
  console.log(`${vectors.length - bad}/${vectors.length} vectors match the TAP-02 simulator`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
