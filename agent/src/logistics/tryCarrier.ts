// Try the Sendrelay connector with a TEST key: one real quote, one simulated booking, then its status until it ends.
//   npm run carrier:try
// Refuses live keys (sk_live_...): this script must never book a real rider or spend money.
import { existsSync } from 'node:fs';
import { envValue } from '../chain/platform.ts';
import { SendrelayCarrier } from './sendrelay.ts';
import type { DeliveryJob } from './carrier.ts';

const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const key = envValue(process.env, 'SENDRELAY_API_KEY');
if (!key) throw new Error('Add SENDRELAY_API_KEY=sk_test_... to the .env file in the project root.');
if (!key.startsWith('sk_test_')) throw new Error('carrier:try only runs with a TEST key (sk_test_...). It never books real riders.');

const sr = new SendrelayCarrier({ apiKey: key });
const job: DeliveryJob = {
  ref: `try-${Date.now()}`,
  pickup: { name: 'Adeyemi Provisions (demo)', lat: 6.6045, lng: 3.3891, address: 'Mile 12 Market, Kosofe, Lagos', contactName: 'Demo supplier', contactPhone: '+2348030000001' },
  dropoff: { name: 'Demo shop, Ojota', lat: 6.587, lng: 3.381, address: 'Ojota, Lagos', contactName: 'Demo owner', contactPhone: '+2348031111111' },
  item: { name: 'Indomie noodles carton (40 x 70g)', quantity: 5, unit: 'carton', valueNaira: 66_500 },
  load: 'standard',
};

const q = await sr.quote(job);
console.log(`quote ${q.quoteId}: ₦${q.priceNaira.toLocaleString('en-NG')} (${q.vehicle ?? 'vehicle not stated'}), test mode; Sendrelay prices test quotes on a stand-in 5 km route`);
const b = await sr.book(job, q);
console.log(`booked ${b.bookingId} (${b.state}), ₦${b.priceNaira.toLocaleString('en-NG')}, delivery code ${b.handoverCode ? 'issued' : 'not returned'}`);
const again = await sr.book(job, q);
console.log(`booking again with the same order ref returns ${again.bookingId === b.bookingId ? 'the same booking (no double booking)' : `A DIFFERENT BOOKING ${again.bookingId}`}`);
console.log(`tracking: ${await sr.trackingLink(b.bookingId).catch((e) => `not available (${e.message})`)}`);

let last = '';
const until = Date.now() + 10 * 60_000;
while (Date.now() < until) {
  const u = await sr.get(b.bookingId);
  const line = `${u.state}${u.rider ? ` · rider ${u.rider.name ?? '?'} (${u.rider.vehicle ?? '?'})` : ''}${u.failureReason ? ` · ${u.failureReason}` : ''}${u.dropoffPhotoUrl ? ' · drop-off photo' : ''}`;
  if (line !== last) { console.log(`${new Date().toISOString().slice(11, 19)}  ${line}`); last = line; }
  if (['delivered', 'failed', 'cancelled'].includes(u.state)) break;
  await new Promise((r) => setTimeout(r, 5000));
}
