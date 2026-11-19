// Gemini wrapper: the request we send and how answers are validated, with a fake client (no network, no key).
import { describe, it, expect } from 'vitest';
import { GeminiExtractor, jsonSchemaFor, DEFAULT_MODEL, FALLBACK_MODEL, type Generate, type GenerateParams } from '../src/llm.ts';
import { GeminiPhotoCounter, PhotoCountSchema } from '../src/check/photoCount.ts';
import { ReplySchema } from '../src/tools/negotiate.ts';

function fake(answer: { text?: string; finishReason?: string; blockReason?: string }) {
  const calls: GenerateParams[] = [];
  const generate = (async (p: GenerateParams) => {
    calls.push(p);
    return {
      text: answer.text,
      candidates: [{ finishReason: answer.finishReason ?? 'STOP' }],
      promptFeedback: answer.blockReason ? { blockReason: answer.blockReason } : undefined,
    };
  }) as unknown as Generate;
  return { calls, generate };
}
const reply = { available: true, unitPriceNaira: 13800, acceptsOurOffer: false, quantityAvailable: null, pickupWindow: '2pm' };

describe('Gemini extractor', () => {
  it('sends the system instruction, the wrapped message and the JSON schema', async () => {
    const f = fake({ text: JSON.stringify(reply) });
    expect(await new GeminiExtractor(f.generate).extract(ReplySchema, 'read replies', 'Na 13,800 per carton')).toEqual(reply);
    const p = f.calls[0];
    expect(p.model).toBe(process.env.GEMINI_MODEL || DEFAULT_MODEL);
    expect(p.config).toMatchObject({ systemInstruction: 'read replies', responseMimeType: 'application/json', responseJsonSchema: jsonSchemaFor(ReplySchema) });
    expect(JSON.stringify(p.contents)).toContain('<message>\\nNa 13,800 per carton\\n</message>');
    expect(jsonSchemaFor(ReplySchema)).not.toHaveProperty('$schema');
  });
  it('returns null (so the order holds) for blocked, cut-off or malformed answers', async () => {
    const ex = (a: Parameters<typeof fake>[0]) => new GeminiExtractor(fake(a).generate).extract(ReplySchema, 'x', 'y');
    expect(await ex({ text: JSON.stringify(reply), blockReason: 'SAFETY' })).toBeNull();
    expect(await ex({ text: JSON.stringify(reply), finishReason: 'MAX_TOKENS' })).toBeNull();
    expect(await ex({ text: '{"available": true' })).toBeNull();
    expect(await ex({ text: JSON.stringify({ ...reply, unitPriceNaira: 'cheap' }) })).toBeNull();
    expect(await ex({})).toBeNull();
  });
});

describe('busy models', () => {
  it('falls back to the second model when the first is busy, and returns null when both fail', async () => {
    const tried: string[] = [];
    const busyThenOk = (async (p: GenerateParams) => {
      tried.push(p.model);
      if (tried.length === 1) throw new Error('503 UNAVAILABLE: high demand');
      return { text: JSON.stringify(reply), candidates: [{ finishReason: 'STOP' }] };
    }) as unknown as Generate;
    expect(await new GeminiExtractor(busyThenOk).extract(ReplySchema, 'x', 'y')).toEqual(reply);
    expect(tried).toEqual([...new Set([process.env.GEMINI_MODEL || DEFAULT_MODEL, FALLBACK_MODEL])].slice(0, 2));
    let calls = 0;
    const allBusy = (async () => { calls++; throw new Error('503'); }) as unknown as Generate;
    expect(await new GeminiExtractor(allBusy).extract(ReplySchema, 'x', 'y')).toBeNull();
    expect(calls).toBe(4); // two models, two rounds
  }, 10_000);
  it('goes round once more after a network blip on every model', async () => {
    let calls = 0;
    const blip = (async () => {
      if (++calls <= 2) throw new Error('fetch failed');
      return { text: JSON.stringify(reply), candidates: [{ finishReason: 'STOP' }] };
    }) as unknown as Generate;
    expect(await new GeminiExtractor(blip).extract(ReplySchema, 'x', 'y')).toEqual(reply);
    expect(calls).toBe(3);
  });
});

describe('Gemini photo counter', () => {
  it('sends the photo inline with the item and unit, never the ordered quantity', async () => {
    const answer = { itemVisible: true, count: 4, confidence: 'high', damage: false, damageNotes: '', photoProblem: 'none' };
    const f = fake({ text: JSON.stringify(answer) });
    const r = await new GeminiPhotoCounter(f.generate).count({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/jpeg' }, { item: 'Indomie carton', unit: 'carton' });
    expect(r).toEqual(answer);
    const parts = (f.calls[0].contents as { parts: Record<string, unknown>[] }[])[0].parts;
    expect(parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'AQID' } });
    expect(parts[1].text).toBe('Expected item: Indomie carton. Unit: carton. How many units do you see?');
    expect(f.calls[0].config?.responseJsonSchema).toEqual(jsonSchemaFor(PhotoCountSchema));
  });
});
