// Delivery companies ("carriers") that move goods from a supplier to a shop, instead of StockRun's own riders.
// Each carrier gets a connector behind this interface, so the agent can ask every connected carrier for a price and
// book the best one. Amounts are whole naira; each connector converts to its own units.

export interface Place { name: string; lat: number; lng: number; address: string; contactName: string; contactPhone: string }

export interface DeliveryJob {
  /** Our reference, unique per delivery (e.g. `shop12-order7`). Also used to make booking safe to retry. */
  ref: string;
  pickup: Place;
  dropoff: Place;
  item: { name: string; quantity: number; unit: string; valueNaira: number };
  /** Rough load, so the carrier sends a vehicle that can carry it. */
  load: 'light' | 'standard' | 'heavy' | 'freight';
}

export interface CarrierQuote {
  carrier: string;
  quoteId: string | null;        // null when the carrier has no quote step
  priceNaira: number;            // everything the carrier will charge, including its fees and VAT
  expiresAt: number | null;      // ms since epoch
  vehicle: string | null;
  test: boolean;                 // true: a test-mode quote, no real rider, no money
}

/** Where a booked delivery is. `picked_up`: the goods are with the carrier's rider. */
export type DeliveryState = 'booked' | 'searching' | 'assigned' | 'picked_up' | 'at_dropoff' | 'delivered' | 'failed' | 'cancelled';

export interface Booking {
  carrier: string;
  bookingId: string;
  ref: string;
  state: DeliveryState;
  priceNaira: number;
  /** Code the shop owner gives the rider at the door; the rider cannot finish the delivery without it. */
  handoverCode: string | null;
  test: boolean;
}

export interface BookingUpdate {
  bookingId: string;
  state: DeliveryState;
  rider: { name: string | null; vehicle: string | null } | null;
  failureReason: string | null;
  /** Photo the rider took at the drop-off, when the carrier provides one. */
  dropoffPhotoUrl: string | null;
  at: number;
}

export interface Carrier {
  readonly id: string;           // stable, e.g. 'sendrelay'
  readonly name: string;         // shown to the owner
  quote(job: DeliveryJob): Promise<CarrierQuote>;
  /** Book against a quote. Calling again with the same job.ref returns the same booking (no double booking). */
  book(job: DeliveryJob, quote: CarrierQuote): Promise<Booking>;
  get(bookingId: string): Promise<BookingUpdate>;
  /** Cancel before pickup. Throws if the goods are already with the rider. */
  cancel(bookingId: string): Promise<void>;
  /** A link the owner can open to watch the rider, or null. */
  trackingLink(bookingId: string): Promise<string | null>;
}

export class CarrierError extends Error {
  readonly carrier: string; readonly code: string; readonly status: number;
  constructor(carrier: string, status: number, code: string, message: string) {
    super(`${carrier}: ${message} (${code})`); this.name = 'CarrierError'; this.carrier = carrier; this.status = status; this.code = code;
  }
}

/** Ask every carrier; return the quotes that came back, cheapest first, and why the others did not. */
export async function compareQuotes(carriers: Carrier[], job: DeliveryJob): Promise<{ quotes: CarrierQuote[]; failed: { carrier: string; error: string }[] }> {
  const results = await Promise.allSettled(carriers.map((c) => c.quote(job)));
  const quotes: CarrierQuote[] = [], failed: { carrier: string; error: string }[] = [];
  results.forEach((r, i) => r.status === 'fulfilled' ? quotes.push(r.value) : failed.push({ carrier: carriers[i].id, error: (r.reason as Error).message }));
  return { quotes: quotes.sort((a, b) => a.priceNaira - b.priceNaira), failed };
}
