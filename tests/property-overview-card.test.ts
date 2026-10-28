/**
 * THE [13:09] CAPTURE (EB 63, гарсоњера 28 м², 36.000 €):
 *
 *   [13:08] ЛИНА: Станот со Евидентен број 63 чини 36.000 евра, односно
 *           1.286 евра за м² (28 м²).
 *   [13:08] MNOGU DOBRA CENA IMA
 *   [13:09] STO MOZES DA MI KAZES ZA STANOV ?
 *   [13:09] ЛИНА: … 0% провизија, 500 денари … се согласувате со овој услов?
 *
 * The ask for the FLAT itself was read as consent. Two repairs pinned here:
 *   (1) «можеш да ми кажеш …» is a tell-me scaffold, never an agreement — the
 *       bare да-token made detectAgreement true, the closing funnel read
 *       FEE_AGREED and jumped to contact collection.
 *   (2) The ask must serve the flat's OWN info card (identity, size, price,
 *       the ad's facts) from the feed row, never a fee line. The batched form
 *       (price compliment + ask in one message) answers the same way.
 * The surroundings grammar is untouched: «што има во близина?» stays the
 * landmark lane, never a describe-ask.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { EnrichmentStore } from '../src/store/enrichment';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { detectAgreement, detectDescribeAsk } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// EB 63 as the live feed serves it.
const ROWS: Property[] = [
  {
    eb: 63, id: 63, location: 'Центар', address: 'Ул. Мите Богоевски 3',
    price: 36000, bedrooms: 1, sqm: 28, size: '28 м²', service: 'buy', floor: -1,
    lat: 41.99300, lon: 21.46800, geo_source: 'osm_building',
    features: ['греење на струја'],
    details: 'Гарсоњера во сутерен, комплетно реновирана.',
  },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
    enrichment: new EnrichmentStore(db),
  });
  const chatId = 'stanov-card';
  const s = freshSession('test', chatId);
  s.state = 'closing';
  s.slots.service = 'buy';
  s.slots.propertyId = 63;
  s.slots.interestedPropertyId = 63;
  s.slots.presentedIds = [63];
  sessions.set(s);
  return { handler, sessions, sent, chatId };
}

const FEE_OR_CONTACT_RE = /провизиј|500 ден|согласувате|име и презиме|телефонски|Контакт-телефон/iu;

test('«можеш да ми кажеш …» is a tell-me scaffold, never an agreement', () => {
  for (const ask of [
    'STO MOZES DA MI KAZES ZA STANOV ?',
    'ШТО МОЖЕШ ДА МИ КАЖЕШ ЗА СТАНОТ?',
    'Што знаеш да ми кажеш за неа?',
  ]) {
    assert.equal(detectAgreement(ask), false, `must not read as consent: ${ask}`);
  }
  // Real consent keeps its reading.
  for (const yes of ['DA SE SOGLASUVAM', 'MOZE', 'VO RED, DOBRO']) {
    assert.equal(detectAgreement(yes), true, `real agreement stays: ${yes}`);
  }
});

test('the tell-me family asks about the flat; the surroundings grammar does not', () => {
  for (const ask of [
    'STO MOZES DA MI KAZES ZA STANOV ?',
    'ШТО МОЖЕШ ДА МИ КАЖЕШ ЗА СТАНОТ?',
    'KAZI MI POVEKE ZA STANOT',
    'што можеш да ми кажеш за недвижноста',
  ]) {
    assert.equal(detectDescribeAsk(ask), true, `describe-ask expected: ${ask}`);
  }
  assert.equal(detectDescribeAsk('STO IMA VO BLIZINA NA STANOT'), false);
  assert.equal(detectDescribeAsk('ШТО ИМА ВО БЛИЗИНА?'), false);
});

test('the ask serves EB 63 own info card, not the fee/contact line', async () => {
  const { handler, sessions, sent, chatId } = makeHandler();
  await handler.handle('test', chatId, 'STO MOZES DA MI KAZES ZA STANOV ?');
  const answer = sent[sent.length - 1] ?? '';
  const s = sessions.get(chatId)!;
  assert.ok(/Евидентен број 63/.test(answer), `the card names the flat: ${answer}`);
  assert.ok(/28 м²/.test(answer), `the card carries the size: ${answer}`);
  assert.ok(/36\.000 евра/.test(answer), `the card carries the price: ${answer}`);
  assert.ok(/реновирана/.test(answer), `the card carries the ad's facts: ${answer}`);
  assert.ok(!FEE_OR_CONTACT_RE.test(answer), `never fee/consent/contact traffic: ${answer}`);
  assert.notEqual(s.state, 'contact_collection', 'the ask never jumps the fee funnel');
});

test('the batched compliment + ask still serves the card', async () => {
  const { handler, sent, chatId } = makeHandler();
  await handler.handle('test', chatId, 'MNOGU DOBRA CENA IMA\nSTO MOZES DA MI KAZES ZA STANOV ?');
  const answer = sent[sent.length - 1] ?? '';
  assert.ok(/Евидентен број 63/.test(answer), `the card answers the batched ask: ${answer}`);
  assert.ok(!FEE_OR_CONTACT_RE.test(answer), `never fee/consent/contact traffic: ${answer}`);
});
