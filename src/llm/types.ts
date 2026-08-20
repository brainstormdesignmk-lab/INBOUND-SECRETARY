export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LlmRole = 'classify' | 'respond' | 'generate';

export interface CompleteOpts {
  role: LlmRole;
  messages: LlmMessage[];
  temperature: number;
  maxTokens: number;
  topP: number;
  json?: boolean;
  /** Called by the client that ACTUALLY serves the call (leaf backends only —
   *  e.g. 'gemini:1', 'groq'). Lets callers know which brain produced the
   *  completion, race-free, even through Hybrid/Rotating wrappers. */
  onProvider?: (provider: string) => void;
}

/** Every brain behind Lina speaks this one interface — swapping providers never touches callers. */
export interface LlmClient {
  complete(o: CompleteOpts): Promise<string>;
}
