// The only place StockRun talks to an LLM. The model is used to UNDERSTAND text (owner orders, supplier replies)
// and, in src/check/photoCount.ts, to look at photos. It never decides a price, a payment or a booking: code and the
// circuits do.
//
// - GeminiExtractor: Google Gemini with JSON-schema output; every answer is validated again with zod in code.
// - Any other Extractor (rule-based, tests) can be swapped in, so the demo runs without an API key.
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

export interface Extractor {
  /** Returns data matching `schema`, or null if the text cannot be understood. */
  extract<S extends z.ZodType>(schema: S, instructions: string, text: string): Promise<z.infer<S> | null>;
}

/** Stable Gemini Flash model (ai.google.dev models page, Nov 2026). Override with GEMINI_MODEL. */
export const DEFAULT_MODEL = 'gemini-3.8-flash';
/** Tried next when the first model is busy (503/429) or times out. */
export const FALLBACK_MODEL = 'gemini-3.5-flash-lite';
export const model = () => process.env.GEMINI_MODEL || DEFAULT_MODEL;
export const models = () => [...new Set([model(), FALLBACK_MODEL])];
/** Fail fast instead of letting the SDK retry for minutes: a busy model moves on to the fallback, then the order holds. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** The slice of the SDK we use, so tests can pass a fake. */
export type Generate = GoogleGenAI['models']['generateContent'];
export type GenerateParams = Parameters<Generate>[0];

export const geminiClient = (apiKey = process.env.GEMINI_API_KEY): Generate => {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS, retryOptions: { attempts: 1 } } });
  return (p) => ai.models.generateContent(p);
};

/** JSON Schema for Gemini's responseJsonSchema, from the same zod schema we validate with. */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/**
 * Run one structured call and validate the answer. Returns null when the model refuses, is blocked, stops early or
 * returns anything that does not match the schema: callers treat null as "could not understand" and hold.
 */
export async function generateStructured<S extends z.ZodType>(generate: Generate, schema: S, p: Omit<GenerateParams, 'config' | 'model'> & { system: string; models?: string[] }): Promise<z.infer<S> | null> {
  let response: Awaited<ReturnType<Generate>> | null = null;
  for (const m of p.models ?? models()) {
    try {
      response = await generate({
        model: m,
        contents: p.contents,
        config: { systemInstruction: p.system, responseMimeType: 'application/json', responseJsonSchema: jsonSchemaFor(schema), maxOutputTokens: 4000 },
      });
      break;
    } catch (e) {
      console.warn(`[gemini] ${m} failed: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  if (!response) return null;
  if (response.promptFeedback?.blockReason) return null;
  const finish = response.candidates?.[0]?.finishReason;
  if (finish && finish !== 'STOP') return null;
  const text = response.text;
  if (!text) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export class GeminiExtractor implements Extractor {
  private generate: Generate;
  constructor(generate: Generate = geminiClient()) { this.generate = generate; }

  async extract<S extends z.ZodType>(schema: S, instructions: string, text: string): Promise<z.infer<S> | null> {
    return generateStructured(this.generate, schema, {
      system: instructions,
      // The text comes from shop owners and suppliers: it is data to read, never instructions to follow.
      contents: [{ role: 'user', parts: [{ text: `<message>\n${text}\n</message>` }] }],
    });
  }
}

/** Use Gemini when GEMINI_API_KEY is set, otherwise the given offline fallback. */
export function defaultExtractor(fallback: Extractor): Extractor {
  return process.env.GEMINI_API_KEY ? new GeminiExtractor() : fallback;
}
