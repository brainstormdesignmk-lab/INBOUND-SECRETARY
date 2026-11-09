// THE [10:11]–[10:19] FIELD BATCH — the recall on the site, and the charge
// question on the way to it. Three defects, one thread:
//
//   [10:11] «ГЛЕДАВ ЕДЕН СТАН КАЈ ВАС НА САЈТ И БИ САКАЛ ДА ГО ПОСЕТАМ /
//            СТАН ЗА ПРОДАЖБА МАЏАР МААЛО / 2 СПАЛНИ»
//        → the three lines arrive as ONE typing-window message. The bare «И»
//          at the head of «И БИ САКАЛ…» sat between the «ЕДЕН» and the «2» of
//          another sentence, so detectBedroomsRange read 2…3 СПАЛНИ — a room
//          BAND instead of the exact трисобен. Downstream the locate lane had
//          no exact count and padded the pair with a двособен / гарсоњера.
//   [10:12] «НЕ ЗНАМ НИШТО ПОВЕЌЕ ОД ОВА ШТО ВИ ГО КАЖАВ»
//        → the pair itself: EB 91 (трисобен = 2 спални + дневна) AND EB 63
//          (гарсоњера). The client described a 2-BEDROOM flat; closestMatches
//          only RANKS by room count, so a wrong-room row rode price proximity
//          into the second slot. Owner's [13:28] rule applies here too.
//   [10:15] «АДРЕСА ИМАШ ?»
//        → missed every address detector (they all key on адресата/улицата or
//          a which-word), so the dynamic brain answered with privacy speech.
//          The nearby protocol (landmark + map link) never ran.
//   [10:19] «КЕ МИ НАПЛАТИТЕ ЗА ДА ГО ВИДАМ ?»
//        → the viewing VERB «видам» was invisible to the nag predicate, the
//          charge question burned no rung, the classifier read the future
//          tense as consent and the funnel asked for the contact instead.
//
// All four are pinned below through the REAL pipeline (InboundHandler).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { detectBedroomsRange, detectExactAddressAsk, detectFeeNag, extractSlots } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

// The field rows: EB 91 is the flat the client means — «2 СПАЛНИ» = a трисобен
// (two bedrooms + living room) in Маџар Маало (Центар on the feed). EB 47 is
// the двособен and EB 63 the гарсоњера — both were wrongly paired with it.
const ROWS: Property[] = [
  { eb: 91, id: 91, location: 'Центар', address: 'Маџар Маало 12', price: 178000, service: 'buy', bedrooms: 3, sqm: 71, size: '71 м²', lat: 42.0010, lon: 21.4320 } as Property,
  { eb: 47, id: 47, location: 'Центар', address: 'Маџар Маало 4', price: 150500, service: 'buy', bedrooms: 2, sqm: 59, size: '59 м²', lat: 42.0011, lon: 21.4319 } as Property,
  { eb: 63, id: 63, location: 'Центар', address: 'Црногорска 9', price: 36000, service: 'buy', studio: true, bedrooms: 1, sqm: 28, size: '28 м²', lat: 42.0020, lon: 21.4330 } as Property,
];

function makeHandler() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-1011-'));
  const mapPath = path.join(dir, 'map.db');
  writeMap(mapPath, [
    { name: 'Рамстор Мол', type: 'mall', lat: 42.0012, lon: 21.4322, source: 'google' },
  ], []);
  const offlineMap = new OfflineMapStore(mapPath);
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
  });
  return { handler, sessions, sent, offlineMap };
}

const CARD = /Евидентен број \d/u;
const MERGED = 'ГЛЕДАВ ЕДЕН СТАН КАЈ ВАС НА САЈТ И БИ САКАЛ ДА ГО ПОСЕТАМ\nСТАН ЗА ПРОДАЖБА МАЏАР МААЛО\n2 СПАЛНИ';

