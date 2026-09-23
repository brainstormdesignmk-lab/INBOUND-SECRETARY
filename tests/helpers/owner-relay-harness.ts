/**
 * Shared harness for the owner-relay e2e tests: a handler wired with a REAL
 * EnrichmentStore over an in-memory DB (the judge reads the same
 * enrichment_queue shape the production handler writes) plus typed accessors
 * for the owner-exchange log rows.
 */
import { loadConfig } from '../../src/config';
import { Db } from '../../src/store/db';
import { SessionStore } from '../../src/fsm/session';
import { Classifier } from '../../src/llm/classify';
import { Responder } from '../../src/llm/respond';
import { PropertyService, Property } from '../../src/data/properties';
import { AppointmentStore } from '../../src/store/appointments';
import { EscalationStore } from '../../src/store/escalations';
import { MetaStore } from '../../src/store/meta';
import { EnrichmentStore } from '../../src/store/enrichment';
import { ChannelRegistry } from '../../src/channels/types';
import { InboundHandler } from '../../src/handlers/inbound';
import { LlmClient } from '../../src/llm/types';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 78, id: 78, location: 'Центар', price: 36000, service: 'buy', sqm: 74, size: '74 м²', address: 'Партизерска 10', lat: 41.996, lon: 21.428, geo_source: 'stored' } as Property,
];

export interface OwnerLogRow {
  id: number;
  eventType: string;
  userMsg: string;
  replyText: string;
  bankKey: string | null;
}

export async function makeOwnerRelayTestHarness() {
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const enrichment = new EnrichmentStore(db);
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels, landmarks: undefined, enrichment,
  });
  const send = async (m: string) => { await handler.handle('test', 'relay', m); return sessions.get('relay')!; };
  const ownerLogRows = (): OwnerLogRow[] =>
    (db.db.prepare(`SELECT id, event_type AS eventType, user_msg AS userMsg, reply_text AS replyText, bank_key AS bankKey
                    FROM enrichment_queue WHERE event_type IN ('OWNER_ASK','OWNER_RELAY','VISIT_CONFIRMED') ORDER BY id`).all() as any[])
      .map(r => ({ ...r, bankKey: r.bankKey ?? null }));
  return { handler, sessions, sent, send, enrichment, ownerLogRows, db };
}

// Reusable setup: interest → fee → agree → contact → proposed time → owner_checking
export async function reachOwnerChecking(send: (m: string) => Promise<any>): Promise<void> {
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA'); // confirm owner contact
  await send('DA, SE SOGLASUVAM'); // fee agree
  await send('ZORAN 078/914 196'); // contact
  const s = await send('UTRE POPLADNE POSLE 6'); // proposed time → owner_checking
  assertOwnerChecking(s);
}

import assert from 'node:assert/strict';
function assertOwnerChecking(s: any): void {
  assert.equal(s.state, 'owner_checking', `setup failed: ${s.state}`);
}
