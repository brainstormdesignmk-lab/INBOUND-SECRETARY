import Groq from 'groq-sdk';
import { CompleteOpts, LlmClient } from './types';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class GroqClient implements LlmClient {
  private client: Groq;
  private model: string;
  private classifyModel: string;

  constructor(apiKey: string, model: string, classifyModel: string) {
    this.client = new Groq({ apiKey });
    this.model = model;
    this.classifyModel = classifyModel;
  }

  async complete(o: CompleteOpts): Promise<string> {
    const model = o.role === 'classify' ? this.classifyModel : this.model;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.client.chat.completions.create({
          model,
          messages: o.messages,
          temperature: o.temperature,
          top_p: o.topP,
          max_tokens: o.maxTokens,
          response_format: o.json ? { type: 'json_object' } : undefined,
        });
        const text = res.choices[0]?.message?.content?.trim() ?? '';
        if (!text) throw new Error('empty completion');
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
