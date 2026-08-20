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
import { LandmarkService } from './geo/landmarks';
import { OfflineMapStore } from './geo/offlineMap';
import { VisitScheduler } from './visits/scheduler';
import { EventStore } from './store/events';
import { OwnerStore } from './store/owners';
import { EnrichmentStore } from './store/enrichment';
import { registerHermesApi } from './hermes/api';

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
  // Shared stores for the visit protocol + landmark resolver (thin stateless
  // wrappers over the same db the pipeline uses).
  const events = new EventStore(db);
  const owners = new OwnerStore(db);

  // Approximate locations (address privacy): deterministic table -> offline
  // map (local POIs, zero network) -> Google (if key) -> OSM -> Hermes event.
  // Cached in the DB, so live lookups happen once per address ever.
  const offlineMap = new OfflineMapStore(cfg.skopjePoisDb);
  if (offlineMap.available) {
    const s = offlineMap.stats();
    console.log(`[offline-map] ${s?.pois ?? 0} POIs / ${s?.addresses ?? 0} addresses — ${cfg.skopjePoisDb}`);
  }
  const landmarks = new LandmarkService(db, {
    googleKey: cfg.googleMapsApiKey,
    offlineMap,
    onHermesRequest: ({ address, location }) => {
      // Phase 2: Hermes (its own LLM via NVIDIA) answers landmark_result.
      events.insert('landmark_requested', '', null, { address: address ?? null, location: location ?? null });
    },
  });

  // The visit protocol: turns 2+3 (morning confirmation, exact location 2h
  // before) fired by the tick; turn 1 (arranged) is inline in confirmVisit.
  const visits = new VisitScheduler({
    db,
    events,
    owners,
    properties,
    notifyClient: (chatId, text) => channels.send('viber', chatId, text),
    notifyOwner: (_clientChatId, eb, text) => {
      const phone = owners.get(eb)?.phone;
      return phone ? channels.send('viber', phone, text) : Promise.reject(new Error(`no owner phone for EB ${eb}`));
    },
    notifyOperator: async (text) => {
      events.insert('operator_log', '', null, { text });
      console.log(text);
      if (cfg.viberOperatorId) {
        await channels.send('viber', cfg.viberOperatorId, text);
      }
    },
  });

  const enrichment = new EnrichmentStore(db);
  const pipeline = new InboundHandler({
    cfg, db, sessions, classifier, responder, properties, appointments, escalations, meta, channels,
    landmarks, visits, enrichment,
  });

  const visitTimer = visits.start(60_000);

  const viber = new ViberAdapter(cfg, pipeline);
  channels.register(viber);
  channels.register(new TelegramAdapter(cfg));
  channels.register(new WhatsAppAdapter(cfg));

  const app = express();
  app.use(express.json({ limit: '32kb' })); // Viber caps request JSON at 30KB
  viber.registerWebhook(app);

  // The two-machine bridge: Hermes (its own box) talks to Lina through this
  // token-guarded surface — work queue + results. Disabled (503) without HERMES_TOKEN.
  registerHermesApi(app, { cfg, db, pipeline, properties });

  app.listen(cfg.port, () => {
    console.log(`[boot] Lina online on :${cfg.port}`);
    const geminiKeys = [cfg.geminiApiKey, cfg.geminiApiKey2, cfg.geminiApiKey3].filter(Boolean).length;
    console.log(`[boot] llmProvider=${cfg.llmProvider} gemini=${cfg.geminiModel} (${geminiKeys} key${geminiKeys === 1 ? '' : 's'}) groq=${cfg.groqModel} classify=${cfg.groqModelClassify} personaTemp=${cfg.personaTemp}`);
    console.log(`[boot] ownerAgent=${cfg.ownerAgentMode} agentPhone=${cfg.agentDefaultPhone}`);
    console.log(`[boot] landmarks=${landmarks ? 'on' : 'off'} (google=${cfg.googleMapsApiKey ? 'key' : 'no-key'}) visits=on`);
    console.log(`[boot] hermesApi=${cfg.hermesToken ? 'on (HERMES_TOKEN)' : 'DISABLED — set HERMES_TOKEN'}`);
    if (cfg.viberOperatorId) console.log(`[boot] operator log → Viber ${cfg.viberOperatorId}`);
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
    clearInterval(visitTimer);
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
