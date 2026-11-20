// Dispatch: connects logistics bookings to the vault. StockRun holds one on-chain key per logistics company (its
// "dispatch desk"); the vault trusts that key only if the shop owner approved the company. The desk key can do two
// things, and only when the company itself reports them:
//   - "picked up" (Sendrelay IN_PROGRESS): riderPickup with the ordered quantity -> PickupCheck pays the supplier.
//     The company's rider checked the goods against the order details we sent; that is the pickup confirmation.
//   - "delivered" (Sendrelay COMPLETED, i.e. the rider entered the owner's delivery code): riderArrive.
// The owner's count at the door is attested by the check service and decides the fee: paid, or held back if short.
// Nothing here moves money directly; every payment is still the circuit's decision in the vault.
import { parseAbi, type Address, type Hash, type PublicClient } from 'viem';
import { checkAbi, STATUS, type CheckService } from '../check/checkService.ts';
import type { Job, JobDelivery, JobStore } from '../check/jobs.ts';
import type { Money } from '../chain/money.ts';
import type { Wallet } from '../chain/platform.ts';
import { compareQuotes, type BookingUpdate, type Carrier, type CarrierQuote, type DeliveryJob, type DeliveryState } from './carrier.ts';

export interface CarrierEntry {
  id: string;
  name: string;
  /** The company's dispatch-desk key (held by StockRun). The vault trusts it only if the owner approved the company. */
  wallet: Wallet;
  /** The company's booking API, or null for the simulated company in the local demo. */
  connector: Carrier | null;
}

/** One shop's side of dispatch: its vault, its jobs and its settler. */
export interface DispatchShop { vault: Address; jobs: JobStore; settler: CheckService }

const TERMINAL: DeliveryState[] = ['delivered', 'failed', 'cancelled'];
const handlerAbi = parseAbi(['function riderPickup(uint256 id, bool atSupplier, uint8 riderCount)', 'function riderArrive(uint256 id, bool atShop)']);

export class Dispatcher {
  private pub: PublicClient; private money: Money; private log: (l: string) => void;
  readonly entries: CarrierEntry[];
  constructor(o: { pub: PublicClient; money: Money; entries: CarrierEntry[]; log?: (l: string) => void }) {
    this.pub = o.pub; this.money = o.money; this.entries = o.entries; this.log = o.log ?? (() => {});
  }

  /** Booking-capable companies the vault trusts, quoted for this job, cheapest first. */
  async quote(job: DeliveryJob, trusted: (a: Address) => Promise<boolean>): Promise<{ entry: CarrierEntry; quote: CarrierQuote } | null> {
    const usable: CarrierEntry[] = [];
    for (const e of this.entries) if (e.connector && await trusted(e.wallet.account.address)) usable.push(e);
    if (!usable.length) return null;
    const { quotes, failed } = await compareQuotes(usable.map((e) => e.connector!), job);
    for (const f of failed) this.log(`quote from ${f.carrier} failed: ${f.error}`);
    const best = quotes[0];
    return best ? { entry: usable.find((e) => e.connector!.id === best.carrier)!, quote: best } : null;
  }

  private entry(d: JobDelivery) { return this.entries.find((e) => e.id === d.carrier); }
  private async order(vault: Address, id: string) {
    return this.pub.readContract({ address: vault, abi: checkAbi, functionName: 'orders', args: [BigInt(id)] });
  }

  /** Book every job whose money is locked but has no booking yet (new orders, and ask-owner orders once approved). */
  async bookPending(s: DispatchShop): Promise<void> {
    for (const j of s.jobs.all()) {
      if (!j.logistics || j.logistics.bookingId || j.logistics.error?.startsWith('Booking refused')) continue;
      const o = await this.order(s.vault, j.orderId);
      if (Number(o[8]) !== STATUS.Locked) continue;
      await this.book(s, j, this.money.toNaira(o[7])).catch((e) => {
        s.jobs.updateDelivery(j.orderId, { error: `Booking failed: ${(e as Error).message}` });
        this.log(`order ${j.orderId}: booking failed: ${(e as Error).message}`);
      });
    }
  }

  /** Book at no more than the fee locked in the vault. An expired quote is refreshed; a dearer one is refused. */
  private async book(s: DispatchShop, j: Job, lockedFeeNaira: number) {
    const d = j.logistics!, e = this.entry(d);
    if (!e?.connector) return;
    let quote = d.quote;
    if (!quote.expiresAt || quote.expiresAt < Date.now() + 60_000) {
      quote = await e.connector.quote(d.job);
      if (quote.priceNaira > lockedFeeNaira) {
        s.jobs.updateDelivery(j.orderId, { quote, error: `Booking refused: ${d.carrierName} now asks ₦${quote.priceNaira.toLocaleString('en-NG')}, more than the ₦${lockedFeeNaira.toLocaleString('en-NG')} locked for delivery. Nothing was booked; the order is refunded 48 h after it was placed, and you can order again (or collect it yourself).` });
        return;
      }
    }
    quote = { ...quote, priceNaira: Math.min(quote.priceNaira, lockedFeeNaira) };
    const b = await e.connector.book(d.job, quote);
    const trackingUrl = await e.connector.trackingLink(b.bookingId).catch(() => null);
    s.jobs.updateDelivery(j.orderId, { quote, bookingId: b.bookingId, state: b.state, handoverCode: b.handoverCode, trackingUrl, error: undefined });
    this.log(`order ${j.orderId}: booked ${d.carrierName} ${b.bookingId}${b.test ? ' (test mode)' : ''}`);
  }

