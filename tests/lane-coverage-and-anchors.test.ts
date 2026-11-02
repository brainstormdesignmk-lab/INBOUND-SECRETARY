/**
 * THE THREE REMAINING LIMITATION CLASSES, MADE CHECKABLE.
 *
 * 1. AN EXEMPTION MUST PROVE ITS SUBJECT. `exempt` used to mean "this lane may
 *    answer spec-bearing turns" — a hole a stray spec could walk through. It now
 *    carries `owns`, and a lane whose own vocabulary is absent stands down.
 *
 * 2. COVERAGE IS MEASURED, NOT ASSUMED. The production route-drift corpus is
 *    replayed on every run: an ACQUISITION-shaped message (a request verb + a
 *    property type, or an inventory ask) must never be answered by an advice
 *    lane — the funnel asks its criteria, and a lane that answers it is the
 *    [22:34]/[01:48] class returning under a new phrasing.
 *
 * 3. EVERY PLACE-SHAPED LAYER IS WALKED. A landmark named in a search must
 *    survive: extraction → resolution → the classify event → the session slot
 *    → the pool ranking → the CARD (measuring distance) → the cheaper/re-wider
 *    batch → the criteria turn. The [01:48] and [02:38] captures each killed one
 *    of these layers while the others looked fine, which is why the chain is
 *    asserted as a chain instead of sentence by sentence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
import {
  ADVICE_GATES, adviceLaneAdmits, extractSlots, detectInventoryAsk, detectSeeOffers,
} from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const STATION = { lat: 41.9910, lon: 21.4459 };
const ROWS: Property[] = [
  { eb: 901, id: 901, location: 'Центар', address: 'Ул. Браќа Миладинови 4', price: 84000, bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy', lat: STATION.lat + 0.0010, lon: STATION.lon + 0.0006 },
  { eb: 902, id: 902, location: 'Центар', address: 'Ул. Браќа Миладинови 18', price: 81000, bedrooms: 1, sqm: 44, size: '44 м²', service: 'buy', lat: STATION.lat - 0.0013, lon: STATION.lon + 0.0008 },
  // A cheaper, larger flat far from the station: the anchor must still rank it.
  { eb: 903, id: 903, location: 'Аеродром', address: 'Ул. Јане Сандански 20', price: 74000, bedrooms: 2, sqm: 55, size: '55 м²', service: 'buy', lat: 41.9770, lon: 21.4700 },
  { eb: 904, id: 904, location: 'Центар', address: 'Ул. Браќа Миладинови 30', price: 90000, bedrooms: 2, sqm: 62, size: '62 м²', service: 'buy', lat: STATION.lat + 0.0014, lon: STATION.lon + 0.0011 },
  // The cheaper двособен NEAR the station, so the cheaper batch has a real
  // answer to serve (without it the lane honestly said «нема поевтини во таа
  // населба» and the layer this test walks was never exercised).
  { eb: 905, id: 905, location: 'Центар', address: 'Ул. Браќа Миладинови 44', price: 78000, bedrooms: 2, sqm: 50, size: '50 м²', service: 'buy', lat: STATION.lat + 0.0018, lon: STATION.lon - 0.0009 },
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
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
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

// ── 1. THE EXEMPTION CONTRACT ───────────────────────────────────────────────
test('an exempt lane owns a spec-bearing turn only when its subject is present', () => {
  // Every exempt row carries a proof, and the proof is a real vocabulary test.
  for (const [intent, gate] of Object.entries(ADVICE_GATES)) {
    if (!gate.exempt) continue;
    assert.equal(typeof gate.exempt.owns, 'function', `${intent} declares an exemption with no owns()`);
    assert.equal(gate.exempt.owns('SAKAM STAN DO 80000 VO AERODROM'), false,
      `${intent}: a plain search passed its own exemption proof`);
  }
  // …and genuine subject-bearing turns still pass:
  assert.equal(adviceLaneAdmits('ESCALATION', 'sakam stan do 80000 vo aerodrom, sakam menadzer'), true);
  assert.equal(adviceLaneAdmits('PROVISION_ASK', 'kolku e provizijata za stanot do 80000?'), true);
  assert.equal(adviceLaneAdmits('FEE_WHY', 'zosto zemate pari za poseta?'), true);
  assert.equal(adviceLaneAdmits('WORKDAYS_QUESTION', 'rabotite li vo sabota?'), true);
  assert.equal(adviceLaneAdmits('SCHEDULING_FLEX', 'moze li posle 18 saat?'), true);
  // (their DETECTORS stay untouched — this is the gate, not the grammar)
  assert.equal(adviceLaneAdmits('PROVISION_ASK', 'daj mi stan do 80000'), false);
});

// ── 2. CORPUS COVERAGE ──────────────────────────────────────────────────────
test('no advice lane answers an acquisition-shaped turn in the production corpus', () => {
  const files = ['data/route-drift-2026-10-31.jsonl', 'data/route-drift-2026-10-30.jsonl'];
  const texts = new Set<string>();
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const t = (JSON.parse(line) as { text?: string }).text?.trim();
        if (t) texts.add(t);
      } catch { /* skip malformed rows */ }
    }
  }
  if (texts.size === 0) return; // corpus not shipped in this checkout

  const REQUEST = /(?:sakam|сакам|baram|барам|daj|дај|najdi|најди|mi\s+treba|ми\s+треба|treba\s+mi|треба\s+ми|pokazi|покажи)/iu;
  const TYPE = /(?:stan|стан|kukj|куќ|kuka|lokal|локал|dukj|дукј|plac|плац|garsonj|гарсоњ|deloven|деловен)/iu;
  const offenders: string[] = [];
  for (const text of texts) {
    const ev = extractSlots(text);
    const hasSpecs = ev.bedrooms !== undefined || ev.bedroomsMin !== undefined
      || ev.sqm !== undefined || !!ev.budget || ev.business !== undefined || ev.plac || ev.yard;
    const acquisition = (REQUEST.test(text) && TYPE.test(text))
      || detectInventoryAsk(text) || detectSeeOffers(text);
    if (!acquisition) continue;
    for (const state of ['idle', 'intent', 'discovery', 'presentation', 'property_query']) {
      const d = dispatchSimple(text, state);
      if (!d) continue;
      const gate = ADVICE_GATES[d.intent];
      // An exempt lane is allowed only with its subject; anything else claiming
      // an acquisition turn is the misroute class this file exists for.
      const allowed = !!gate?.exempt && gate.exempt.owns(text);
      if (!allowed && !hasSpecs && !acquisition) continue;
      if (!allowed) offenders.push(`${d.intent}@${state} :: ${text.replace(/\n/g, ' ')}`);
    }
  }
  assert.deepEqual(offenders, [],
    `an advice lane claims an acquisition turn:\n${offenders.slice(0, 12).join('\n')}`);
});

