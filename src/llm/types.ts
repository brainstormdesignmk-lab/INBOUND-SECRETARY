export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LlmRole = 'classify' | 'respond';

export interface CompleteOpts {
  role: LlmRole;
  messages: LlmMessage[];
  temperature: number;
  maxTokens: number;
  topP: number;
  json?: boolean;
}

/** Every brain behind Lina speaks this one interface — swapping providers never touches callers. */
export interface LlmClient {
  complete(o: CompleteOpts): Promise<string>;
}
