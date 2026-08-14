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
  { eb: 78, id: 78, location: 'Капиштец', price: 185000, service: 'buy', bedrooms: 3, size: '82 м²', address: 'Народен Фронт' },
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

test('ZOKI: visit interest ("дали е достапен?") -> fee disclosed -> agreement -> owner ping-pong — never a phone ask before the fee', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'zoki';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // 1) "ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78" -> property_query, property shown
  let s = await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  assert.equal(s.state, 'property_query');
  assert.ok(sent[0].includes('Евидентен број 78'), sent[0]);

  // 2) "DALI E SEUSTE DOSTAPEN ?" -> INTERESTED (visit interest), NOT owner contact.
  //    Lina must disclose the FEE first — never "морам да го контактирам сопственикот".
  s = await send('DALI E SEUSTE DOSTAPEN ?');
  assert.equal(s.state, 'closing');
  assert.ok(sent[1].includes('600 денари'), sent[1]); // buy fee disclosed
  assert.ok(!sent[1].includes('телефонски'), sent[1]); // no phone ask before agreement
  assert.ok(!sent[1].includes('контактирам'), sent[1]);

  // 3) "DA, SE SOGLASUVAM" -> FEE_AGREED -> contact_collection (name+phone now)
  s = await send('DA, SE SOGLASUVAM');
  assert.equal(s.state, 'contact_collection');
  assert.ok(sent[2].includes('име'), sent[2]);

  // 4) name + phone -> visit_scheduling -> preferred time question
  s = await send('ZORAN 078/914 196');
  assert.equal(s.state, 'visit_scheduling');
  assert.ok(sent[3].includes('Кој термин'), sent[3]);

  // 5) proposed time -> owner_checking (the owner ping-pong starts)
  s = await send('UTRE POPLADNE POSLE 6');
  assert.equal(s.state, 'owner_checking');
  assert.ok(s.slots.visitTime?.includes('UTRE'), JSON.stringify(s.slots));
  assert.ok(sent[4].includes('потврдам'), sent[4]); // OWNER_CHECK_ACK
});

test('ZOKI: "кога може да се погледне" is visit interest too — same fee funnel', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'zoki2';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  const s = await send('KOGA BI MOZELO DA SE POGLEDNE STANOT ?');
  assert.equal(s.state, 'closing');
  assert.ok(sent[1].includes('600 денари'), sent[1]);
  assert.ok(!sent[1].includes('телефонски'), sent[1]);
});

test('owner counter-offer: accept/reject the owner time works with every LLM down', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'bob';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // reach owner_checking (interest -> fee -> agree -> contact -> time)
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA, SE SOGLASUVAM');
  await send('ZORAN 078/914 196');
  let s = await send('UTRE POPLADNE POSLE 6');
  assert.equal(s.state, 'owner_checking');

  // owner counter-proposes a different time -> time_confirm
  const agent = handler.ownerAgent as unknown as {
    simulate?: (chatId: string, eb: number, action: 'ok' | 'sold' | 'rented' | 'counter', ownerTime?: string) => boolean;
  };
  assert.ok(agent.simulate?.(chatId, 78, 'counter', 'петок во 17:00'));
  await new Promise(r => setTimeout(r, 50)); // let the enqueued verdict land
  s = sessions.get(chatId)!;
  assert.equal(s.state, 'time_confirm');
  assert.ok(sent[5].includes('петок во 17:00'), sent[5]);

  // accept the counter-time -> pending (confirmed appointment), LLM down
  s = await send('VO RED, TOA VREME E DOBRO');
  assert.equal(s.state, 'pending');
  assert.ok(sent[6].includes('Договорена посета'), sent[6]);
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
