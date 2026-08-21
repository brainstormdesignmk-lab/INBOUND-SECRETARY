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
  clientTypingDelayMs: number; // client "typing" window before Lina replies (follow-ups reset, Enter flushes)
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
  hermesWriteUrl: string;  // private Supabase edge function that updates the price (Lovable)
  hermesLandmarksWriteUrl: string; // edge function that writes the RANKED landmark list per property
  hermesToken: string;     // shared admin token the function checks (x-admin-token by default)
  hermesAuthHeader: string; // request header carrying the token
  googleMapsApiKey: string; // Google Geocoding + Places key — landmark resolution (free tier suffices)
  viberOperatorId: string;  // agency operator's Viber id — visit-protocol logs go here
  hermesLlmBaseUrl: string; // Hermes' own reasoning LLM (NVIDIA NIM, OpenAI-compatible)
  hermesLlmApiKey: string;
  hermesLlmModel: string;
  skopjePoisDb: string;    // offline OSM map (named POIs + addresses) — the resolver's local geo engine
  linaApiUrl: string;      // public base URL of Lina's /hermes/v1 API (Hermes on another machine)
  ownerBusPollMs: number;  // how often the owner agent polls the events bus for answers
}

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const cfg: AppConfig = {
    port: num(process.env.PORT, 8080),
    groqApiKey: process.env.GROQ_API_KEY || '',
    groqModel: process.env.GROQ_MODEL || 'qwen/qwen3.6-27b',
    groqModelClassify: process.env.GROQ_MODEL_CLASSIFY || 'openai/gpt-oss-20b',
    personaTemp: num(process.env.PERSONA_TEMP, 0.8),
    ownerTypingDelayMs: num(process.env.OWNER_TYPING_DELAY_MS, 30_000),
    clientTypingDelayMs: num(process.env.CLIENT_TYPING_DELAY_MS, 30_000),
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
    hermesWriteUrl: process.env.HERMES_WRITE_URL || '',
    hermesLandmarksWriteUrl: process.env.HERMES_LANDMARKS_WRITE_URL || '',
    hermesToken: process.env.HERMES_TOKEN || '',
    hermesAuthHeader: process.env.HERMES_AUTH_HEADER || 'x-admin-token',
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    viberOperatorId: process.env.VIBER_OPERATOR_ID || '',
    hermesLlmBaseUrl: process.env.HERMES_LLM_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    hermesLlmApiKey: process.env.HERMES_LLM_API_KEY || '',
    hermesLlmModel: process.env.HERMES_LLM_MODEL || 'meta/llama-3.3-70b-instruct',
    skopjePoisDb: process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db'),
    linaApiUrl: process.env.LINA_API_URL || '',
    ownerBusPollMs: num(process.env.OWNER_BUS_POLL_MS, 2000),
  };
  // All explicit overrides win over env (simFast was the only one honored
  // before — tests now override e.g. hermesToken / ownerBusPollMs too).
  Object.assign(cfg, overrides);
  if (!cfg.groqApiKey && cfg.llmProvider !== 'gemini') {
    console.warn('[config] GROQ_API_KEY missing — Groq unavailable (fallback only).');
  }
  if ((cfg.llmProvider === 'gemini' || cfg.llmProvider === 'hybrid') && !cfg.geminiApiKey) {
    console.warn('[config] GEMINI_API_KEY missing — persona will fall back to Groq.');
  }
  return cfg;
}
