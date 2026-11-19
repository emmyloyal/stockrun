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
}

export class JobStore {
  private jobs = new Map<string, Job>();
  private file: string | null;
  constructor(file: string | null = null) {
    this.file = file;
    if (file && existsSync(file)) for (const j of JSON.parse(readFileSync(file, 'utf8')) as Job[]) this.jobs.set(j.orderId, j);
  }
  add(job: Job): void { this.jobs.set(job.orderId, job); this.save(); }
  get(orderId: bigint | string): Job | undefined { return this.jobs.get(String(orderId)); }
  forRider(rider: Address): Job[] { return [...this.jobs.values()].filter((j) => j.rider.toLowerCase() === rider.toLowerCase()); }
  all(): Job[] { return [...this.jobs.values()]; }
  private save(): void { if (this.file) writeFileSync(this.file, JSON.stringify(this.all(), null, 2)); }
}