test('[10:11] the typing-window «И» is a conjunction, not a room-range connector', () => {
  // The exact merged message: «…НА САЈТ И БИ САКАЛ ДА ГО ПОСЕТАМ / … / 2 СПАЛНИ»
  assert.equal(detectBedroomsRange(MERGED), undefined,
    'a sentence-initial «И» between two unrelated numbers is not a 2…3 band');
  const slots = extractSlots(MERGED);
  assert.equal(slots.bedrooms, 3, '2 СПАЛНИ = трисобен, exactly');
  assert.equal(slots.bedroomsMin, undefined, 'no room band');
  assert.equal(slots.bedroomsMax, undefined, 'no room band');
  // The real coordinated shapes keep the band (tests/deterministic.test.ts
  // owns the full list — this pins that the proximity guard did not eat them).
  assert.deepEqual(detectBedroomsRange('i so edna i so dve'), { min: 2, max: 3 });
  assert.deepEqual(detectBedroomsRange('moze i so edna , a moze i so dve'), { min: 2, max: 3 });
  assert.deepEqual(detectBedroomsRange('dve ili tri spalni'), { min: 3, max: 4 });
});

test('[10:12] the recall pair holds ONLY the room count the client described', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();

  await handler.handle('test', 'c1011', MERGED);
  const s1 = sessions.get('c1011')!;
  assert.equal(s1.state, 'property_locate', `the locate funnel collects: ${s1.state}`);
  assert.equal(s1.slots.bedrooms, 3, 'the room count survives the merged turn');
  // The [madjari] money-anchor gate still owns the entry: no price → ask.
  assert.ok(!CARD.test(sent[sent.length - 1]), 'no serve before the anchor: the [madjari] gate');

  await handler.handle('test', 'c1011', 'НЕ ЗНАМ НИШТО ПОВЕЌЕ ОД ОВА ШТО ВИ ГО КАЖАВ');
  const s2 = sessions.get('c1011')!;
  const r2 = sent[sent.length - 1];
  assert.ok(CARD.test(r2), `the recall answer serves cards: ${r2}`);
  assert.ok(r2.includes('Евидентен број 91'), `the 3-room flat leads: ${r2}`);
  assert.ok(!r2.includes('Евидентен број 47'),
    `a двособен is NOT a 2-bedroom flat — never padded beside the трисобен: ${r2}`);
  assert.ok(!r2.includes('Евидентен број 63'),
    `a гарсоњера is NOT a 2-bedroom flat — never padded beside the трисобен: ${r2}`);
  assert.deepEqual(s2.slots.currentBatch, [91], 'the batch is the one right-count card');

  offlineMap.close();
});

test('[10:13] restating the criteria never re-serves a wrong-room card', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();

  await handler.handle('test', 'c1013', MERGED);
  await handler.handle('test', 'c1013', 'НЕ ЗНАМ НИШТО ПОВЕЌЕ ОД ОВА ШТО ВИ ГО КАЖАВ');
  await handler.handle('test', 'c1013', 'ОВОЈ ШТО ГО ГЛЕДАВ ИМАШЕ 2 СПАЛНИ И БЕШЕ ВО МАЏАР МААЛО');
  const s = sessions.get('c1013')!;
  const r = sent[sent.length - 1];
  assert.ok(r.includes('Евидентен број 91'), `still the трисобен: ${r}`);
  assert.ok(!r.includes('Евидентен број 63'), `never the гарсоњера beside it: ${r}`);
  assert.deepEqual(s.slots.currentBatch, [91]);

  offlineMap.close();
});

test('[10:15] «АДРЕСА ИМАШ ?» runs the nearby protocol with a map link (no dynamic brain)', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();

  await handler.handle('test', 'c1015', MERGED);
  await handler.handle('test', 'c1015', 'НЕ ЗНАМ НИШТО ПОВЕЌЕ ОД ОВА ШТО ВИ ГО КАЖАВ');
  await handler.handle('test', 'c1015', 'АДРЕСА ИМАШ ?');
  const r = sent[sent.length - 1];
  // The nearby protocol: the landmark line + the map link, never the privacy
  // speech the dynamic brain produced in the field.
  assert.match(r, /во близина на/u, `the nearby protocol answers: ${r}`);
  assert.ok(r.includes('Рамстор Мол'), `the resolved landmark is named: ${r}`);
  assert.match(r, /https:\/\/maps\.google\.com\/\?q=42\.00120,21\.43220/u,
    `a coordinate map link rides the answer: ${r}`);
  assert.ok(!/сопственикот пред организирање/u.test(r), `not the privacy speech: ${r}`);
  // The property the answer is about: the flat the client described (EB 91).
  assert.equal(sessions.get('c1015')!.slots.propertyId, 91, 'bound to the described flat');

  offlineMap.close();
});

