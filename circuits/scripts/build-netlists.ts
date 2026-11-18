// Writes the generated netlists to circuits/build/<NAME>.json for the tapeout scripts.
//   node scripts/build-netlists.ts
// test/blocks.test.ts fails if these files drift from the generator.

import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BLOCKS } from '../netlists/blocks.ts';
import { CIRCUITS } from '../netlists/circuits.ts';

const dir = new URL('../build/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [name, gen] of Object.entries({ ...BLOCKS, ...CIRCUITS })) {
  const c = gen();
  const hex = '0x' + Buffer.from(c.netlist).toString('hex');
  const art = { name, nIn: c.nIn, nOut: c.nOut, gates: c.gates, bytes: c.netlist.length, sha256: createHash('sha256').update(c.netlist).digest('hex'), netlist: hex };
  writeFileSync(new URL(`${name}.json`, dir), JSON.stringify(art, null, 2) + '\n');
  console.log(`${name}: ${c.nIn} in, ${c.nOut} out, ${c.gates} NAND, ${c.netlist.length} bytes`);
}
