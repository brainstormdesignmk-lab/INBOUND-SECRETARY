import Groq from 'groq-sdk';
import { CompleteOpts, LlmClient } from './types';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// All current Groq free-tier models are reasoning/thinking models:
// - qwen/qwen3.6-27b: returns <think> tags in content (reasoning_format='raw')
// - openai/gpt-oss-20b/120b: returns reasoning in message.reasoning field
// We disable/suppress reasoning for classify (speed) and persona (no junk to user).
function isThinkingModel(model: string): boolean {
  return /^(qwen\/|openai\/gpt-oss-)/i.test(model);
}

/** Strip <think>...</think> tags that thinking models embed in content. */
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export class GroqClient implements LlmClient {
  private client: Groq;
  private model: string;
  private classifyModel: string;
  private provider: string;

  constructor(apiKey: string, model: string, classifyModel: string, provider = 'groq') {
    this.client = new Groq({ apiKey });
    this.model = model;
    this.classifyModel = classifyModel;
    this.provider = provider;
  }

  async complete(o: CompleteOpts): Promise<string> {
    const model = o.role === 'classify' ? this.classifyModel : this.model;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const params: Record<string, unknown> = {
          model,
          messages: o.messages,
          temperature: o.temperature,
          top_p: o.topP,
          response_format: o.json ? { type: 'json_object' } : undefined,
        };

        // Reasoning models use max_completion_tokens (not max_tokens).
        // The default 1024 is the Groq-recommended floor for reasoning models.
        if (isThinkingModel(model)) {
          params.max_completion_tokens = Math.max(o.maxTokens, 1024);

          // Classify: disable reasoning entirely (Qwen) or minimize it (GPT-OSS)
          // so the 300-token budget is used for JSON output, not internal thinking.
          // Persona: suppress thinking so the customer never sees <think> tags.
          if (o.role === 'classify') {
            // Qwen supports reasoning_effort: 'none'; GPT-OSS: 'low'.
            params.reasoning_effort = /^qwen\//i.test(model) ? 'none' : 'low';
            params.reasoning_format = 'hidden';
          } else {
            // Persona: Qwen can disable reasoning entirely; GPT-OSS minimize it.
            params.reasoning_effort = /^qwen\//i.test(model) ? 'none' : 'low';
            params.reasoning_format = 'hidden';
          }
        } else {
          params.max_tokens = o.maxTokens;
        }

        const res = await this.client.chat.completions.create(params as any);
        let text = res.choices[0]?.message?.content?.trim() ?? '';
        if (!text) throw new Error('empty completion');

        // Safety net: strip <think> tags in case reasoning_format didn't suppress them
        if (isThinkingModel(model)) {
          text = stripThinkTags(text);
        }
        if (!text) throw new Error('empty completion after stripping thinking tags');

        o.onProvider?.(this.provider);
        return text;
      } catch (e) {
        lastErr = e;
        console.error(`[groq] attempt ${attempt} failed:`, (e as Error).message);
        if (attempt < 3) await sleep(500 * attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('groq failed');
  }
}
