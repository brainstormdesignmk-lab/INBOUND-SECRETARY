/**
 * THE [10:58]/[10:00] FIELD BATCH — three defects on one real transcript
 * (chat «client-1», stored in data/tui.db; the rows below are the live feed's
 * own columns for EB 82, 75 and 85).
 *
 *   … РАЗГЛЕДУВАВ СТАНОВИ НА ВАШАТА СТРАНИЦА И САКАМ ДА ПРАШАМ ЗА СТАН СО
 *     ЕВИДЕНТЕН БРОЈ 82 И 75
 *   → only EB 82 was described; the client had to type «А 75 ?»
 *   НАПРАВИ МИ СПОРЕДБА НА ЦЕНА ПО КВАДРАТ ЗА ДВАТА СТАНА
 *   → only EB 75 got its rate (2.026 €/м²); EB 82 was dropped
 *   НА КОЈА УЛИЦА Е ОВОЈ ВО НОВО ЛИСИЧЕ ?            (EB 85)
 *   → «Тоа се наоѓа во близина на ТЦ Мавровка» + the MALL's coordinates
 *     (41.99944,21.43934), a place from the middle of town, for a flat whose
 *     feed row carries geo_source `osm_street_anchor` — and the value was
 *     silently DROPPED on import, so a street centroid passed for a trusted
 *     building point.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property, mapRow } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { EnrichmentStore } from '../src/store/enrichment';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ROWS: Property[] = [
  {
    eb: 82, id: 82, uuid: 'eb82', location: 'Аеродром', address: 'Јане Сандански 35',
    price: 143000, bedrooms: 3, sqm: 77, size: '77 м²', service: 'buy',
    lat: 41.9882, lon: 21.4665, geo_source: 'osm_building',
  },
  {
    eb: 75, id: 75, uuid: 'eb75', location: 'Аеродром', address: 'Кузман Јосифовски Питу 19/5',
    price: 154000, bedrooms: 3, sqm: 76, size: '76 м²', service: 'buy',
    lat: 41.9885, lon: 21.4513, geo_source: 'google_cached',
  },
  {
    eb: 85, id: 85, uuid: 'eb85', location: 'Ново Лисиче', address: 'КАЈ БРАНКА',
    price: 133000, bedrooms: 3, sqm: 100, size: '100 м²', service: 'buy',
    lat: 41.9993, lon: 21.44, geo_source: 'osm_street_anchor',
  },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  // The real service answers a Set: the mention collector reads membership.
  async getAllEbs(): Promise<Set<number>> { return new Set(this.rows.map(r => r.eb)); }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string, rows: Property[]) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(rows)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(rows),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId: id, sent };
}

test('[10:58] two named Евидентен броеви are BOTH described — «А 75 ?» is never needed', async () => {
  const h = makeHandler('two-ebs', ROWS);
  const reply = await h.say('РАЗГЛЕДУВАВ СТАНОВИ НА ВАШАТА СТРАНИЦА И САКАМ ДА ПРАШАМ ЗА СТАН СО ЕВИДЕНТЕН БРОЈ 82 И 75');
  assert.match(reply, /82/u, `EB 82 is described: ${reply}`);
  assert.match(reply, /75/u, `EB 75 is described too — the client must not have to ask «А 75 ?»: ${reply}`);
  assert.match(reply, /143[.\s]?000/u, `EB 82's own price: ${reply}`);
  assert.match(reply, /154[.\s]?000/u, `EB 75's own price: ${reply}`);
  assert.match(reply, /77\s*м²/u, `EB 82's surface: ${reply}`);
  assert.match(reply, /76\s*м²/u, `EB 75's surface: ${reply}`);
});

test('[10:58] «СПОРЕДБА НА ЦЕНА ПО КВАДРАТ ЗА ДВАТА СТАНА» quotes the rate for BOTH flats', async () => {
  const h = makeHandler('pair-rate', ROWS);
  await h.say('РАЗГЛЕДУВАВ СТАНОВИ НА ВАШАТА СТРАНИЦА И САКАМ ДА ПРАШАМ ЗА СТАН СО ЕВИДЕНТЕН БРОЈ 82 И 75');
  const reply = await h.say('НАПРАВИ МИ СПОРЕДБА НА ЦЕНА ПО КВАДРАТ ЗА ДВАТА СТАНА');
  // 143.000 / 77 = 1.857 €/м²;  154.000 / 76 = 2.026 €/м²
  assert.match(reply, /82/u, `EB 82 is part of the comparison: ${reply}`);
  assert.match(reply, /1[.\s]?857/u, `EB 82's arithmetic rate (143.000 / 77): ${reply}`);
  assert.match(reply, /2[.\s]?026/u, `EB 75's arithmetic rate (154.000 / 76): ${reply}`);
  assert.doesNotMatch(reply, /За кое конкретно станува збор/u, `the pair is on the table — no clarify loop: ${reply}`);
});

test('[10:00] a street ask on a street-anchor row answers its AREA — never a landmark pin from another part of town', async () => {
  const h = makeHandler('street-85', ROWS);
  const describe = await h.say('А 85 ?');
  assert.match(describe, /85/u, `EB 85 is described: ${describe}`);
  const reply = await h.say('НА КОЈА УЛИЦА Е ОВОЈ ВО НОВО ЛИСИЧЕ ?');
  assert.match(reply, /Ново Лисиче/u, `the feed's own neighbourhood is the answer: ${reply}`);
  assert.doesNotMatch(reply, /ТЦ Мавровка/u,
    `the street ask never answers with a mall from the town centre: ${reply}`);
  assert.doesNotMatch(reply, /41\.99944/u,
    `and never pins the LANDMARK's coordinates as the flat's address: ${reply}`);
});

test('the feed\'s `osm_street_anchor` is CARRIED, not dropped (a weak geocode stays a weak geocode)', () => {
  const row = mapRow({
    evidenten_broj: 85, id: '0ed1732a-e4ba-4cda-ab74-5eb1985954cf', naselba: 'Ново Лисиче',
    adresa: 'КАЈ БРАНКА', cena_eur: 133000, povrsina_m2: 100,
    lat: 41.9993, lon: 21.44, geo_source: 'osm_street_anchor',
  });
  assert.ok(row, 'the row maps');
  assert.equal(row!.geo_source, 'osm_street_anchor',
    'the value is part of the feed vocabulary — dropping it made a street centroid look trusted');
});
