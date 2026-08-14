import * as path from 'path';
import * as os from 'os';
import dotenv from 'dotenv';

// Lina's secrets live OUTSIDE the project: ~/.lina/lina.env (mode 600, her own keys —
// separate from ANA's ~/.ana/ana.env). A .env* file in the project CWD crashes the
// Freebuff CLI terminal broker (its --env-file loader needs Node >= 20.6; this box runs
// 18.20), so the bot must never depend on one. Real process env (pm2/systemd) wins.
dotenv.config({ path: path.join(os.homedir(), '.lina', 'lina.env') });

export interface AppConfig {
  port: number;
  groqApiKey: string;
  groqModel: string;
  groqModelClassify: string;
  personaTemp: number;
  ownerTypingDelayMs: number; // owner "typing" window before Lina relays (Enter bypasses)
  classifyTemp: number;
  topP: number;
  topK: number;
  maxTokens: number;
  llmProvider: 'gemini' | 'groq' | 'hybrid';
  geminiApiKey: string;
  geminiApiKey2: string;
  geminiApiKey3: string;
  geminiModel: string;
  geminiModelClassify: string;
  viberToken: string;
  viberWebhookUrl: string;
  viberSenderName: string;
  viberSenderAvatar: string;
  propertyDataUrl: string;
  publicSiteUrl: string; // customers' public property pages — feed gives only /property/<uuid>
  dbPath: string;
  minDelayMs: number;
  maxDelayMs: number;
  simFast: boolean;
  chatTtlMinutes: number;
  monthlyInitiatedLimit: number;
  maxHistory: number;
  agentDefaultPhone: string;
  ownerCheckTimeoutMinutes: number;
  negotiationCap: number;
  ownerAgentMode: 'local' | 'deferred'; // local = instant verdicts (sim), deferred = wait for /owner or Hermes
}

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const cfg: AppConfig = {
    port: num(process.env.PORT, 8080),
    groqApiKey: process.env.GROQ_API_KEY || '',
    groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    groqModelClassify: process.env.GROQ_MODEL_CLASSIFY || 'llama-3.3-70b-versatile',
    personaTemp: num(process.env.PERSONA_TEMP, 0.8),
    ownerTypingDelayMs: num(process.env.OWNER_TYPING_DELAY_MS, 30_000),
    classifyTemp: num(process.env.CLASSIFY_TEMP, 0.2),
    topP: num(process.env.TOP_P, 0.95),
    topK: num(process.env.TOP_K, 40),
    maxTokens: num(process.env.MAX_TOKENS, 1024),
    llmProvider: (process.env.LLM_PROVIDER as AppConfig['llmProvider']) || 'hybrid',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiApiKey2: process.env.GEMINI_API_KEY_2 || '',
    geminiApiKey3: process.env.GEMINI_API_KEY_3 || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    geminiModelClassify: process.env.GEMINI_MODEL_CLASSIFY || 'gemini-3.6-flash',
    viberToken: process.env.VIBER_TOKEN || '',
    viberWebhookUrl: process.env.VIBER_WEBHOOK_URL || '',
    viberSenderName: process.env.VIBER_SENDER_NAME || 'Lina',
    viberSenderAvatar: process.env.VIBER_SENDER_AVATAR || '',
    propertyDataUrl: process.env.PROPERTY_DATA_URL ||
      'https://qkgioqotxjxffiaufgwd.supabase.co/functions/v1/public-properties?format=json',
    publicSiteUrl: process.env.PUBLIC_SITE_URL || 'https://preview--home-scan-search.lovable.app',
    dbPath: process.env.DB_PATH || path.join(process.cwd(), 'data', 'lina.db'),
    minDelayMs: num(process.env.MIN_DELAY_MS, 800),
    maxDelayMs: num(process.env.MAX_DELAY_MS, 2200),
    simFast: process.env.SIM_FAST === '1',
    chatTtlMinutes: num(process.env.CHAT_TTL_MINUTES, 60),
    monthlyInitiatedLimit: num(process.env.MONTHLY_INITIATED_LIMIT, 9500),
    maxHistory: num(process.env.MAX_HISTORY, 20),
    agentDefaultPhone: process.env.AGENT_DEFAULT_PHONE || '076247467',
    ownerCheckTimeoutMinutes: num(process.env.OWNER_CHECK_TIMEOUT_MINUTES, 30),
    negotiationCap: num(process.env.NEGOTIATION_CAP, 3),
    ownerAgentMode: (process.env.OWNER_AGENT_MODE as AppConfig['ownerAgentMode']) || 'deferred',
  };
  if (overrides.simFast) cfg.simFast = true;
  if (!cfg.groqApiKey && cfg.llmProvider !== 'gemini') {
    console.warn('[config] GROQ_API_KEY missing — Groq unavailable (fallback only).');
  }
  if ((cfg.llmProvider === 'gemini' || cfg.llmProvider === 'hybrid') && !cfg.geminiApiKey) {
    console.warn('[config] GEMINI_API_KEY missing — persona will fall back to Groq.');
  }
  return cfg;
}
