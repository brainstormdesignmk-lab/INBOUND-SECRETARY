/**
 * «МОМЕНТАЛНО ВО СИСТЕМОТ НЕМА …» — FOR EVERY CATEGORY, NOT JUST THE PAIR.
 *
 * The owner's rule (the [03:45] capture): when she STARTS a serve and the wanted
 * characteristic has nothing in stock, she says the category, its own price and
 * the area — «Моментално во системот нема двособни до 120.000 евра во
 * Аеродром» — instead of the older generic «немам недвижност што одговара на
 * Вашите критериуми». The pair contract ([03:42]) implemented that wording for
 * the per-category room tiers only; a plain single-category miss (куќа, плац,
 * деловен простор, гарсоњера, or one room count) still answered with the
 * generic bank line. These tests pin the whole family:
 *
 *   • стан by room tier   → «нема двособни до 120.000 евра во Центар»
 *   • куќа (rent)         → «нема куќи до 500 евра месечно во Влае»
 *   • плац                → «нема плацеви од 300 м² до 30.000 евра во Карпош»
 *   • деловен простор     → «нема деловни простори од 50 м² до 500 евра
 *                            месечно во Центар»
 *   • гарсоњера city-wide → «нема гарсоњери до 300 евра месечно» (no area, no
 *                            other-neighbourhood exit — he never pinned one)
 *   • and the OTHER truth: a tier whose cards WERE shown keeps the drained
 *     family («ги исцрпивме …»), never «нема во системот».
 *
 * The sentence names ONLY what the client stated: category, size, money, area —
 * every figure comes from the slots, never from the handler.
 */
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
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

function makeHandler(rows: Property[], id: string) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent[sent.length - 1] ?? '';
  };
  return { say, sessions, chatId: id, sent };
}

// A feed that holds NONE of the categories asked for below: every miss is a
// genuine gap in the system, not a budget or distance story.
const OTHER_STOCK: Property[] = [
  { eb: 301, id: 301, location: 'Аеродром', address: 'Ул. А 1', price: 90000, bedrooms: 3, sqm: 70, size: '70 м²', service: 'buy' },
];

test('стан by room tier: the miss names двособни and ITS cap', async () => {
  const { say } = makeHandler(OTHER_STOCK, 'nostock-flat');
  await say('SAKAM DA KUPAM STAN VO CENTAR');
  await say('DVOSOBEN');
  const reply = await say('DO 120000');
  assert.match(reply, /Моментално во системот нема двособни до 120\.000 евра во Центар\./u,
    `the tier, its own cap and the area are named: ${reply}`);
  // The exits: he pinned an area AND gave money, so both pivots stand.
  assert.match(reply, /друга населба/u, `another-neighbourhood exit: ${reply}`);
  assert.match(reply, /прошириме цената/u, `widen-the-price exit: ${reply}`);
  assert.match(reply, /забележам/u, `the lead is never dropped: ${reply}`);
});

test('куќа: the miss names the type and the MONTHLY cap', async () => {
  const { say } = makeHandler(OTHER_STOCK, 'nostock-house');
  await say('SAKAM DA IZNAJMAM KUKJA VO VLAE');
  // The house funnel asks its own questions (спални, then цена) — answer them
  // before the miss can be claimed.
  await say('DVE SPALNI');
  const reply = await say('DO 500 EVRA');
  // The house's own room count scopes the absence («со две спални»): the
  // sentence must not claim there is no house at all under the cap when the
  // client's room criterion is what emptied the pool.
  assert.match(reply, /Моментално во системот нема куќи со две спални до 500 евра месечно во Влае\./u,
    `house, its rooms, rent unit, area: ${reply}`);
});

test('плац: the miss names the plot, its м² and its cap', async () => {
  const { say } = makeHandler(OTHER_STOCK, 'nostock-plac');
  await say('SAKAM DA KUPAM PLAC VO KARPOS');
  await say('300 KVADRATI');
  const reply = await say('DO 30000');
  // The feed's own name for the area ("Карпош III") is what the client's
  // «во Карпош» resolves to — the sentence names the resolved area, not a
  // parenthetical and not a district the client never asked about.
  assert.match(reply, /Моментално во системот нема плацеви од 300 м² до 30\.000 евра во Карпош(?: III)?\./u,
    `plot, size, cap, area: ${reply}`);
});

test('деловен простор: the miss names the category, м² and the monthly cap', async () => {
  const { say } = makeHandler(OTHER_STOCK, 'nostock-biz');
  await say('SAKAM DA IZNAJMAM DELOVEN PROSTOR VO CENTAR');
  await say('50 KVADRATI');
  const reply = await say('DO 500 EVRA');
  assert.match(reply, /Моментално во системот нема деловни простори од 50 м² до 500 евра месечно во Центар\./u,
    `commercial space, size, rent, area: ${reply}`);
});

test('гарсоњера city-wide: no invented area, and no other-neighbourhood exit', async () => {
  const { say } = makeHandler(OTHER_STOCK, 'nostock-garsonjera');
  const reply = await say('BILO KADE GARSONJERA ZA IZNAJMUVANJE DO 300 EVRA');
  assert.match(reply, /Моментално во системот нема гарсоњери до 300 евра месечно/u,
    `the studio category is named: ${reply}`);
  // He released the area: offering "another neighbourhood" would re-open a
  // criterion he explicitly waived.
  assert.doesNotMatch(reply, /друга населба/u, `no area pivot for a city-wide ask: ${reply}`);
  assert.match(reply, /прошириме цената/u, `the money pivot still stands: ${reply}`);
});

test('the OTHER truth: a shown tier keeps the drained family, a NEVER-shown one is named', async () => {
  // The notebook is PER TIER and per geography: one двособен in Центар is on
  // the table. «Уште?» about THAT tier is «he saw them and they ran out» — the
  // drained family, never «нема во системот». But a tier this geography has
  // never served (трособни) IS a gap in the system, and must be named as such
  // even though another tier of the same search was served a message earlier.
  const rows: Property[] = [
    { eb: 302, id: 302, location: 'Центар', address: 'Ул. Б 2', price: 100000, bedrooms: 2, sqm: 55, size: '55 м²', service: 'buy' },
  ];
  const { say } = makeHandler(rows, 'nostock-drained');
  await say('SAKAM DA KUPAM STAN VO CENTAR');
  await say('DVOSOBEN');
  const served = await say('DO 120000');
  assert.match(served, /Евидентен број 302/u, `the tier's one card is served first: ${served}`);

  // Contract, not a wording pin (bank variants rotate): the shown tier is
  // never declared absent from the SYSTEM, and the turn still offers a way out
  // (something pricier in the same area, or the same money elsewhere).
  const drained = await say('USTE?');
  assert.doesNotMatch(drained, /Моментално во системот нема/u,
    `a shown tier is never declared absent from the system: ${drained}`);
  assert.match(drained, /(?:поскапо|поскапи|други населби|друга населба|друг дел од градот)/iu,
    `the drained answer keeps the pivots: ${drained}`);

  const neverShown = await say('SAKAM I TROSOBNI');
  assert.match(neverShown, /Моментално во системот нема трособни до 120\.000 евра во Центар\./u,
    `the never-shown tier is a system gap, named in the owner's words: ${neverShown}`);
});
