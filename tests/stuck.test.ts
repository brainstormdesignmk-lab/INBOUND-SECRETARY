import { test } from 'node:test';
import assert from 'node:assert';
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
  get healthy(): boolean { return true; } // the real getAll sets this.ok — the fake never runs it
}

// GORAN's session: buy, Кисела Вода, 60.000 € budget. Карпош's only apartment
// (EB 54) is OVER budget; EB 48 in Карпош is a rental.
const ROWS: Property[] = [
  { eb: 80, id: 80, location: 'Кисела Вода', price: 46000, service: 'buy' },
  { eb: 46, id: 46, location: 'Кисела Вода', price: 72300, service: 'buy' },
  { eb: 53, id: 53, location: 'Аеродром', price: 55000, service: 'buy' },
  { eb: 55, id: 55, location: 'Влае', price: 40000, service: 'buy' },
  { eb: 54, id: 54, location: 'Карпош III', price: 69500, service: 'buy' },
  { eb: 63, id: 63, location: 'Центар', price: 36000, service: 'buy' },
  { eb: 48, id: 48, location: 'Карпош III', price: 250, service: 'rent' },
  { eb: 56, id: 56, location: undefined, price: 500, service: 'rent', business: true, sqm: 40 },
  { eb: 59, id: 59, location: 'Центар', price: 950, service: 'rent', business: true, sqm: 105 },
];

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels });
  return { handler, sessions, sent };
}

test('stuck loop: an area switch re-targets the search, agreement registers criteria', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'goran';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // 1) search Кисела Вода up to 60.000 € -> only EB 80 fits
  let s = await send('MI TREBA MALO STANCE VO KISELA VODA, DO 60.000 EVRA');
  assert.equal(s.state, 'presentation');
  assert.ok(sent[0].includes('Евидентен број 80'), sent[0]);

  // 2) rejection -> spill to other areas (legitimate; closest to the 60k budget first)
  await send('NE MI SE DOPAGA, DRUGI OPCII');
  assert.ok(sent[1].includes('Евидентен број 53'), sent[1]);

  // 3) "STO IMAS VO KARPOS?" -> location must RE-TARGET to Карпош (was the bug),
  //    and since nothing in Карпош fits the 60k budget -> honest NO_MATCH, NOT a
  //    silent Маџари-style spill.
  s = await send('STO IMAS VO KARPOS ?');
  assert.equal(s.slots.location, 'Карпош III');
  assert.ok(sent[2].includes('немам слободни имоти во Карпош III'), sent[2]);
  assert.ok(!sent[2].includes('Евидентен број'), sent[2]);

  // 4) rejection of the spill -> keep going until EVERYTHING is shown
  await send('NE MI SE DOPAGA');
  assert.ok(sent[3].includes('Евидентен број 63'), sent[3]);

  // 5) now truly exhausted -> the honest exhausted line, ONCE
  s = await send('NE MI SE DOPAGA');
  assert.ok(sent[4].includes('Ги исцрпивме'), sent[4]);

  // 6) agreement on the exhausted offer -> contact collection, NOT the same line
  s = await send('DOBRO');
  assert.equal(s.state, 'contact_collection');
  assert.ok(sent[5].includes('име и телефонски број'), sent[5]);
  assert.ok(!sent[5].includes('Ги исцрпивме'), sent[5]);

  // 7) name + phone (LLM down) -> criteria registered (queued), confirm sent
  s = await send('ZORAN 078/914 196');
  assert.equal(s.state, 'queued');
  assert.ok(s.slots.name === 'Zoran' || s.slots.name === 'Зоран', JSON.stringify(s.slots));
  assert.equal(s.slots.phone, '078914196');
  assert.ok(sent[6].includes('забележани'), sent[6]);
});

test('business: деловен простор never asks bedrooms — location/sqm/price, then presentation', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'biz';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  let s = await send('ZDRAVO, SAKAM DA IZNAJMAM DELOVEN PROSTOR VO KARPOS');
  assert.equal(s.slots.business, true);
  assert.equal(s.slots.service, 'rent');
  assert.equal(s.state, 'discovery');
  assert.ok(sent[0].includes('Која површина (во м²) ја барате?'), sent[0]);
  assert.ok(sent[0].includes('До која цена го барате?'), sent[0]);
  assert.ok(!sent[0].includes('спални'), sent[0]);

  // sqm + price -> complete -> presentation with REAL business offers
  s = await send('40 KVADRATI, DO 500 EVRA');
  assert.equal(s.state, 'presentation');
  assert.ok(sent[1].includes('Деловниот простор под Евидентен број 56'), sent[1]);
});

test('stuck loop: the exhausted line never repeats for contact requests', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'goran2';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
  // search + reject until every option is shown (exhausted line fires ONCE legitimately)
  await send('MI TREBA MALO STANCE VO KISELA VODA, DO 60.000 EVRA');
  await send('NE MI SE DOPAGA');
  await send('NE MI SE DOPAGA');
  let s = await send('NE MI SE DOPAGA');
  assert.ok(sent[3].includes('Ги исцрпивме'), sent[3]); // honest exhausted line, once
  // contact intent must then move forward — never repeat the exhausted line
  s = await send('KONTAKTIRAJ ME');
  assert.equal(s.state, 'contact_collection');
  assert.ok(sent[4].includes('име и телефонски број'), sent[4]);
  assert.ok(!sent[4].includes('Ги исцрпивме'), sent[4]);
});