// ── 3. THE PLACE CHAIN, LAYER BY LAYER ──────────────────────────────────────
test('a landmark survives every layer: slots → ranking → cards → cheaper batch → criteria', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return; // no map on this machine — offlineMap.test.ts pins the DB
  const { say, sessions, chatId } = makeHandler('anchor-chain');

  // LAYER 1–3 (extract → resolve → event → slot): four surface forms of ONE place.
  for (const [i, ask] of [
    'SAKAM DA KUPAM STAN KAJ ZELEZNICKA',
    'SAKAM DA KUPAM STAN VO BLIZINA NA ZELEZNICKA STANICA',
    'sakam da kupam stan blizu zeleznicka stanica',
    'САКАМ ДА КУПАМ СТАН КАЈ ЖЕЛЕЗНИЧКА СТАНИЦА',
  ].entries()) {
    const h = makeHandler(`anchor-form-${i}`);
    await h.say(ask);
    const s = h.sessions.get(h.chatId)!;
    assert.ok(s.slots.poiAnchor, `the place was dropped for ${JSON.stringify(ask)}`);
    assert.match(s.slots.poiAnchor!, /железнич|zeleznich/iu, `wrong place for ${JSON.stringify(ask)}: ${s.slots.poiAnchor}`);
  }

  // LAYER 4–5 (slot → pool ranking → card distance): the nearest rows lead, and
  // EVERY served card states how far it is from the place the client named.
  const first = await say('SAKAM DA KUPAM STAN KAJ ZELEZNICKA');
  assert.ok(sessions.get(chatId)!.slots.poiAnchor, `the anchor is on file: ${first}`);
  const reply = await say('dvosoben do 90000');
  const s1 = sessions.get(chatId)!;
  assert.equal(s1.state, 'presentation', `the criteria turn serves: ${reply}`);
  assert.match(reply, /Евидентен број 901/u, `nearest leads: ${reply}`);
  const ebLines = reply.split('\n').filter(l => /Евидентен број \d+/u.test(l));
  assert.ok(ebLines.length > 0, `cards were served: ${reply}`);
  for (const line of ebLines) {
    assert.match(line, /(?:m|метри|km) од/iu,
      `an anchored card must state its distance: ${line}`);
  }
  assert.match(reply, /Железнич/iu, `the answer names the place it ranked from: ${reply}`);

  // LAYER 6 (the CHEAPER batch): a "cheaper" ask re-serves around the SAME place
  // — the anchor must not be lost, and the new cards must keep their distance.
  const cheaper = await say('daj mi poevtino');
  const s2 = sessions.get(chatId)!;
  assert.ok(s2.slots.poiAnchor, 'the cheaper batch dropped the anchor');
  const cheapLines = cheaper.split('\n').filter(l => /Евидентен број \d+/u.test(l));
  assert.ok(cheapLines.length > 0, `the cheaper batch serves cards: ${cheaper}`);
  for (const line of cheapLines) {
    assert.match(line, /(?:m|метри|km) од/iu,
      `a cheaper card near a named place must state its distance: ${line}`);
  }

  // LAYER 7 (the criteria turn keeps it, the inventory ask keeps it).
  const inv = await say('STO IMATE VO TOJ REON?');
  assert.ok(sessions.get(chatId)!.slots.poiAnchor, 'the inventory ask dropped the anchor');
  assert.match(inv, /Железнич/iu, `the inventory answer names the place: ${inv}`);
});
