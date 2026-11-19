// message_supplier + negotiation. The AI reader (Gemini, or the rule reader) only READS supplier replies.
// Prices, counter-offers and the walk-away point are decided here, in code, within the owner's limit.
import { z } from 'zod';
import type { Extractor } from '../llm.ts';
import type { OrderLine, Supplier } from '../types.ts';

export interface SupplierChannel {
  send(to: Supplier, text: string): Promise<void>;
  /** Next reply from `from`, or null on timeout. */
  nextReply(from: Supplier, timeoutMs: number): Promise<string | null>;
}

export const ReplySchema = z.object({
  available: z.boolean().describe('Supplier has the item and can sell'),
  unitPriceNaira: z.number().nullable().describe('Price per unit the supplier is now asking or agreeing to, in naira'),
  acceptsOurOffer: z.boolean().describe('Supplier explicitly agreed to the price we offered'),
  quantityAvailable: z.number().nullable().describe('Units the supplier can sell, if stated'),
  pickupWindow: z.string().nullable().describe('When goods can be picked up, if stated'),
});
export type Reply = z.infer<typeof ReplySchema>;

const replyInstructions = `You read WhatsApp replies from Lagos wholesalers to a buyer's price request (English or Nigerian Pidgin).
Report what the supplier said: whether they can sell, the price per unit they are asking or agreeing to, whether they
accepted the buyer's offer, quantity available and pickup time. "13k" = 13000, "13,500" = 13500.
If the supplier names a different price than the buyer offered, that is a counter-offer, not acceptance.`;

// ---- outgoing messages: fixed wording only. Payment is ALWAYS described as after the rider's check.
const ngn = (n: number) => `₦${n.toLocaleString('en-NG')}`;
export const messages = {
  request: (s: Supplier, l: OrderLine) =>
    `Hello ${s.name}, StockRun wants to buy ${l.quantity} ${l.unit}(s) of ${l.item} for pickup today. ` +
    `Payment is made when our rider checks the goods at your shop. Please reply with your price per ${l.unit}.`,
  counter: (l: OrderLine, price: number) =>
    `Thank you. Can you do ${ngn(price)} per ${l.unit} for ${l.quantity}? Payment is made when our rider checks the goods at your shop.`,
  confirm: (l: OrderLine, price: number) =>
    `Deal: ${l.quantity} ${l.unit}(s) of ${l.item} at ${ngn(price)} each. Our rider will come to check and collect. ` +
    `Payment is made when the rider has checked the goods.`,
  decline: () => `Thank you for your time. We will not take it at that price today.`,
};

/** Guardrail: outgoing text must never promise payment before the pickup check. */
export function assertSafeMessage(text: string): void {
  if (/\b(deposit|advance|upfront|up front|pay (?:you )?(?:now|first|before)|send (?:the )?money)\b/i.test(text))
    throw new Error(`blocked unsafe supplier message: ${text}`);
  if (!/rider (?:checks|has checked)/i.test(text) && /\bpay/i.test(text))
    throw new Error(`payment mentioned without the pickup-check condition: ${text}`);
}

export interface Deal { supplier: Supplier; line: OrderLine; unitPriceNaira: number; pickupWindow: string | null; transcript: string[] }
export interface NoDeal { supplier: Supplier; reason: 'no_reply' | 'unavailable' | 'too_expensive' | 'unclear'; transcript: string[] }

/**
 * The agent's ceiling: the owner's max unit price, or (if none) the catalogue list price + 5%.
 * The agent never agrees above it; RestockGuard still checks the order total against budget and limit.
 */
export function ceilingFor(line: OrderLine, listPriceNaira: number): number {
  return line.maxUnitPriceNaira ?? Math.round((listPriceNaira * 1.05) / 100) * 100;
}

export async function negotiate(
  supplier: Supplier, line: OrderLine, listPriceNaira: number, channel: SupplierChannel, ex: Extractor,
  opts: { timeoutMs?: number; rounds?: number } = {},
): Promise<Deal | NoDeal> {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000, rounds = opts.rounds ?? 3;
  const ceiling = ceilingFor(line, listPriceNaira);
  const transcript: string[] = [];
  const say = async (text: string) => { assertSafeMessage(text); transcript.push(`StockRun: ${text}`); await channel.send(supplier, text); };
  const hear = async (): Promise<Reply | null | 'timeout'> => {
    const text = await channel.nextReply(supplier, timeoutMs);
    if (text === null) return 'timeout';
    transcript.push(`${supplier.name}: ${text}`);
    return ex.extract(ReplySchema, replyInstructions, text);
  };

  await say(messages.request(supplier, line));
  let offered: number | null = null;
  for (let round = 0; round < rounds; round++) {
    const r = await hear();
    if (r === 'timeout') return { supplier, reason: 'no_reply', transcript };
    if (!r) return { supplier, reason: 'unclear', transcript };
    if (!r.available || (r.quantityAvailable !== null && r.quantityAvailable < line.quantity)) {
      await say(messages.decline());
      return { supplier, reason: 'unavailable', transcript };
    }
    const agreed = r.acceptsOurOffer && offered !== null ? offered : r.unitPriceNaira;
    if (agreed === null) return { supplier, reason: 'unclear', transcript };
    const price = Math.round(agreed);

    // Accept if the supplier agreed to our offer, or their price is at/below what we last offered.
    if ((r.acceptsOurOffer && offered !== null) || (offered !== null && price <= offered)) {
      if (price > ceiling) break; // never happens by construction, kept as a hard stop
      await say(messages.confirm(line, price));
      return { supplier, line, unitPriceNaira: price, pickupWindow: r.pickupWindow, transcript };
    }
    if (round === rounds - 1) {
      if (price <= ceiling) { await say(messages.confirm(line, price)); return { supplier, line, unitPriceNaira: price, pickupWindow: r.pickupWindow, transcript }; }
      break;
    }
    // Counter: 5% under their ask on the first round, then meet halfway; never above the ceiling.
    const target = offered === null ? price * 0.95 : (price + offered) / 2;
    const next = Math.min(ceiling, Math.round(target / 100) * 100);
    if (offered !== null && next <= offered) { // no room left
      if (price <= ceiling) { await say(messages.confirm(line, price)); return { supplier, line, unitPriceNaira: price, pickupWindow: r.pickupWindow, transcript }; }
      break;
    }
    offered = next;
    await say(messages.counter(line, offered));
  }
  await say(messages.decline());
  return { supplier, reason: 'too_expensive', transcript };
}

export const isDeal = (x: Deal | NoDeal): x is Deal => 'unitPriceNaira' in x;
