// Lists latch-free circuits with at least <minIn> inputs and <minOut> outputs across TapeOut processors (read-only).
//   node scripts/find-circuits.ts [minIn=9] [minOut=1] [maxCpus=430] [rpc]

const [minInArg, minOutArg, maxCpusArg, rpcArg] = process.argv.slice(2);
const RPC = rpcArg ?? process.env.XLAYER_RPC ?? 'https://rpc.xlayer.tech';
const FACTORY = '0x1f09DAeFA827f02CBb40967cc91b259763760761';
const minIn = Number(minInArg ?? 9), minOut = Number(minOutArg ?? 1), maxCpus = Number(maxCpusArg ?? 430);
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');

async function batch(calls: { to: string; data: string }[]): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  const SIZE = 10;
  for (let i = 0; i < calls.length; i += SIZE) {
    const chunk = calls.slice(i, i + SIZE);
    let j: { id: number; result?: string }[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(RPC, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chunk.map((c, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call', params: [c, 'latest'] }))),
      });
      const body = await res.json();
      if (Array.isArray(body)) { j = body; break; }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); // rate limited: back off
    }
    const byId = new Map(j.map((r) => [r.id, r.result ?? null]));
    chunk.forEach((_, k) => out.push(byId.get(k) ?? null));
  }
  return out;
}

const n = (h: string | null, k: number) => (h && h.length >= 2 + 64 * (k + 1) ? Number(BigInt('0x' + h.slice(2 + 64 * k, 66 + 64 * k))) : 0);

const count = n((await batch([{ to: FACTORY, data: '0xa94da8a7' }]))[0], 0);
const cpus = (await batch(Array.from({ length: Math.min(count, maxCpus) }, (_, i) => ({ to: FACTORY, data: '0x4bc7cbbd' + word(i) }))))
  .map((r) => (r ? '0x' + r.slice(-40) : null)).filter((x): x is string => !!x);
const next = await batch(cpus.map((to) => ({ to, data: '0x61b8ce8c' })));
console.log(`${count} processors; scanning ${cpus.length}`);
for (let i = 0; i < cpus.length; i++) {
  const ids = Array.from({ length: Math.max(0, n(next[i], 0) - 1) }, (_, k) => k + 1);
  if (!ids.length) continue;
  const infos = await batch(ids.map((id) => ({ to: cpus[i], data: '0x084d60f1' + word(id) })));
  infos.forEach((r, k) => {
    const [nIn, nOut, nState, gates] = [0, 1, 2, 3].map((j) => n(r, j));
    if (nIn >= minIn && nOut >= minOut && nState === 0 && gates > 0) console.log(`${cpus[i]} #${ids[k]} nIn=${nIn} nOut=${nOut} gates=${gates}`);
  });
}
