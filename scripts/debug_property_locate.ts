import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { InboundHandler } from '../src/handlers/inbound';
import { ChannelRegistry } from '../src/channels/types';
import { Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { LandmarkService } from '../src/geo/landmarks';
import { detectPropertyDescription, detectService } from '../src/llm/deterministic';

class FailingLlm { async complete(): Promise<string> { throw new Error('429'); } }

const ROWS: Property[] = [
  { eb: 54, id: 54, location: 'Карпош III', price: 69500, service: 'buy' } as any,
];

const text = 'dobar den. go gledav oglasot za stan vo karpos na internet. dali go imate uste ?';
console.log('detectPropertyDescription:', detectPropertyDescription(text));
console.log('detectService:', detectService(text));

async function run() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async (_c: string, t: string) => { console.log('SENT:', t); } });
  const props = {
    async getAll() { return ROWS; },
    async getByEb(eb: number) { return ROWS.find(r => r.eb === eb); },
    async getById(id: number) { return ROWS.find(r => r.id === id); },
    async search() { return []; },
    async locations() { return ['Карпош III']; },
  } as any;
  const llm = new FailingLlm();
  const handler = new InboundHandler({ cfg, db, sessions, classifier: new Classifier(llm, cfg, props), responder: new Responder(llm, cfg), properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });

  console.log('Before:', sessions.get('zoki') ? 'EXISTS' : 'NULL');
  try { await handler.handle('test', 'zoki', text); } catch (e) { console.log('THREW:', (e as Error).message); }
  const s = sessions.get('zoki');
  console.log('After:', s ? `state=${s.state}` : 'NULL');
}

run().catch(console.error);
