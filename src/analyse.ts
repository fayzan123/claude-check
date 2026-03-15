import Anthropic from '@anthropic-ai/sdk';
import { buildMetaPrompt } from './prompts.js';

export interface AnalysisResult {
  complexity: 'LOW' | 'MEDIUM' | 'HIGH';
  estimated_messages_min: number;
  estimated_messages_max: number;
  interrupt_risk: 'LOW' | 'MEDIUM' | 'HIGH';
  interrupt_risk_reason: string;
  recommended_model: string;
  recommended_model_reason: string;
  breakdown: string[] | null;
}

export interface AuthOptions {
  apiKey?: string;
  authToken?: string;
}

function isTransientError(err: unknown): boolean {
  return (
    err instanceof Anthropic.APIConnectionError ||
    err instanceof Anthropic.APIConnectionTimeoutError
  );
}

export async function analysePrompt(
  auth: AuthOptions | string,
  userPrompt: string,
  modelOverride?: string,
  planMultiplier?: number
): Promise<AnalysisResult> {
  // Accept legacy string (apiKey) or new AuthOptions object
  const opts: AuthOptions = typeof auth === 'string' ? { apiKey: auth } : auth;
  const client = new Anthropic(
    opts.authToken ? { authToken: opts.authToken } : { apiKey: opts.apiKey }
  );

  const metaPrompt = buildMetaPrompt(userPrompt, planMultiplier);

  const MAX_ATTEMPTS = 3;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await client.messages.create({
        model: modelOverride ?? 'claude-haiku-4-5',
        max_tokens: 512,
        messages: [{ role: 'user', content: metaPrompt }],
      });

      const textBlock = response.content.find((block) => block.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('No text content in API response');
      }

      const raw = textBlock.text.trim();

      // Strip markdown code fences if the model wraps its response
      const jsonStr = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

      try {
        const parsed: AnalysisResult = JSON.parse(jsonStr);
        return parsed;
      } catch {
        // Preserve raw response so caller can display it
        const err = new Error(`Analysis response could not be parsed as JSON.\n\nRaw response:\n${raw}`);
        err.name = 'ParseError';
        throw err;
      }
    } catch (err) {
      lastError = err;

      // Never retry parse errors or auth errors — they won't improve on retry
      if (
        (err instanceof Error && err.name === 'ParseError') ||
        err instanceof Anthropic.AuthenticationError
      ) {
        throw err;
      }

      // Retry transient network errors with exponential backoff
      if (isTransientError(err) && attempt < MAX_ATTEMPTS - 1) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }

      throw err;
    }
  }

  throw lastError;
}
