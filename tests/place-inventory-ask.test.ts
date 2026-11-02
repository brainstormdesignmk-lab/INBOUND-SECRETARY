/**
 * THE [01:48] CAPTURE — «STO IMATE VO TOJ REON?» is INVENTORY, not area advice.
 *
 *   [01:48] ZDRAVO SAKAM DA KUPAM STAN VO BLIZINA NA ZELEZNICKA
 *   [01:48] ЛИНА [без LLM]: 1. Колку спални соби… 2. Која е горната граница…
 *   [01:48] STO IMATE VO TOJ REON ?
 *   [01:48] ЛИНА [deterministic:fast]: Различни населби одговараат на различни
 *           потреби… што Ви е поважно: пристапна цена, тивка атмосфера или
 *           близина до центарот?
 *
 * Two defects produced that turn, and both are pinned here:
 *
 * 1. THE INVENTORY ASK WAS CLAIMED BY AREA ADVICE. «Што имате во тој реон?» asks
 *    WHAT IS AVAILABLE in the place the client just named — the show-me question
 *    («што имате во понуда?» is one word away). The neighbourhood lane owns
 *    «реон» and answered with an essay about neighbourhood character plus a
 *    question the client had not asked. `detectInventoryAsk` is the grammar for
 *    the family (have-verb × what-word × a demonstrative or a feed area), the
 *    show-me lane serves it, and ADVICE_GATES keeps every advice lane off it.
 *
 * 2. THE PLACE WAS DROPPED ON THE DETERMINISTIC PATH. «VO BLIZINA NA
 *    ZELEZNICKA» is the anchor his next turn refers to ("тој реон"). The LLM
 *    binary stamped poiAnchor on its event; the deterministic path built a fresh
 *    event without it, so the funnel asked its questions with NO geography and
 *    the follow-up had no referent. Both paths carry the wish now.
 *
 * The contract: the anchor survives turn 1, the inventory ask is answered with
 * real offers ranked from that place (and its honest "nothing within walking
 * distance" line when there is none), and the area-advice paragraph never
 * answers a search.
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
import { EnrichmentStore } from '../src/store/enrichment';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { dispatchSimple } from '../src/handlers/router';
import { detectNeighborhoodAsk, detectSeeOffers, detectInventoryAsk } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// The live map's «Железничка станица Скопје» (41.9910, 21.4459).
const STATION = { lat: 41.9910, lon: 21.4459 };

const ROWS: Property[] = [
  // ~150 m from the station — the pair the client asked to see.
  { eb: 901, id: 901, location: 'Центар', address: 'Ул. Браќа Миладинови 4', price: 84000, bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy', lat: STATION.lat + 0.0010, lon: STATION.lon + 0.0006 },
  { eb: 902, id: 902, location: 'Центар', address: 'Ул. Браќа Миладинови 18', price: 81000, bedrooms: 1, sqm: 44, size: '44 м²', service: 'buy', lat: STATION.lat - 0.0013, lon: STATION.lon + 0.0008 },
  // Cheapest in the pool, ~2.7 km away in Аеродром: the anchor outranks price.
  { eb: 903, id: 903, location: 'Аеродром', address: 'Ул. Јане Сандански 20', price: 74000, bedrooms: 2, sqm: 55, size: '55 м²', service: 'buy', lat: 41.9770, lon: 21.4700 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
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
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId: id };
}

// The generic area-advice paragraphs (the bank rotates them): none of them may
// answer an inventory ask, whatever the wording of the day.
const AREA_ADVICE = /Различни населби|Сите локации имаат сопствени|Секој дел од градот|што Ви е поважно|тивка атмосфера/iu;

test('an inventory ask is not area advice', () => {
  // The exact capture line, and its sibling spellings.
  for (const t of [
    'STO IMATE VO TOJ REON ?',
    'STO IMATE VO TOJ DEL NA GRADOT ?',
    'што имате во тој реон?',
    'STO IMATE TAMU ?',
    'STO NUDITE ?',
  ]) {
    assert.equal(detectInventoryAsk(t), true, `inventory ask not recognised: ${t}`);
    assert.equal(detectSeeOffers(t), true, `the show-me lane must own it: ${t}`);
    assert.equal(detectNeighborhoodAsk(t), false, `area advice claimed an inventory ask: ${t}`);
  }
  // An area NAME carries the anchor too — Latin typed, feed area stored.
  assert.equal(detectSeeOffers('STO IMATE VO AERODROM ?'), true);
  assert.equal(detectSeeOffers('што имаш во Карпош?'), true);
  // …and none of it is reachable through the pre-classifier.
  for (const st of ['idle', 'intent', 'discovery']) {
    assert.equal(dispatchSimple('STO IMATE VO TOJ REON ?', st), undefined, `an advice lane answered it in ${st}`);
  }
  // Genuine area advice keeps its lane, unchanged.
  assert.equal(detectNeighborhoodAsk('DALI E DOBRA NASELBATA AERODROM ZA ZIVEEЊE ?'), true);
  assert.equal(detectNeighborhoodAsk('VO KOJA NASELBA IMA NAJDOBRI STANOVI?'), true);
  assert.equal(detectInventoryAsk('DALI E DOBRA NASELBATA AERODROM ZA ZIVEEЊE ?'), false);
});

test('[01:48] the named place survives turn 1 and the inventory turn serves it', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return; // no live map on this machine — offlineMap.test.ts pins the DB
  const { say, sessions, chatId } = makeHandler('capture-0148');

  // TURN 1 — a buy search with a PLACE and no specs: the funnel asks its criteria
  // (that part was already right) and the place must be ON FILE for turn 2.
  const ask = await say('ZDRAVO SAKAM DA KUPAM STAN VO BLIZINA NA ZELEZNICKA');
  const s1 = sessions.get(chatId)!;
  assert.equal(s1.slots.service, 'buy');
  assert.ok(s1.slots.poiAnchor, `the place the client named was dropped: ${ask}`);
  assert.match(s1.slots.poiAnchor!, /железнич/iu, `wrong anchor: ${s1.slots.poiAnchor}`);
  assert.doesNotMatch(ask, AREA_ADVICE, `a place + a search is never area advice: ${ask}`);
  assert.match(ask, /спалн|цена|price/iu, `the funnel asks its missing criterion: ${ask}`);

  // TURN 2 — «STO IMATE VO TOJ REON?» is answered with ROWS ranked from the
  // place, never with the area-advice paragraph.
  const reply = await say('STO IMATE VO TOJ REON ?');
  const s2 = sessions.get(chatId)!;
  assert.equal(s2.state, 'presentation', `the inventory ask presents: ${reply}`);
  assert.doesNotMatch(reply, AREA_ADVICE, `the area paragraph answered an inventory ask: ${reply}`);
  assert.match(reply, /Евидентен број 901/u, `the flat nearest the station leads: ${reply}`);
  assert.match(reply, /Евидентен број 902/u, `the pair is the two nearest: ${reply}`);
  assert.ok(!/Евидентен број 903/u.test(reply),
    `the cheapest flat is 4.5 km away — the anchor outranks price: ${reply}`);
  assert.match(reply, /Железнич/iu, `the answer names the place it ranked from: ${reply}`);
});

test('[02:38] a blank acquisition near a landmark is served + asked, never read as a recall', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  const { say, sessions, chatId } = makeHandler('capture-0238');

  // The capture used «KAJ ZELEZNICKA» (the preposition the funnel reads as an
  // anchor), not «VO BLIZINA NA».
  const ask = await say('ZDRAVO , SAKAM DA KUPAM STAN KAJ ZELEZNICKA .');
  const s1 = sessions.get(chatId)!;
  assert.equal(s1.slots.service, 'buy');
  assert.ok(s1.slots.poiAnchor, `the place survived: ${ask}`);
  assert.match(ask, /спалн|цена/iu, `the protocol questions come with the search: ${ask}`);

  const reply = await say('STO IMATE VO TOJ REON?');
  const s2 = sessions.get(chatId)!;
  assert.equal(s2.state, 'presentation', `the inventory ask serves: ${reply}`);
  // NEVER the recall question: he never said he had seen a flat.
  assert.doesNotMatch(reply, /таа што ја баравте|the one you saw/iu,
    `a blank acquisition was asked which flat he meant: ${reply}`);
  // The nearby pair, WITH the measured distance to the place he named.
  assert.match(reply, /Евидентен број 901/u, `the flat nearest the station serves: ${reply}`);
  assert.match(reply, /901[\s\S]{0,120}(?:m|метри|km) од/u, `the card states its distance: ${reply}`);
  // …and the room/price protocol rides the same reply (the owner's rule: serve
  // near the landmark AND ask what the funnel always asks).
  assert.match(reply, /спалн/iu, `the rooms question rides the serve: ${reply}`);
  assert.match(reply, /цена|буџет|износ/iu, `the price question rides the serve: ${reply}`);
  // Criteria still unset — the ask is honest, not a repeat of an answer.
  assert.equal(s2.slots.bedrooms, undefined);
  assert.equal(s2.slots.budget, undefined);
});

test('[01:48] the criteria answer that follows resumes the funnel with the anchor intact', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  const { say, sessions, chatId } = makeHandler('capture-0148-follow');
  await say('ZDRAVO SAKAM DA KUPAM STAN VO BLIZINA NA ZELEZNICKA');
  await say('STO IMATE VO TOJ REON ?');
  const reply = await say('dvosoben do 90000');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.bedrooms, 2);
  assert.equal(s.slots.budget, '90000');
  assert.ok(s.slots.poiAnchor, 'the anchor survives the criteria turn');
  assert.equal(s.state, 'presentation');
  assert.doesNotMatch(reply, AREA_ADVICE, `no area advice after the criteria: ${reply}`);
  // THE [11:39] ALREADY-SHOWN RULE: 901 was on the table last turn, so the
  // criteria turn does not replay it — it serves the other двособен and states
  // the MEASURED distance to the place the client named (the anchor is still
  // what ranks the pool, 2.7 km away or not).
  assert.match(reply, /Евидентен број 903/u, `the other двособен is served: ${reply}`);
  assert.ok(!/Евидентен број 902/u.test(reply),
    `the 1-bedroom flat is not the двособен he asked for: ${reply}`);
  assert.match(reply, /Железнич/iu, `the answer is anchored to the named place: ${reply}`);
  assert.match(reply, /\d+\s*m\b|m од|km од/iu, `the distance to the anchor is stated: ${reply}`);
});
