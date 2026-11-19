// The StockRun agent: order text -> parsed lines -> suppliers -> negotiation -> rider -> vault proposal.
// Every step that touches money is checked twice: by the agent's own guardrails here, and by the
// RestockGuard circuit on X Layer, which has the final word. The agent key cannot move funds.
import type { Address } from 'viem';
import type { Extractor } from './llm.ts';
import { parseOrder } from './tools/parseOrder.ts';
import { searchSuppliers, supplierKey, type Candidate } from './tools/suppliers.ts';
import { negotiate, isDeal, type SupplierChannel, type Deal } from './tools/negotiate.ts';
import { bookRider } from './tools/riders.ts';
import { RESTOCK_REASONS, type ProposeResult, type VaultClient } from './tools/vault.ts';
import { CATEGORIES, type OrderLine, type Rider, type Shop, type SupplierStatus } from './types.ts';
import type { JobStore } from './check/jobs.ts';

export interface AgentDeps {
  extractor: Extractor;
  channel: SupplierChannel;
  vault: VaultClient;
  riders: Rider[];
  shop: Shop;
  /** Token units per naira (demo token: 6 decimals, 1 token = ₦1 -> 1_000_000n). */
  tokenPerNaira: bigint;
  maxSuppliersPerLine?: number;
  replyTimeoutMs?: number;
  /** Records each proposed order's off-chain details for the rider app and the photo check. */
  jobs?: JobStore;
}

export type LineOutcome =
  | { line: OrderLine; kind: 'proposed'; deal: Deal; rider: Rider; riderFeeNaira: number; result: ProposeResult }
  | { line: OrderLine; kind: 'no_supplier'; suggestions: Candidate[] }
  | { line: OrderLine; kind: 'no_deal'; tried: string[] }
  | { line: OrderLine; kind: 'no_rider'; deal: Deal };

export interface AgentReport { outcomes: LineOutcome[]; problems: string[]; message: string }

export async function handleOrder(text: string, d: AgentDeps): Promise<AgentReport> {
  const { order, problems } = await parseOrder(text, d.extractor);
  const statusCache = new Map<string, SupplierStatus>();
  for (const line of order.lines) {
    for (const c of searchSuppliers(line.item, d.shop, Math.max(order.radiusKm, 50), () => 0)) {
      if (!statusCache.has(c.supplier.id)) statusCache.set(c.supplier.id, Number(await d.vault.supplierStatus(supplierKey(c.supplier.id))) as SupplierStatus);
    }
  }
  const statusOf = (id: string) => statusCache.get(id) ?? 0;

  const outcomes: LineOutcome[] = [];
  for (const line of order.lines) {
    const all = searchSuppliers(line.item, d.shop, order.radiusKm, statusOf);
    const approved = all.filter((c) => c.status === 1 || c.status === 2);
    if (approved.length === 0) { outcomes.push({ line, kind: 'no_supplier', suggestions: all.slice(0, 3) }); continue; }

    let deal: Deal | null = null; let cand: Candidate | null = null; const tried: string[] = [];
    for (const c of approved.slice(0, d.maxSuppliersPerLine ?? 3)) {
      const r = await negotiate(c.supplier, line, c.listPriceNaira, d.channel, d.extractor, { timeoutMs: d.replyTimeoutMs });
      if (isDeal(r)) { deal = r; cand = c; break; }
      tried.push(`${c.supplier.name}: ${r.reason.replace('_', ' ')}`);
    }
    if (!deal || !cand) { outcomes.push({ line, kind: 'no_deal', tried }); continue; }

    const unitPrice = BigInt(deal.unitPriceNaira) * d.tokenPerNaira;
    const goodsValue = unitPrice * BigInt(line.quantity);
    const booked = await bookRider(d.riders, cand.supplier, d.shop, goodsValue, (a: Address) => d.vault.bond(a));
    if (!booked) { outcomes.push({ line, kind: 'no_rider', deal }); continue; }

    const result = await d.vault.propose({
      supplierKey: supplierKey(cand.supplier.id), ordered: line.quantity, unitPrice,
      cat: CATEGORIES[line.category], dist: cand.dist, rider: booked.rider.address,
      riderFee: BigInt(booked.feeNaira) * d.tokenPerNaira,
    });
    if ((result.status === 'locked' || result.status === 'ask_owner') && d.jobs) d.jobs.add({
      orderId: String(result.orderId), item: line.item, unit: line.unit, quantity: line.quantity, rider: booked.rider.address,
      supplier: { name: `${cand.supplier.name}, ${cand.supplier.market}`, lat: cand.supplier.lat, lng: cand.supplier.lng },
      shop: { name: d.shop.name, lat: d.shop.lat, lng: d.shop.lng }, createdAt: Date.now(),
    });
    outcomes.push({ line, kind: 'proposed', deal, rider: booked.rider, riderFeeNaira: booked.feeNaira, result });
  }
  return { outcomes, problems, message: ownerMessage(outcomes, problems) };
}

const ngn = (n: number) => `₦${n.toLocaleString('en-NG')}`;

/** WhatsApp summary for the shop owner. On-chain claims always carry the transaction hash. */
export function ownerMessage(outcomes: LineOutcome[], problems: string[]): string {
  const out: string[] = [];
  for (const o of outcomes) {
    const what = `${o.line.quantity} ${o.line.unit}(s) ${o.line.item}`;
    if (o.kind === 'no_supplier') {
      out.push(`✗ ${what}: no approved supplier nearby.` + (o.suggestions.length ? ` Suggest approving: ${o.suggestions.map((s) => `${s.supplier.name} (${s.km.toFixed(1)} km)`).join(', ')}.` : ''));
    } else if (o.kind === 'no_deal') {
      out.push(`✗ ${what}: no deal within your price. ${o.tried.join('; ')}.`);
    } else if (o.kind === 'no_rider') {
      out.push(`✗ ${what}: deal at ${ngn(o.deal.unitPriceNaira)} each with ${o.deal.supplier.name}, but no bonded rider is free.`);
    } else {
      const total = o.deal.unitPriceNaira * o.line.quantity;
      const head = `${what} from ${o.deal.supplier.name} at ${ngn(o.deal.unitPriceNaira)} each (${ngn(total)} + ${ngn(o.riderFeeNaira)} delivery, rider ${o.rider.name})`;
      const r = o.result;
      if (r.status === 'locked') out.push(`✓ ${head}. RestockGuard approved; funds locked in escrow. Order #${r.orderId}, tx ${r.txHash}. The supplier is paid only after the rider checks the goods.`);
      else if (r.status === 'ask_owner') out.push(`? ${head}. Needs your OK because ${RESTOCK_REASONS[r.reason] ?? `reason ${r.reason}`}. Reply YES ${r.orderId} to approve. (tx ${r.txHash})`);
      else if (r.status === 'rejected') out.push(`✗ ${head}. RestockGuard rejected it: ${RESTOCK_REASONS[r.reason] ?? `reason ${r.reason}`}. Nothing was charged.`);
      else if (r.status === 'too_large') out.push(`✗ ${head}. Too large for one order; split it.`);
      else out.push(`✗ ${head}. The circuit check failed, so the order is on hold. Nothing was charged.`);
    }
  }
  for (const p of problems) out.push(`! ${p}`);
  return out.join('\n');
}