test('[10:19] the charge question burns rung 1 — it is never consent', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();

  await handler.handle('test', 'c1019', MERGED);
  await handler.handle('test', 'c1019', 'НЕ ЗНАМ НИШТО ПОВЕЌЕ ОД ОВА ШТО ВИ ГО КАЖАВ');
  await handler.handle('test', 'c1019', 'КЕ МИ НАПЛАТИТЕ ЗА ДА ГО ВИДАМ ?');
  const s = sessions.get('c1019')!;
  const r = sent[sent.length - 1];
  assert.equal(s.slots.feeRejections, 1, 'exactly one rung burned');
  assert.notEqual(s.state, 'contact_collection', `no contact collection on a charge question: ${s.state}`);
  assert.ok(!/име и презиме/u.test(r), `never the contact ask: ${r}`);
  // The rung's own copy discloses the fee — the honest answer to the question.
  assert.match(r, /500 денари/u, `the persuasion names the visit fee: ${r}`);
  assert.match(r, /\?$/u, `the rung ends with its question: ${r}`);

  offlineMap.close();
});

test('detectFeeNag: the viewing VERB is a fee referent (charge-question family)', () => {
  for (const t of [
    'КЕ МИ НАПЛАТИТЕ ЗА ДА ГО ВИДАМ ?',
    'ЌЕ МИ НАПЛАТИТЕ ЗА ДА ГО ВИДАМ?',
    'KJE MI NAPLATITE ZA DA GO VIDAM ?',
    'ЌЕ МИ НАПЛАТИТЕ ЗА ГЛЕДАЊЕ ?',
  ]) {
    assert.equal(detectFeeNag(t), true, `charge question must be a nag: ${t}`);
  }
  // A recall statement keeps its own lane: no charge frame, no fee object.
  assert.equal(detectFeeNag('ГЛЕДАВ ЕДЕН СТАН КАЈ ВАС НА САЈТ И БИ САКАЛ ДА ГО ПОСЕТАМ'), false);
  // The bare hesitation arm is FEE-CONTEXT scoped: in property_locate the
  // locate lane asks the caller for feeContext:false, where «не знам ништо
  // повеќе» answers the identify question and must burn nothing.
  assert.equal(detectFeeNag('НЕ ЗНАМ НИШТО ПОВЕЌЕ ОД ОВА ШТО ВИ ГО КАЖАВ'), true,
    'in the fee funnel (closing) a bare hesitation still climbs');
  assert.equal(detectFeeNag('НЕ ЗНАМ НИШТО ПОВЕЌЕ ОД ОВА ШТО ВИ ГО КАЖАВ', { feeContext: false }), false,
    'outside the fee funnel it is an answer, not resistance');
});

test('detectExactAddressAsk: «АДРЕСА ИМАШ ?» is an address demand in both word orders', () => {
  for (const t of ['АДРЕСА ИМАШ ?', 'adresa imas?', 'imas adresa?', 'УЛИЦА ИМАТЕ ?', 'ИМАТЕ ЛИ АДРЕСА ?']) {
    assert.equal(detectExactAddressAsk(t), true, `an address demand: ${t}`);
  }
  // A 3rd-person assertion about the flat is not a demand.
  assert.equal(detectExactAddressAsk('станот има адреса во Центар'), false);
  assert.equal(detectExactAddressAsk('ГЛЕДАВ ЕДЕН СТАН'), false);
});
