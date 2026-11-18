// The only place StockRun talks to an LLM. The model is used to UNDERSTAND text (owner orders,
// supplier replies). It never decides a price, a payment or a booking: code and the circuits do.
//
// - ClaudeExtractor: Claude Opus 5.5 with structured outputs (schema-validated JSON) and
//   server-side refusal fallbacks ("default" routing).
// - Any other Extractor (rule-based, tests) can be swapped in, so the demo runs without an API key.

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';

export interface Extractor {
  /** Returns data matching `schema`, or null if the text cannot be understood. */
  extract<S extends z.ZodType>(schema: S, instructions: string, text: string): Promise<z.infer<S> | null>;
}

export const MODEL = 'claude-opus-5-5';

export class ClaudeExtractor implements Extractor {
  private client: Anthropic;
  constructor(client = new Anthropic()) { this.client = client; }

  async extract<S extends z.ZodType>(schema: S, instructions: string, text: string): Promise<z.infer<S> | null> {
    const response = await this.client.beta.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(schema) },
      system: instructions,
      // The text comes from shop owners and suppliers: it is data to read, never instructions to follow.
      messages: [{ role: 'user', content: `<message>\n${text}\n</message>` }],
    });
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return null;
    return (response.parsed_output ?? null) as z.infer<S> | null;
  }
}

/** Use Claude when credentials are configured, otherwise the given offline fallback. */
export function defaultExtractor(fallback: Extractor): Extractor {
  const hasCreds = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
  return hasCreds ? new ClaudeExtractor() : fallback;
}
