import express from 'express';
import { loadConfig } from './config';
import { Db } from './store/db';
import { SessionStore, ChatSession, isExpired, resetToIdle } from './fsm/session';
import { AppointmentStore } from './store/appointments';
import { EscalationStore } from './store/escalations';
import { MetaStore } from './store/meta';
import { PropertyService } from './data/properties';
import { createLlm } from './llm/factory';
import { Classifier } from './llm/classify';
import { Responder } from './llm/respond';
import { InboundHandler } from './handlers/inbound';
import { ChannelRegistry } from './channels/types';
import { ViberAdapter } from './channels/viber';
import { TelegramAdapter } from './channels/telegram';
import { WhatsAppAdapter } from './channels/whatsapp';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = new Db(cfg.dbPath);

  const sessions = new SessionStore(db);
  const appointments = new AppointmentStore(db);
  const escalations = new EscalationStore(db);
  const meta = new MetaStore(db);
  const properties = new PropertyService(cfg.propertyDataUrl);

  const llm = createLlm(cfg);
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);

  const channels = new ChannelRegistry();
  const pipeline = new InboundHandler({
    cfg, db, sessions, classifier, responder, properties, appointments, escalations, meta, channels,
  });

  const viber = new ViberAdapter(cfg, pipeline);
  channels.register(viber);
  channels.register(new TelegramAdapter(cfg));
  channels.register(new WhatsAppAdapter(cfg));

  const app = express();
  app.use(express.json({ limit: '32kb' })); // Viber caps request JSON at 30KB
  viber.registerWebhook(app);

  app.listen(cfg.port, () => {
    console.log(`[boot] Lina online on :${cfg.port}`);
    const geminiKeys = [cfg.geminiApiKey, cfg.geminiApiKey2, cfg.geminiApiKey3].filter(Boolean).length;
    console.log(`[boot] llmProvider=${cfg.llmProvider} gemini=${cfg.geminiModel} (${geminiKeys} key${geminiKeys === 1 ? '' : 's'}) groq=${cfg.groqModel} classify=${cfg.groqModelClassify} personaTemp=${cfg.personaTemp}`);
    console.log(`[boot] ownerAgent=${cfg.ownerAgentMode} agentPhone=${cfg.agentDefaultPhone}`);
    if (!cfg.viberToken) console.warn('[boot] VIBER_TOKEN not set — webhook will reject all callbacks');
    if (!cfg.viberWebhookUrl) console.warn('[boot] VIBER_WEBHOOK_URL not set — run "npm run webhook:set" after configuring');
  });

  // Idle-session sweeper: expired chats reset to a fresh greeting (prototype resetSession).
  const sweeper = setInterval(() => {
    const rows = db.db.prepare('SELECT data FROM sessions').all() as { data: string }[];
    let changed = 0;
    for (const r of rows) {
      const s = JSON.parse(r.data) as ChatSession;
      if (!isExpired(s, cfg.chatTtlMinutes)) continue;
      if (s.history.length === 0) {
        sessions.delete(s.chatId);
        changed++;
        continue;
      }
      resetToIdle(s);
      sessions.set(s);
      changed++;
    }
    if (changed) console.log(`[sweep] reset ${changed} expired session(s)`);
  }, 60_000);
  sweeper.unref();

  const shutdown = (sig: string): void => {
    console.log(`[shutdown] ${sig} — closing`);
    clearInterval(sweeper);
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(e => {
  console.error('[boot] fatal:', e);
  process.exit(1);
});
