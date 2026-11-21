import { describe, expect, it } from 'vitest';
import { cleanMessage, draftMessage, whatsappLink } from '../src/discovery/draft.ts';
import type { Generate } from '../src/llm.ts';

const input = { request: '20 cartons of Indomie, under N300,000', sellerName: 'Agora Marketplace', area: 'Ketu, Lagos', delivery: 'logistics' as const };
const gemini = (message: string): Generate => (async () => ({ text: JSON.stringify({ message }), candidates: [{ finishReason: 'STOP' }] })) as unknown as Generate;

describe('the AI-written WhatsApp message', () => {
  it('uses the AI draft, stripped of links and phone numbers', async () => {
    const d = await draftMessage(gemini('Hello Agora Marketplace, I want 20 cartons of Indomie delivered to Ketu. Call 0803 123 4567 or see https://x.example. Do you have it?'), input);
    expect(d.ai).toBe(true);
    expect(d.message).not.toMatch(/0803|https?:|x\.example/);
    expect(d.message).toMatch(/20 cartons of Indomie/);
  });

  it('falls back to a fixed wording without AI, for pickup or delivery', async () => {
    const d = await draftMessage(null, input);
    expect(d).toMatchObject({ ai: false });
    expect(d.message).toMatch(/^Hello Agora Marketplace, I found your shop on StockRun\. I want to buy: 20 cartons of Indomie/);
    expect(d.message).toMatch(/delivered to Ketu, Lagos/);
    expect((await draftMessage(null, { ...input, delivery: 'self' })).message).toMatch(/come to pick it up/);
  });

  it('falls back when the AI answer is unusable', async () => {
    expect((await draftMessage(gemini('ok'), input)).ai).toBe(false);
  });

  it('builds a wa.me link with the message typed in', () => {
    expect(whatsappLink('+2348031234567', 'Hi & hello?')).toBe('https://wa.me/2348031234567?text=Hi%20%26%20hello%3F');
    expect(cleanMessage('a  <b>bold</b>  www.spam.ng')).toBe('a bold');
  });
});
