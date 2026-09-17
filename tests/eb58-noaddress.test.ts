// The NO-ADDRESS protocol (EB 58 class, 2026-09-12).
//
// EB 58 is a manual CRM entry whose address is literally "НЕПОЗНАТА" — the
// agency never learned the street. Before this fix, "kade se naogja?" on
// such a row made Lina INVENT geography: the mapper fell back to the title
// (a landmark name), landmark resolution anchored on an address that means
// nothing, and the client got "во близина на X" + a maps link for a place
// nobody verified. The honest answer is the approved protocol line: the
// location isn't known right now, the owner will be contacted, pivot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  // The EB 58 row as the CRM actually carries it.
  { eb: 58, id: 58, location: 'Центар (населба)', price: 1200, service: 'rent',
    business: true, sqm: undefined, size: undefined,
    address: 'НЕПОЗНАТА', lat: 42.022, lon: 21.4368, geo_source: 'google_cached' },
  // A control row WITH an address — must still serve normal landmarks.
  { eb: 63, id: 63, location: 'Центар', price: 36000, service: 'buy',
    sqm: 28, size: '28 м²', address: 'Црногорска 1', lat: 41.996, lon: 21.428, geo_source: 'stored' },
];

test('isAddressUnknown classifies the known non-answer shapes', async () => {
  const { isAddressUnknown } = await import('../src/data/properties');
  const mk = (over: Partial<Property>): Property => ({ eb: 1, id: 1, address: 'x', ...over } as Property);
  assert.equal(isAddressUnknown(mk({ address: 'НЕПОЗНАТА', eb: 58 })), true, 'Cyrillic literal');
  assert.equal(isAddressUnknown(mk({ address: 'Nepoznata', eb: 12 })), true, 'Latin literal');
  assert.equal(isAddressUnknown(mk({ address: '', eb: 7 })), true, 'empty');
  assert.equal(isAddressUnknown(mk({ address: 'Имот ЕБ 99', eb: 99 })), true, 'placeholder');
  assert.equal(isAddressUnknown(mk({ address: 'Ѓуро Стругар', eb: 57 })), false, 'real street');
  // Keyboard mash is NOT "unknown" — it is upstream garbage to delete (EB 39).
  assert.equal(isAddressUnknown(mk({ address: 'Фгхфгхфгхфгх', eb: 39 })), false, 'mash is not unknown');
});

test('EB 58 e2e: "kade se naogja?" serves the honest no-location protocol, never invented geography', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels, landmarks: undefined,
  });
  const chatId = 'eb58-e2e';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // View EB 58 by its number (sets propertyId), then ask where it is.
  await send('me interesira 58');
  await send('kade se naogja?');
  const answer = sent[sent.length - 1] ?? '';
  // The honest protocol: location unknown + owner contact + pivot. EB filled.
  assert.match(answer, /позната|немам податок|немам потврдена локација|не ми е јасна|не е внесена|не располагам/i, `honest location line expected: ${answer}`);
  assert.match(answer, /сопственик/i, `owner-contact promise expected: ${answer}`);
  assert.match(answer, /58/, `EB must be filled into the template: ${answer}`);
  // NEVER invented geography or a maps link:
  assert.ok(!/во близина на/iu.test(answer), `no landmark claim allowed: ${answer}`);
  assert.ok(!/maps\.google|google\.com/i.test(answer), `no maps link allowed: ${answer}`);
});

test('control row with a real address still serves the normal landmark path', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels, landmarks: undefined,
  });
  const chatId = 'eb63-control';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('stan do 40000 evra');
  await send('kade se naogja 63?');
  const answer = sent[sent.length - 1] ?? '';
  // The control must NOT hit the no-address protocol — no honest-line false positive.
  assert.ok(!/не ми е позната/iu.test(answer), `control must not hit no-address protocol: ${answer}`);
});
