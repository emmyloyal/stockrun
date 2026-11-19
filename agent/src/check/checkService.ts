// The photo check service: holds the CHECK key, which can only attest photo counts (attestPickup / attestDelivery).
// It cannot move money, choose amounts or record the rider's own count. After attesting it asks the vault to settle;
// settling only runs the circuit, which decides who is paid. If anything fails, the order holds.
import {
  BaseError, ContractFunctionRevertedError, parseAbi, parseEventLogs,
  type Account, type Address, type Chain, type Hash, type PublicClient, type Transport, type WalletClient,
} from 'viem';
import { decideCount, checkPhoto, type Photo, type PhotoCounter } from './photoCount.ts';
import type { JobStore } from './jobs.ts';

export const checkAbi = parseAbi([
  'function orders(uint256) view returns (bytes32 supplierId, address payout, address rider, uint8 ordered, uint8 cat, uint8 dist, uint256 unitPrice, uint256 riderFee, uint8 status, uint64 createdAt, bool atSupplier, bool riderCounted, uint8 riderCount, bool aiCounted, uint8 aiCount, bool pickupDamage, uint8 picked, bool atShop, uint64 arrivedAt, bool aiDelivered, uint8 delivered, bool deliveryDamage, bool ownerOk, bool ownerIssue)',
  'function attestPickup(uint256 id, uint8 aiCount, bool damage)',
  'function attestDelivery(uint256 id, uint8 delivered, bool damage)',
  'function settlePickup(uint256 id)',
  'function settleDelivery(uint256 id)',
  'event SupplierPaid(uint256 indexed id, address payout, uint8 qty, uint256 amount, uint8 reason)',
  'event PickupHeld(uint256 indexed id, uint8 reason)',
  'event RiderPaid(uint256 indexed id, address rider, uint256 amount)',
  'event OwnerCompensated(uint256 indexed id, uint8 shortQty, uint256 amount)',
  'event DeliveryHeld(uint256 indexed id, uint8 reason)',
  'error NotAuthorized()', 'error BadStatus()', 'error CircuitFailed()',
]);

export const STATUS = { None: 0, AwaitingOwner: 1, Locked: 2, PickedUp: 3, Delivered: 4, Refunded: 5 } as const;

/** Reason codes in plain words (app/README.md). */
export const PICKUP_REASONS: Record<number, string> = {
  0: 'All goods counted. Supplier paid in full.',
  1: 'Rider is not at the supplier.',
  2: "Rider's bond is too low for this order.",
  3: 'Damaged goods. The supplier should replace them.',
  4: 'No goods counted.',
  5: 'Short supply. The supplier is paid for what was counted.',
};
export const DELIVERY_REASONS: Record<number, string> = {
  0: 'Delivered. Rider paid.',
  1: 'Rider is not at the shop yet.',
  2: 'The owner reported a problem. Under review.',
  3: 'Damage reported. Under review.',
  4: "Short delivery. The owner is paid back from the rider's bond.",
  5: "Waiting for the owner's confirmation.",
};

export type CheckResult =
  | { status: 'retake'; message: string }
  | { status: 'waiting_rider'; aiCount: number; damage: boolean; attestTx: Hash; message: string }
  | { status: 'settled'; outcome: 'paid' | 'paid_part' | 'held' | 'rider_paid' | 'compensated'; qty: number; reason: number;
      aiCount: number; damage: boolean; attestTx: Hash; settleTx: Hash; message: string }
  | { status: 'error'; message: string };

export class CheckService {
  readonly vault: Address;
  private pub: PublicClient;
  private checker: WalletClient<Transport, Chain, Account>;
  private counter: PhotoCounter;
  private jobs: JobStore;
  constructor(vault: Address, pub: PublicClient, checker: WalletClient<Transport, Chain, Account>, counter: PhotoCounter, jobs: JobStore) {
    this.vault = vault; this.pub = pub; this.checker = checker; this.counter = counter; this.jobs = jobs;
  }

  order(id: bigint) {
    return this.pub.readContract({ address: this.vault, abi: checkAbi, functionName: 'orders', args: [id] });
  }

  /** Pickup photo -> attestPickup -> settlePickup (PickupCheck pays the supplier for min(photo, rider, ordered)). */
  async pickup(orderId: bigint, photo: Photo): Promise<CheckResult> {
    return this.run(orderId, photo, 'pickup');
  }

