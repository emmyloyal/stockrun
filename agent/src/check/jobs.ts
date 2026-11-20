// Off-chain details of each vault order that the chain does not store (what the goods are, where to go).
// The agent records a job when it proposes an order; the rider app and the check service read it.
// Money-relevant numbers (ordered quantity, prices, rider, status) are always read from the vault, never from here.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Address } from 'viem';

export interface Place { name: string; lat: number; lng: number }
export interface Job {
  orderId: string;          // vault order id (decimal string)
  item: string;
  unit: string;
  quantity: number;         // for display only; the vault's `ordered` is authoritative
  rider: Address;
  supplier: Place;
  shop: Place;
  createdAt: number;
  /** Set when a logistics company delivers (absent for self-pickup and the simulated company). */
  logistics?: JobDelivery;
}

/** Booking with a logistics company. Off-chain only: the vault holds the fee and decides who is paid. */
export interface JobDelivery {
  carrier: string;              // carrier id, e.g. 'sendrelay'
  carrierName: string;
  job: import('../logistics/carrier.ts').DeliveryJob;
  quote: import('../logistics/carrier.ts').CarrierQuote;
  bookingId?: string;
  state?: import('../logistics/carrier.ts').DeliveryState;
  handoverCode?: string | null; // shown to the shop owner only
  trackingUrl?: string | null;
  riderName?: string | null;
  pickupSigned?: boolean;       // the company's key has confirmed the pickup on-chain
  arriveSigned?: boolean;       // ... and the arrival at the shop
  ownerCount?: number;          // what the owner counted at the door (attested by the check service)
  error?: string;               // last booking/dispatch problem, in plain words
  test: boolean;                // the carrier ran in test mode (simulated rider)
}

export class JobStore {
  private jobs = new Map<string, Job>();
  private file: string | null;
  constructor(file: string | null = null) {
    this.file = file;
    if (file && existsSync(file)) for (const j of JSON.parse(readFileSync(file, 'utf8')) as Job[]) this.jobs.set(j.orderId, j);
  }
  add(job: Job): void { this.jobs.set(job.orderId, job); this.save(); }
  /** Merge into a job's delivery record and save. */
  updateDelivery(orderId: string, patch: Partial<JobDelivery>): Job | undefined {
    const j = this.jobs.get(orderId);
    if (!j?.logistics) return j;
    j.logistics = { ...j.logistics, ...patch };
    this.save();
    return j;
  }
  get(orderId: bigint | string): Job | undefined { return this.jobs.get(String(orderId)); }
  forRider(rider: Address): Job[] { return [...this.jobs.values()].filter((j) => j.rider.toLowerCase() === rider.toLowerCase()); }
  all(): Job[] { return [...this.jobs.values()]; }
  private save(): void { if (this.file) writeFileSync(this.file, JSON.stringify(this.all(), null, 2)); }
}
