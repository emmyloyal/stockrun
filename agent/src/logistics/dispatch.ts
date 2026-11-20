// Dispatch: connects logistics bookings to orders. StockRun holds one on-chain key per logistics company (its
// "dispatch desk"); orders trust that key only for verified companies. The desk can do two things, and only when the
// company itself reports them:
//   - "picked up" (Sendrelay IN_PROGRESS): confirm the ordered quantity -> PickupCheck pays the seller.
//     The company's rider checked the goods against the order details we sent; that is the pickup confirmation.
//   - "delivered" (Sendrelay COMPLETED, i.e. the rider entered the buyer's delivery code): mark arrival.
// The buyer's count at the door decides the fee: paid, or held back if short. Nothing here moves money directly:
// every payment is a circuit's decision, in the buyer's vault (coins) or the naira ledger (orders/backends.ts).
import type { Address } from 'viem';
import { STATUS } from '../check/checkService.ts';
import type { Job, JobDelivery, JobStore } from '../check/jobs.ts';
import type { Wallet } from '../chain/platform.ts';
import type { OrderBackend } from '../orders/backends.ts';
import { compareQuotes, type BookingUpdate, type Carrier, type CarrierQuote, type DeliveryJob, type DeliveryState } from './carrier.ts';

export interface CarrierEntry {
  id: string;
  name: string;
  /** The company's dispatch-desk key (held by StockRun). Orders trust it only for verified companies. */
  wallet: Wallet;
  /** The company's booking API, or null for the simulated company in the local demo. */
  connector: Carrier | null;
}

/** One set of orders the dispatcher moves along: where their money is, and their off-chain details. */
export interface DispatchShop { backend: OrderBackend; jobs: JobStore }

const TERMINAL: DeliveryState[] = ['delivered', 'failed', 'cancelled'];

export class Dispatcher {
  private log: (l: string) => void;
  readonly entries: CarrierEntry[];
  constructor(o: { entries: CarrierEntry[]; log?: (l: string) => void }) {
    this.entries = o.entries; this.log = o.log ?? (() => {});
  }

  /** Booking-capable companies the order's money trusts, quoted for this job, cheapest first. */
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

  /** Book every job whose money is locked but has no booking yet (new orders, and ask orders once approved). */
  async bookPending(s: DispatchShop): Promise<void> {
    for (const j of s.jobs.all()) {
      if (!j.logistics || j.logistics.bookingId || j.logistics.error?.startsWith('Booking refused')) continue;
      const o = await s.backend.order(j.orderId).catch(() => null);
      if (!o || o.status !== STATUS.Locked) continue;
      await this.book(s, j, o.feeNaira).catch((e) => {
        s.jobs.updateDelivery(j.orderId, { error: `Booking failed: ${(e as Error).message}` });
        this.log(`order ${j.orderId}: booking failed: ${(e as Error).message}`);
      });
    }
  }

  /** Book at no more than the fee locked for delivery. An expired quote is refreshed; a dearer one is refused. */
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

  /** Apply a company's status to the order. Safe to call repeatedly with the same update. */
  async apply(s: DispatchShop, orderId: string, u: BookingUpdate): Promise<void> {
    const j = s.jobs.get(orderId), d = j?.logistics, e = d && this.entry(d);
    if (!j || !d || !e || d.bookingId !== u.bookingId) return;
    s.jobs.updateDelivery(orderId, { state: u.state, riderName: u.rider?.name ?? d.riderName ?? null,
      error: u.state === 'failed' ? `${d.carrierName} could not deliver (${u.failureReason ?? 'no reason given'}). The money stays locked; it is refunded 48 h after the order.` : u.state === 'cancelled' ? `${d.carrierName} cancelled the delivery. The money is refunded 48 h after the order.` : d.error });

    const pickedUp = u.state === 'picked_up' || u.state === 'at_dropoff' || u.state === 'delivered';
    if (pickedUp && !d.pickupSigned) {
      const o = await s.backend.order(orderId);
      if (o.status === STATUS.Locked) {
        await s.backend.handlerPickup(e.wallet, orderId, o.ordered);
        const r = await s.backend.settlePickup(orderId);
        this.log(`order ${orderId}: ${d.carrierName} picked up; pickup ${r.outcome} ${r.qty} (${r.tx})`);
      }
      s.jobs.updateDelivery(orderId, { pickupSigned: true });
    }
    if (u.state === 'delivered' && !s.jobs.get(orderId)!.logistics!.arriveSigned) {
      await s.backend.handlerArrive(e.wallet, orderId);
      s.jobs.updateDelivery(orderId, { arriveSigned: true });
      this.log(`order ${orderId}: ${d.carrierName} delivered (buyer's code entered)`);
      await this.settleDelivery(s, orderId);
    }
  }

  /** The buyer's count at the door; then settle if the company has arrived. */
  async ownerCount(s: DispatchShop, orderId: string, count: number): Promise<{ attestTx: string }> {
    const j = s.jobs.get(orderId);
    if (!j?.logistics) throw new Error('This order is not with a logistics company.');
    const o = await s.backend.order(orderId);
    if (o.status !== STATUS.PickedUp) throw new Error('The goods are not on their way yet.');
    if (!Number.isInteger(count) || count < 0 || count > o.picked) throw new Error(`Count from 0 to ${o.picked} (what was picked up).`);
    const attestTx = await s.backend.deliveredCount(orderId, count);
    s.jobs.updateDelivery(orderId, { ownerCount: count });
    await this.settleDelivery(s, orderId);
    return { attestTx };
  }

  private async settleDelivery(s: DispatchShop, orderId: string) {
    const d = s.jobs.get(orderId)?.logistics;
    if (!d?.arriveSigned || d.ownerCount === undefined) return;
    const r = await s.backend.settleDelivery(orderId).catch((e) => { this.log(`order ${orderId}: delivery settle: ${(e as Error).message}`); return null; });
    if (r) this.log(`order ${orderId}: delivery ${r.outcome} (${r.tx})`);
  }

  /** Check every open booking with its company (for when status webhooks cannot reach this server). */
  async poll(sets: DispatchShop[]): Promise<void> {
    for (const s of sets) {
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

  /** Find the order a company's booking belongs to. */
  find(sets: DispatchShop[], bookingId: string): { shop: DispatchShop; orderId: string } | null {
    for (const shop of sets) for (const j of shop.jobs.all()) if (j.logistics?.bookingId === bookingId) return { shop, orderId: j.orderId };
    return null;
  }
}
