// propose_order: the agent key's ONLY write. It proposes; RestockGuard (a TapeOut circuit) decides.
import {
  BaseError, ContractFunctionRevertedError, parseAbi, parseEventLogs,
  type Account, type Address, type Chain, type Hash, type PublicClient, type Transport, type WalletClient,
} from 'viem';

export const vaultAbi = parseAbi([
  'function proposeOrder(bytes32 supplierId, uint8 ordered, uint256 unitPrice, uint8 cat, uint8 dist, address rider, uint256 riderFee) returns (uint256)',
  'function supplierStatus(bytes32) view returns (uint8)',
  'function trustedHandler(address) view returns (bool)',
  'function unit() view returns (uint256)',
  'function weeklyBudget() view returns (uint256)',
  'function spentThisWeek() view returns (uint256)',
  'function limit() view returns (uint256)',
  'event OrderProposed(uint256 indexed id, uint8 decision, uint8 reason)',
  'event OrderLocked(uint256 indexed id, uint256 amount)',
  'error NotAuthorized()', 'error BadStatus()', 'error CircuitFailed()', 'error Rejected(uint8 reason)', 'error OrderTooLarge()', 'error NoPayout()', 'error UntrustedHandler()', 'error SelfPickupHasNoFee()',
]);

/** RestockGuard reason codes (docs/CIRCUITS.md), worded for the shop owner. */
export const RESTOCK_REASONS: Record<number, string> = {
  0: 'approved and paid into escrow',
  1: 'this supplier is not on your approved list (or is blocked)',
  2: 'it is over your remaining weekly budget',
  3: 'it is above your auto-approve limit',
  4: 'this kind of item always needs your approval',
  5: 'the supplier is more than 10 km away',
};

export type ProposeResult =
  | { status: 'locked'; orderId: bigint; txHash: Hash; reason: 0 }
  | { status: 'ask_owner'; orderId: bigint; txHash: Hash; reason: number }
  | { status: 'rejected'; reason: number }
  | { status: 'too_large' }
  | { status: 'circuit_failed' };

export interface ProposeArgs { supplierKey: Hash; ordered: number; unitPrice: bigint; cat: number; dist: number; rider: Address; riderFee: bigint }

export class VaultClient {
  readonly address: Address;
  private pub: PublicClient;
  private agent: WalletClient<Transport, Chain, Account>;
  constructor(address: Address, pub: PublicClient, agent: WalletClient<Transport, Chain, Account>) {
    this.address = address; this.pub = pub; this.agent = agent;
  }

  supplierStatus(key: Hash) { return this.pub.readContract({ address: this.address, abi: vaultAbi, functionName: 'supplierStatus', args: [key] }); }
  /** True for the shop owner (self-pickup) and for logistics companies the owner approved. */
  trustedHandler(who: Address) { return this.pub.readContract({ address: this.address, abi: vaultAbi, functionName: 'trustedHandler', args: [who] }); }

  async propose(a: ProposeArgs): Promise<ProposeResult> {
    const args = [a.supplierKey, a.ordered, a.unitPrice, a.cat, a.dist, a.rider, a.riderFee] as const;
    try {
      // Simulate first: a REJECT reverts (nothing is stored), so it costs no gas and we learn the reason.
      const { request } = await this.pub.simulateContract({ address: this.address, abi: vaultAbi, functionName: 'proposeOrder', args, account: this.agent.account });
      const txHash = await this.agent.writeContract(request);
      const receipt = await this.pub.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') return { status: 'circuit_failed' };
      const [ev] = parseEventLogs({ abi: vaultAbi, eventName: 'OrderProposed', logs: receipt.logs });
      if (!ev) return { status: 'circuit_failed' };
      const { id, decision, reason } = ev.args;
      if (decision === 2) return { status: 'locked', orderId: id, txHash, reason: 0 };
      if (decision === 1) return { status: 'ask_owner', orderId: id, txHash, reason };
      return { status: 'circuit_failed' };
    } catch (e) {
      const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
      if (revert instanceof ContractFunctionRevertedError) {
        const name = revert.data?.errorName;
        if (name === 'Rejected') return { status: 'rejected', reason: Number(revert.data?.args?.[0] ?? 0) };
        if (name === 'OrderTooLarge') return { status: 'too_large' };
        if (name === 'CircuitFailed') return { status: 'circuit_failed' };
      }
      throw e;
    }
  }
}
