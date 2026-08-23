import { InboundHandler } from '../src/handlers/inbound';
import { Db } from '../src/store/db';
import { SessionStore } from '../src/store/sessions';
import { loadConfig } from '../src/config';
import { ChannelRegistry } from '../src/channels/registry';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { buildLlm } from '../src/llm/factory';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';

async function main() {
  const cfg = loadConfig();
  const db = new Db('data/tui.db');
  const sessions = new SessionStore(db);
  const properties = new PropertyService(db);
  const llm = buildLlm(cfg, properties);
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'tui', send: async (c: string, t: string) => { sent.push(t); console.log('TUI SEND:', t.substring(0, 120)); } });
  const offlineMap = new OfflineMapStore(cfg.skopjePoisDb);
  const landmarks = new LandmarkService(db, { offlineMap });
  const handler = new InboundHandler({
    cfg, db, sessions, classifier, responder, properties, channels,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    landmarks,
    enrichment: undefined,
  });
  console.log('Handler created OK');

  const msgs = ['zdravo', 'sakam da iznajmam dukjan'];
  for (const m of msgs) {
    console.log(`\n--- Sending: "${m}" ---`);
    try {
      await handler.handle('tui', 'sim-stuck', m);
      console.log(`OK - state: ${sessions.get('sim-stuck')?.state}`);
      console.log(`Sent count: ${sent.length}`);
    } catch (e) {
      console.error('CRASH:', (e as Error).message);
      console.error('Stack:', (e as Error).stack?.substring(0, 500));
    }
  }
  db.close();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
