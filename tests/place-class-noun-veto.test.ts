/**
 * A CLASS NOUN IS NOT A LANDMARK (the [23:29]/[23:34] captures).
 *
 *   [23:34] STO IMATE INTERESNO KAJ VOENA BOLNICA ?
 *   ЛИНА: «За Болница 8ми Септември …»   ← the copy
 *   slots.poiAnchor = «Болница за зависности»   ← the anchor, 4 km elsewhere
 *
 * The wish extractor's preposition could bind the TAIL of the place's own
 * first word («VOE|NA| BOLNICA» — the preposition «на» inside «воена»), so the
 * candidate it handed the map was the bare class noun «BOLNICA». The map then
 * answered with the shortest row carrying that word — «Болница за зависности»
 * — and the turn's copy and its anchor named two different hospitals.
 *
 * Two fixes, both pinned here:
 *   1. the extractor's preposition must START a word, so «воена» survives;
 *   2. a single class noun (болница/мол/црква/училиште/амбасада…) is never a
 *      place on its own — the map refuses it instead of guessing the nearest
 *      row of that kind.
 * Plus the colloquial alias: «воена болница» is the ГОБ 8-ми Септември HOSPITAL
 * row, not the bus stop of a similar name 200 m away.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore, refusesGenericNeedle } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';
import { extractInventoryPlace, detectInventoryAsk } from '../src/llm/deterministic';

const cfg = loadConfig();
const hasMap = !!cfg.skopjePoisDb && fs.existsSync(cfg.skopjePoisDb);

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

test('a class noun alone never resolves to a place', { skip: !hasMap && 'no offline map' }, () => {
  // The bounded class vocabulary this business meets — each one is a KIND.
  for (const word of ['болница', 'БОЛНИЦА', 'bolnica', 'мол', 'mol', 'црква', 'училиште',
    'амбасада', 'пазар', 'маркет', 'хотел', 'факултет', 'аптека', 'парк', 'кафе']) {
    assert.equal(refusesGenericNeedle(word), true, `«${word}» alone is a class, not a place`);
  }
  // …and a real two-word name is never touched by that veto.
  for (const name of ['Болница 8ми Септември', 'Сити Мол', 'Градежен Факултет', 'Капитол']) {
    assert.equal(refusesGenericNeedle(name), false, `«${name}» is a name`);
  }
  const store = new OfflineMapStore(cfg.skopjePoisDb);
  assert.equal(store.findPoiByName('болница'), undefined,
    'a bare «болница» must MISS — the shortest hospital row is not an answer');
  assert.equal(store.findPoiByName('МОЛ'), undefined, 'a bare «мол» must MISS');
  // …BUT THE BARE NAME OF A ONE-OF-A-KIND INSTITUTION IS ITS NAME: the
  // Assembly is one building and «Собрание» is what Skopjani call it. The
  // class-noun veto read placeCategory() («government») and refused it, so a
  // four-place rotation silently lost its fourth place.
  assert.equal(refusesGenericNeedle('Собрание'), false, 'the Assembly is a place');
  assert.ok(store.findPoiByName('SOBRANIE'), '«кај Собрание» must resolve');
});

test('a PROPERTY word is a category answer, never a place anchor', { skip: !hasMap && 'no offline map' }, () => {
  // The [08:46] capture: the client answered the TYPE question with «APARTMAN»,
  // the wish extractor handed it to the map, and the map answered «Apartmani
  // Skopje» — one holiday flat filed as a POI in Центар. The whole search was
  // anchored on that listing: every card read «Се наоѓа на 1,4 km од Апартмани
  // Скопје» and the widen ask called the flat a «населба».
  const store = new OfflineMapStore(cfg.skopjePoisDb);
  for (const needle of ['APARTMAN', 'apartman', 'APARTMANI SKOPJE', 'Apartmani Skopje',
    'СТАН', 'stan', 'soba', 'garconjera']) {
    assert.equal(store.findPoiByName(needle), undefined,
      `«${needle}» is a property type — it never resolves to a place`);
  }
  // …and the real places around it are untouched.
  assert.ok(store.findPoiByName('TRI BISERI'), '«Три Бисери» is a place');
  assert.ok(store.findPoiByName('ZELEZNICKA STANICA'),
    '«станица» starts with «стан» but is a station, not a flat');
});

test('«воена болница» is the hospital row, never the bus stop of that name', { skip: !hasMap && 'no offline map' }, () => {
  const store = new OfflineMapStore(cfg.skopjePoisDb);
  for (const spelling of ['воена болница', 'ВОЕНА БОЛНИЦА', 'voena bolnica', 'старата воена болница']) {
    const hit = store.findPoiByName(spelling);
    assert.ok(hit, `«${spelling}» is a known place`);
    assert.equal(hit!.type, 'hospital', `«${spelling}» binds the hospital, got ${hit!.name} [${hit!.type}]`);
    assert.match(hit!.name, /8-?ми Септември/u, `the row is the 8-ми Септември hospital: ${hit!.name}`);
  }
  // The bare class noun takes its identity words with it now.
  assert.equal(extractInventoryPlace('STO IMATE INTERESNO KAJ VOENA BOLNICA ?'), 'VOENA BOLNICA',
    'the qualifier survives the extractor');
});

test('the place named FIRST is read too — «KAJ CITI MOL STO IMAS ?»', () => {
  assert.equal(detectInventoryAsk('KAJ CITI MOL STO IMAS ?'), true);
  assert.equal(extractInventoryPlace('KAJ CITI MOL STO IMAS ?'), 'CITI MOL',
    'the place before the ask is still the place');
  assert.equal(extractInventoryPlace('VO BUNJAKOVEC STO IMATE'), 'BUNJAKOVEC');
});

function makeHandler(id: string) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new PropertyService(cfg.propertyDataUrl);
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
  return { say, sessions, chatId: id };
}

test('e2e: «VOENA BOLNICA» answers about the place the client named — one place, in copy AND slot',
  { skip: !hasMap && 'no offline map' }, async () => {
    const { say, sessions, chatId } = makeHandler('voena');
    const reply = await say('ZDRAVO STO IMATE INTERESNO KAJ VOENA BOLNICA ?');
    const anchor = String(sessions.get(chatId)!.slots.poiAnchor ?? '');
    assert.match(anchor, /8-?ми Септември/u, `the anchor is the military hospital's row, got ${anchor}`);
    assert.doesNotMatch(anchor, /зависности/u, `the addiction clinic is a different place: ${anchor}`);
    assert.match(reply, /8-?ми Септември/u, `the copy names the same place: ${reply}`);
    assert.doesNotMatch(reply, /зависности/u, `the copy must not drift to another hospital: ${reply}`);
  });

test('e2e: a place-first stock ask lands the anchor', { skip: !hasMap && 'no offline map' }, async () => {
  const { say, sessions, chatId } = makeHandler('citi');
  const reply = await say('KAJ CITI MOL STO IMAS ?');
  assert.match(String(sessions.get(chatId)!.slots.poiAnchor ?? ''), /сити мол/iu,
    `the mall the client named is the anchor: ${reply}`);
  assert.doesNotMatch(reply, /Буњаковец/u, `no other landmark answers for it: ${reply}`);
});
