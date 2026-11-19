// Offline Extractor: reads orders and supplier replies with rules, so the demo and tests run without
// an API key. Gemini (src/llm.ts) handles free-form Pidgin/Yoruba text far better; this is the floor.
import type { z } from 'zod';
import type { Extractor } from './llm.ts';
import { OrderSchema, ruleParseOrder, naira } from './tools/parseOrder.ts';
import { ReplySchema, type Reply } from './tools/negotiate.ts';
import { PriceListSchema, ruleParsePriceList } from './prices/priceList.ts';

export function ruleParseReply(text: string): Reply {
  const t = text.toLowerCase();
  const unavailable = /(no stock|finish|we no get|don't have|do not have|not available|sold out)/.test(t);
  const accepts = /\b(ok(ay)?|deal|agreed?|accept(ed)?|no wahala|confirmed?|done)\b/.test(t) && !/\bno\b(?! wahala)/.test(t);
  const prices = [...t.matchAll(/₦?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?k|\d{4,})/g)].map((m) => naira(m[1])).filter((x): x is number => x !== null);
  const qty = t.match(/(?:only|just|have|get)\s+(\d{1,3})\s*(?:cartons?|bags?|crates?|packs?|left|remaining)/);
  const pickup = t.match(/(?:pick(?:up)?|come)\s+(?:after|by|at|before)\s+([0-9: ]+(?:am|pm)?)/);
  return {
    available: !unavailable,
    unitPriceNaira: prices.length ? prices[prices.length - 1] : null,
    acceptsOurOffer: accepts,
    quantityAvailable: qty ? parseInt(qty[1], 10) : null,
    pickupWindow: pickup ? pickup[1].trim() : null,
  };
}

export class RuleExtractor implements Extractor {
  async extract<S extends z.ZodType>(schema: S, _instructions: string, text: string): Promise<z.infer<S> | null> {
    // Match on the schema's fields, not object identity: a test runner can load a module twice, and two copies of
    // the same schema are different objects.
    if (sameShape(schema, OrderSchema)) return ruleParseOrder(text) as z.infer<S>;
    if (sameShape(schema, ReplySchema)) return ruleParseReply(text) as z.infer<S>;
    if (sameShape(schema, PriceListSchema)) return ruleParsePriceList(text) as z.infer<S>;
    return null;
  }
}

const keys = (s: z.ZodType) => Object.keys((s as unknown as { shape?: Record<string, unknown> }).shape ?? {}).sort().join(',');
const sameShape = (a: z.ZodType, b: z.ZodType) => keys(a) !== '' && keys(a) === keys(b);