  /** Apply a company's status to the vault. Safe to call repeatedly with the same update. */
  async apply(s: DispatchShop, orderId: string, u: BookingUpdate): Promise<void> {
    const j = s.jobs.get(orderId), d = j?.logistics, e = d && this.entry(d);
    if (!j || !d || !e || d.bookingId !== u.bookingId) return;
    s.jobs.updateDelivery(orderId, { state: u.state, riderName: u.rider?.name ?? d.riderName ?? null,
      error: u.state === 'failed' ? `${d.carrierName} could not deliver (${u.failureReason ?? 'no reason given'}). The money stays locked; it is refunded 48 h after the order.` : u.state === 'cancelled' ? `${d.carrierName} cancelled the delivery. The money is refunded 48 h after the order.` : d.error });

    const pickedUp = u.state === 'picked_up' || u.state === 'at_dropoff' || u.state === 'delivered';
    if (pickedUp && !d.pickupSigned) {
      const o = await this.order(s.vault, orderId);
      if (Number(o[8]) === STATUS.Locked) {
        await this.sign(e, s.vault, 'riderPickup', [BigInt(orderId), true, Number(o[3])]);
        const r = await s.settler.settle(BigInt(orderId), 'pickup');
        this.log(`order ${orderId}: ${d.carrierName} picked up; pickup ${r.outcome} ${r.qty} (${r.settleTx})`);
      }
      s.jobs.updateDelivery(orderId, { pickupSigned: true });
    }
    if (u.state === 'delivered' && !s.jobs.get(orderId)!.logistics!.arriveSigned) {
      await this.sign(e, s.vault, 'riderArrive', [BigInt(orderId), true]);
      s.jobs.updateDelivery(orderId, { arriveSigned: true });
      this.log(`order ${orderId}: ${d.carrierName} delivered (owner's code entered)`);
      await this.settleDelivery(s, orderId);
    }
  }

  /** The owner's count at the door, attested by the check service; then settle if the company has arrived. */
  async ownerCount(s: DispatchShop, orderId: string, count: number): Promise<{ attestTx: Hash }> {
    const j = s.jobs.get(orderId);
    if (!j?.logistics) throw new Error('This order is not with a logistics company.');
    const o = await this.order(s.vault, orderId);
    if (Number(o[8]) !== STATUS.PickedUp) throw new Error('The goods are not on their way yet.');
    if (!Number.isInteger(count) || count < 0 || count > Number(o[16])) throw new Error(`Count from 0 to ${o[16]} (what was picked up).`);
    const attestTx = await s.settler.attestCount(BigInt(orderId), 'delivery', count);
    s.jobs.updateDelivery(orderId, { ownerCount: count });
    await this.settleDelivery(s, orderId);
    return { attestTx };
  }

  private async settleDelivery(s: DispatchShop, orderId: string) {
    const d = s.jobs.get(orderId)?.logistics;
    if (!d?.arriveSigned || d.ownerCount === undefined) return;
    const r = await s.settler.settle(BigInt(orderId), 'delivery').catch((e) => { this.log(`order ${orderId}: delivery settle: ${(e as Error).message}`); return null; });
    if (r) this.log(`order ${orderId}: delivery ${r.outcome} (${r.settleTx})`);
  }

  /** Check every open booking with its company (for when status webhooks cannot reach this server). */
  async poll(shops: DispatchShop[]): Promise<void> {
    for (const s of shops) {
      await this.bookPending(s);
      for (const j of s.jobs.all()) {
        const d = j.logistics, e = d && this.entry(d);
        if (!d?.bookingId || !e?.connector) continue;
        if (d.state && TERMINAL.includes(d.state) && (d.state !== 'delivered' || d.arriveSigned)) continue;   // nothing left to do
        try {
          const u = await e.connector.get(d.bookingId);
          if (u.state !== d.state || (u.state === 'delivered' && !d.arriveSigned) || (u.state === 'picked_up' && !d.pickupSigned)) await this.apply(s, j.orderId, u);
        } catch (err) { this.log(`order ${j.orderId}: status check failed: ${(err as Error).message}`); }
      }
    }
  }

  /** Find the shop and order a company's booking belongs to. */
  find(shops: DispatchShop[], bookingId: string): { shop: DispatchShop; orderId: string } | null {
    for (const shop of shops) for (const j of shop.jobs.all()) if (j.logistics?.bookingId === bookingId) return { shop, orderId: j.orderId };
    return null;
  }

  private async sign(e: CarrierEntry, vault: Address, functionName: 'riderPickup' | 'riderArrive', args: readonly unknown[]) {
    const { request } = await this.pub.simulateContract({ address: vault, abi: handlerAbi, functionName, args: args as never, account: e.wallet.account });
    const hash = await e.wallet.writeContract(request as never);
    const r = await this.pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${functionName} failed`);
    return hash;
  }
}
