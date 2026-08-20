import { CompleteOpts, LlmClient } from './types';

// OpenAI-compatible surface of the Gemini API — same request/response shape as Groq.
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

// Gemini 3 are thinking models: they burn tokens on reasoning BEFORE the answer.
// The classifier's caller-side budget is 300 tokens — without headroom the visible
// content gets truncated to fragments (observed: "ување стан! За да ви помогнам да").
const THINKING_HEADROOM = 2048;

// After a 429 quota-exhaustion, skip the key entirely for this long. Free-tier
// limits are small and windowed; probing an exhausted key every request burns
// rejected calls that keep Google's window locked. A cooldown lets rotation go
// straight to healthy keys, with one probe when the cooldown expires.
const QUOTA_COOLDOWN_MS = 10 * 60_000;

// json_object only guarantees "valid JSON" — Gemini will invent its own schema
// (observed: {"status":"success","action":"real_estate_search",...}) and every
// message degrades to STAY. strict json_schema forces exactly the classifier's
// contract; mirrors parseClassified() in classify.ts.
const CLASSIFY_SCHEMA = {
  name: 'classified_intent',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      event: {
        type: 'string',
        enum: [
          'INTENT_DECLARED', 'PROPERTY_ID_REQUESTED', 'DETAILS_PROVIDED',
          'SEARCH_REQUESTED', 'INTERESTED', 'REJECTED', 'FEE_AGREED',
          'FEE_REFUSED', 'VISIT_TIME_PROVIDED', 'TIME_ACCEPTED', 'TIME_REJECTED',
          'CONTACT_PROVIDED', 'CONTACT_INCOMPLETE', 'ESCALATE', 'STAY',
        ],
      },
      service: { type: ['string', 'null'], enum: ['buy', 'rent', null] },
      location: { type: ['string', 'null'] },
      bedrooms: { type: ['integer', 'null'] },
      budget: { type: ['string', 'null'] },
      propertyId: { type: ['integer', 'null'] },
      visitTime: { type: ['string', 'null'] },
      name: { type: ['string', 'null'] },
      phone: { type: ['string', 'null'] },
      reason: { type: ['string', 'null'] },
      offensive: { type: 'boolean' },
      offenseLevel: { type: 'integer' },
    },
    required: [
      'event', 'service', 'location', 'bedrooms', 'budget', 'propertyId',
      'visitTime', 'name', 'phone', 'reason', 'offensive', 'offenseLevel',
    ],
    additionalProperties: false,
  },
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface GeminiChoice {
  message?: { content?: string };
}

export class GeminiClient implements LlmClient {
  private quotaUntil = 0;

  constructor(
    private apiKey: string,
    private model: string,
    private classifyModel: string,
    private timeoutMs = 60_000,
    /** Stable identity reported via CompleteOpts.onProvider (factory labels the
     *  three keys 'gemini:1'/'gemini:2'/'gemini:3'). */
    private provider = 'gemini',
  ) {}

  /** True while the key is on a 429 quota cooldown — RotatingClient skips it. */
  get quotaBlocked(): boolean {
    return Date.now() < this.quotaUntil;
  }

  async complete(o: CompleteOpts): Promise<string> {
    const model = o.role === 'classify' ? this.classifyModel : this.model;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(GEMINI_BASE, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            messages: o.messages,
            temperature: o.temperature,
            top_p: o.topP,
            max_tokens: Math.max(o.maxTokens, THINKING_HEADROOM),
            reasoning_effort: o.role === 'classify' ? 'low' : undefined,
            response_format: o.json
              ? { type: 'json_schema', json_schema: CLASSIFY_SCHEMA }
              : undefined,
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 200)}`);
        }
        const data = (await res.json()) as { choices?: GeminiChoice[] };
        const text = data.choices?.[0]?.message?.content?.trim() ?? '';
        if (!text) throw new Error('empty completion');
        o.onProvider?.(this.provider);
        return text;
      } catch (e) {
        lastErr = e;
        const status = (e as Error).message.match(/HTTP (\d+)/)?.[1];
        console.error(`[gemini] attempt ${attempt} failed:`, (e as Error).message);
        // Quota/rate-limit: retrying the same key is futile — fail over to the next
        // rotating backend (or the Groq fallback) immediately instead of a retry storm.
        if (status === '429') {
          this.quotaUntil = Date.now() + QUOTA_COOLDOWN_MS;
          console.warn(`[gemini] quota exhausted — key blocked for ${QUOTA_COOLDOWN_MS / 60_000} min (rotation will skip it)`);
          throw e;
        }
        if (attempt < 3) await sleep(500 * attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('gemini failed');
  }
}