  /** Delivery photo -> attestDelivery -> settleDelivery (DeliveryCheck pays the rider, compensates, or waits). */
  async delivery(orderId: bigint, photo: Photo): Promise<CheckResult> {
    return this.run(orderId, photo, 'delivery');
  }

  private async run(orderId: bigint, photo: Photo, stage: 'pickup' | 'delivery'): Promise<CheckResult> {
    try { checkPhoto(photo); } catch (e) { return { status: 'retake', message: (e as Error).message }; }
    const job = this.jobs.get(orderId);
    if (!job) return { status: 'error', message: `Order ${orderId} is not a known job.` };
    const o = await this.order(orderId);
    const statusNow = o[8], riderCounted = o[11];
    const expectedMax = stage === 'pickup' ? o[3] : o[16]; // ordered, or picked at pickup
    const wanted = stage === 'pickup' ? STATUS.Locked : STATUS.PickedUp;
    if (statusNow !== wanted) return { status: 'error', message: `Order ${orderId} is not waiting for a ${stage} check.` };

    const decision = decideCount(await this.counter.count(photo, { item: job.item, unit: job.unit }), expectedMax);
    if (!decision.attest) return { status: 'retake', message: decision.retake };

    try {
      const attestTx = await this.write(stage === 'pickup' ? 'attestPickup' : 'attestDelivery', [orderId, decision.aiCount, decision.damage]);
      if (stage === 'pickup' && !riderCounted)
        return { status: 'waiting_rider', aiCount: decision.aiCount, damage: decision.damage, attestTx, message: 'Photo checked. Waiting for the rider to enter their count.' };
      return { ...(await this.settle(orderId, stage)), aiCount: decision.aiCount, damage: decision.damage, attestTx };
    } catch (e) {
      return { status: 'error', message: `The vault refused (${revertName(e) ?? 'transaction failed'}). The order holds; nothing was paid.` };
    }
  }

  /** Run the circuit for a stage. Public so the rider app can settle after the rider's own step arrives second. */
  async settle(orderId: bigint, stage: 'pickup' | 'delivery') {
    const settleTx = await this.write(stage === 'pickup' ? 'settlePickup' : 'settleDelivery', [orderId]);
    const receipt = await this.pub.getTransactionReceipt({ hash: settleTx });
    const logs = parseEventLogs({ abi: checkAbi, logs: receipt.logs });
    for (const l of logs) {
      if (l.eventName === 'SupplierPaid') {
        const { qty, reason } = l.args;
        return { status: 'settled' as const, outcome: reason === 0 ? 'paid' as const : 'paid_part' as const, qty, reason, settleTx, message: PICKUP_REASONS[reason] ?? '' };
      }
      if (l.eventName === 'PickupHeld') return { status: 'settled' as const, outcome: 'held' as const, qty: 0, reason: l.args.reason, settleTx, message: PICKUP_REASONS[l.args.reason] ?? '' };
      if (l.eventName === 'RiderPaid') return { status: 'settled' as const, outcome: 'rider_paid' as const, qty: 0, reason: 0, settleTx, message: DELIVERY_REASONS[0] };
      if (l.eventName === 'OwnerCompensated') return { status: 'settled' as const, outcome: 'compensated' as const, qty: l.args.shortQty, reason: 4, settleTx, message: DELIVERY_REASONS[4] };
      if (l.eventName === 'DeliveryHeld') return { status: 'settled' as const, outcome: 'held' as const, qty: 0, reason: l.args.reason, settleTx, message: DELIVERY_REASONS[l.args.reason] ?? '' };
    }
    throw new Error('settlement emitted no result');
  }

  private async write(fn: 'attestPickup' | 'attestDelivery' | 'settlePickup' | 'settleDelivery', args: readonly unknown[]): Promise<Hash> {
    // Simulate first so a revert costs no gas and the order state is untouched.
    const { request } = await this.pub.simulateContract({ address: this.vault, abi: checkAbi, functionName: fn, args: args as never, account: this.checker.account });
    const hash = await this.checker.writeContract(request);
    const r = await this.pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${fn} reverted`);
    return hash;
  }
}

function revertName(e: unknown): string | undefined {
  const r = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
  return r instanceof ContractFunctionRevertedError ? r.data?.errorName : undefined;
}
