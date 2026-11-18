// Simulated suppliers for the demo (docs/WHATSAPP.md: "two simulated supplier bots").
// Each bot opens slightly above its list price, has a private floor, and haggles in Pidgin-flavoured English.
import type { SupplierChannel } from '../tools/negotiate.ts';
import type { Supplier } from '../types.ts';

export interface Persona { openingMarkup: number; floorDiscount: number; stock: number; replyDelayMs: number; pickup: string }
const DEFAULT: Persona = { openingMarkup: 1.04, floorDiscount: 0.95, stock: 200, replyDelayMs: 0, pickup: '2pm' };

interface Conv { asked: number | null; floor: number; rounds: number; inbox: string[] }

export class BotChannel implements SupplierChannel {
  private convs = new Map<string, Conv>();
  readonly log: { to: string; text: string }[] = [];
  private personas: Record<string, Partial<Persona>>;
  constructor(personas: Record<string, Partial<Persona>> = {}) { this.personas = personas; }

  private persona(s: Supplier): Persona { return { ...DEFAULT, ...this.personas[s.id] }; }

  async send(to: Supplier, text: string): Promise<void> {
    this.log.push({ to: to.id, text });
    const p = this.persona(to);
    const c = this.convs.get(to.id) ?? { asked: null, floor: 0, rounds: 0, inbox: [] };
    this.convs.set(to.id, c);
    if (p.replyDelayMs < 0) return; // never answers
    const item = to.stocks.find((st) => text.includes(st.item));
    const qty = Number(text.match(/buy (\d+)/)?.[1] ?? text.match(/for (\d+)\?/)?.[1] ?? 0);

    if (/wants to buy/.test(text)) {
      if (!item) { c.inbox.push('Sorry, we no get that one now.'); return; }
      if (qty > p.stock) { c.inbox.push(`We only have ${p.stock} cartons left.`); return; }
      c.floor = Math.round((item.listPriceNaira * p.floorDiscount) / 100) * 100;
      c.asked = Math.round((item.listPriceNaira * p.openingMarkup) / 100) * 100;
      c.inbox.push(`Good afternoon. Na ₦${c.asked.toLocaleString('en-NG')} per one. Pickup after ${p.pickup}.`);
      return;
    }
    const offer = Number(text.match(/₦([\d,]+) per/)?.[1].replace(/,/g, '') ?? NaN);
    if (/Can you do/.test(text) && Number.isFinite(offer)) {
      c.rounds++;
      if (offer >= c.floor) { c.inbox.push(`Ok deal, ₦${offer.toLocaleString('en-NG')}. Come pick after ${p.pickup}.`); return; }
      const next = Math.max(c.floor, Math.round(((c.asked ?? offer) + offer) / 2 / 100) * 100);
      c.asked = next;
      c.inbox.push(c.rounds >= 2 ? `Last price ₦${next.toLocaleString('en-NG')}, I no fit go lower.` : `Abeg add small. ₦${next.toLocaleString('en-NG')}.`);
    }
    // "Deal:" confirmations and declines need no answer.
  }

  async nextReply(from: Supplier, _timeoutMs: number): Promise<string | null> {
    const c = this.convs.get(from.id);
    if (this.persona(from).replyDelayMs < 0) return null;
    return c?.inbox.shift() ?? null;
  }
}
