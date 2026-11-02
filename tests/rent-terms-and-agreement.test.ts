// THE [20:40] TUI CAPTURE — two turns from the same closing:
//
//   [КЛИЕНТ] KOI VI SE USLOVITE ZA IZNAJMUVANJE ?
//   [ЛИНА]   Мило ми е за Вашиот избор. Прво морам да Ве информирам за
//            правилото … 300 денари (5 евра) …                              ✗
//            (he asked for the RENT TERMS — commission tier, owner's first
//             rent + deposit, one-year minimum — which we already have)
//
//   [КЛИЕНТ] DA
//   [ЛИНА]   Драго ми е за Вашиот интерес. Прво би сакала да Ве известам за
//            нашата политика … 300 денари (5 евра) …                        ✗
//            (the same fee script AGAIN instead of taking the agreement)
//
// Both are pinned here. The rent-terms answer already exists as
// provision.ask.rent / buildProvisionAsk('rent'); it needs a REROUTE. The
// agreement must open contact collection on the FIRST «да».
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
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { setLearnedBank } from '../src/data/responseBank';

setLearnedBank({
  variants: () => [], addVariant: () => false, addExample: () => false,
  metric: () => {}, retrieve: () => undefined,
} as any);

const cfg = loadConfig();
let offlineMap: OfflineMapStore | undefined;
const map = (): OfflineMapStore => (offlineMap ??= new OfflineMapStore(cfg.skopjePoisDb));

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// EB 50 from the capture: кућа, 74 м², 250 евра месечно, Центар.
const HOUSE50: Property = {
  eb: 50, id: 50, uuid: 'eb50-capture', address: 'РУЗВЕЛТОВА', location: 'Центар',
  lat: 41.9972, lon: 21.4268, geo_source: 'google_cached',
  service: 'rent', price: 250, house: true, sqm: 74, size: '74 м²',
  features: ['двор', 'тераса'], details: 'Се издава куќа',
} as Property;

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps([HOUSE50]);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(llm, cfg, props),
    responder: new Responder(llm, cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: map() }),
  });
  return { handler, sessions, sent };
}

/** The capture's state: closing on EB 50, rent, the fee asked once already.
 *  `feeAsked` marks the DISCLOSURE turn the way the handler does — the
 *  fee.ask serve sets slots.feeDisclosed (see the central hook at the end of
 *  handle()), so the next «да» knows what it is agreeing to. */
function seed(sessions: SessionStore, chatId: string, feeAsked = true): void {
  const s = freshSession('test', chatId);
  s.state = 'closing';
  s.slots = {
    service: 'rent', propertyId: 50, interestedPropertyId: 50,
    presentedIds: [50], location: 'Центар',
  };
  s.history = [
    { role: 'user', text: 'KUKJATA BESE MISLAM SO BROJ 50' },
    { role: 'assistant', text: 'Недвижноста е сè уште активна во нашата база на податоци. Би сакале ли да го исконтактирам сопственикот за да ги проверам точната цена и достапноста за Вас?' },
    { role: 'user', text: 'STO MOZES DA MI KAZES ZA NEA ?' },
    { role: 'assistant', text: 'Куќата под Евидентен број 50 е во Центар. Има 74 м² станбена површина. Цената е 250 евра месечно.' },
  ];
  if (feeAsked) {
    s.history.push({ role: 'assistant', text: 'Мило ми е за Вашиот избор. Прво морам да Ве информирам за правилото на агенцијата Метрополис според кое за разгледување на недвижност се наплаќаат симболични 300 денари (5 евра). Дали се согласувате со овој услов за да можам да го исконтактирам сопственикот?' });
    s.slots.feeDisclosed = true;
    s.slots.ownerContactPending = true;
  }
  sessions.set(s);
}

const FEE300 = /300\s*денари|5 евра/iu;
const RENT_TERMS = {
  fifty: /50\s*%/u,
  threshold: /1\.000/u,
  deposit: /депозит/iu,
  year: /една година|минималн\w* престој|закуп/iu,
};

test('“KOI VI SE USLOVITE ZA IZNAJMUVANJE?” gets the RENT TERMS, not the viewing fee', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'rent-terms';
  seed(sessions, chatId, false);

  await handler.handle('test', chatId, 'KOI VI SE USLOVITE ZA IZNAJMUVANJE ?');
  const reply = sent.at(-1) ?? '';
  console.log('RENT-TERMS REPLY:', reply);
  console.log('SLOTS:', JSON.stringify(sessions.get(chatId)?.slots));
  assert.match(reply, RENT_TERMS.fifty, `the 50% tier must be stated: ${reply}`);
  assert.match(reply, RENT_TERMS.threshold, `the 1.000 € threshold: ${reply}`);
  assert.match(reply, RENT_TERMS.deposit, `the owner's first rent + deposit: ${reply}`);
  assert.match(reply, RENT_TERMS.year, `the one-year minimum: ${reply}`);
  assert.doesNotMatch(reply, FEE300, `the viewing fee is NOT the answer: ${reply}`);
});

test('the FIRST “da” after the fee ask is the agreement (contact collection, no repeat)', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'first-da';
  seed(sessions, chatId, true);

  await handler.handle('test', chatId, 'DA');
  const reply = sent.at(-1) ?? '';
  console.log('FIRST-DA REPLY:', reply);
  console.log('SLOTS:', JSON.stringify(sessions.get(chatId)?.slots));
  assert.doesNotMatch(reply, FEE300, `the fee must not be disclosed a second time: ${reply}`);
  assert.match(reply, /име|телефон|презиме/iu, `contact collection must open: ${reply}`);
  assert.equal(sessions.get(chatId)?.slots.viewingFeeAgreed, true, 'the agreement is recorded');

  // A second bare "да" must not re-run the fee either.
  await handler.handle('test', chatId, 'DA');
  const second = sent.at(-1) ?? '';
  assert.doesNotMatch(second, FEE300, `still no third fee script: ${second}`);
});

// THE END-TO-END ORDER, with the disclosure made by the RUNNING handler (not
// seeded): visit interest → the fee is told ONCE and remembered → «да» → the
// contact ask. This is the loop the capture broke.
test('the disclosed fee is remembered, so one “da” is enough (visit interest → da)', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'fee-loop';
  const s = freshSession('test', chatId);
  s.state = 'presentation';
  s.slots = { service: 'rent', propertyId: 50, interestedPropertyId: 50, presentedIds: [50], location: 'Центар' };
  sessions.set(s);

  await handler.handle('test', chatId, 'SAKAM DA JA VIDAM KUKJATA');
  const disclosed = sent.at(-1) ?? '';
  assert.match(disclosed, FEE300, `the fee is disclosed on visit interest: ${disclosed}`);
  assert.equal(sessions.get(chatId)?.slots.feeDisclosed, true, 'the disclosure is remembered');

  await handler.handle('test', chatId, 'DA');
  const agreed = sent.at(-1) ?? '';
  console.log('AGREED REPLY:', agreed);
  assert.doesNotMatch(agreed, FEE300, `the fee is not told twice: ${agreed}`);
  assert.match(agreed, /име|телефон|презиме/iu, `contact collection opens on the first yes: ${agreed}`);
  assert.equal(sessions.get(chatId)?.slots.viewingFeeAgreed, true);
});
