/**
 * «KAJ KATOLICKA NEGDE» IS A LOCATION (the [10:07] capture).
 *
 *   ZDRAVO
 *   SAKAM DA IZNAJMAM STANCE KAJ KATOLICKA NEGDE
 *   → «Кој конкретен дел од градот го имате предвид …?»   ← WRONG
 *   BUDJET DO 250 EVRA
 *   → «Која локација во градот ја имате на ум …?»          ← WRONG
 *
 * The map KNOWS the church («Римокатоличка Катедрала Пресвето Срце Исусово»,
 * «Католичка црква Свети Јосиф», «Католичка црква кон Центар»), but the
 * extractor's tail carries the vague filler «негде», and the coverage guard
 * read that filler as one of the client's words: it found no contiguous window
 * for [католицка, негде] inside the map's name and refused the only landmark
 * the client had named. The funnel then asked him for a neighbourhood twice,
 * after he had pointed at one.
 *
 * The filler is a proximity word (same family as «околу»/«близу»), so it drops
 * before the guard runs: the landmark resolves, discovery asks the PAIR
 * (bedrooms + budget), and the serve is anchored on the church.
 *
 * WHICH church matters too: a generic «католичка» means THE CATHEDRAL every
 * Skopjan knows — «Римокатоличка Катедрала Пресвето Срце Исусово», the church
 * Google lists as «Sacred Heart Catholic Church» at 41.9950, 21.4178 — never
 * the parish «Католичка црква Свети Јосиф» two kilometres east, and never
 * «Католичка црква кон Центар» (a BUS STOP named after the cathedral). The
 * nearest-branch lookup has no center on an intake turn and returned those,
 * which put the whole rent search in the wrong part of town.
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

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// Two rentals a few hundred metres from THE CATHEDRAL (41.9950, 21.4178) —
// inside the 250 € budget, so the anchored serve has options.
const ROWS: Property[] = [
  { eb: 61, id: 61, location: 'Центар', address: 'Ул. Мирче Ацев 12', price: 240, bedrooms: 1, sqm: 40, size: '40 м²', service: 'rent', lat: 41.9952, lon: 21.4171 },
  { eb: 62, id: 62, location: 'Центар', address: 'Ул. Никола Вапцаров 30', price: 250, bedrooms: 2, sqm: 55, size: '55 м²', service: 'rent', lat: 41.9940, lon: 21.4160 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
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
  return { say, sessions, chatId: id };
}

test('«kaj katolicka negde» resolves the church and keeps the funnel on the pair', async () => {
  const { say, sessions, chatId } = makeHandler('katolicka-intake', ROWS);
  await say('ZDRAVO');

  const ask = await say('SAKAM DA IZNAJMAM STANCE KAJ KATOLICKA NEGDE');
  const s = sessions.get(chatId)!;
  assert.match(s.slots.poiAnchor ?? '', /Катедрала/u,
    'the named church is the anchor, not a place-miss');
  assert.match(s.slots.poiAnchor ?? '', /Пресвето Срце Исусово/u,
    'a generic «католичка» is the cathedral («Sacred Heart»), not a near namesake');
  assert.doesNotMatch(s.slots.poiAnchor ?? '', /Свети Јосиф|кон Центар/u,
    'the parish two kilometres east and the bus stop named after the cathedral are other rows');
  assert.equal(s.slots.service, 'rent');

  // Discovery must ask ABOUT THE FLAT (bedrooms + budget), never the
  // neighbourhood the client just pointed at.
  assert.match(ask, /спални/iu, `the pair question comes next: ${ask}`);
  assert.doesNotMatch(ask, /(?:кој|која|кој конкретен)\s+дел од градот|локација во градот/iu,
    `the landmark IS the location: ${ask}`);

  const afterBudget = await say('BUDJET DO 250 EVRA');
  assert.doesNotMatch(afterBudget, /дел од градот|локација во градот/iu,
    `the budget answer must not re-open the location ask: ${afterBudget}`);

  const served = await say('EDNA ILI DVE SPALNI MOZE');
  assert.match(served, /Катедрала|Евидентен број (?:61|62)/u,
    `the cards are anchored on the church named: ${served}`);
  const shown = sessions.get(chatId)!.slots.currentBatch ?? [];
  assert.ok(shown.length > 0, `the anchored search serves: ${served}`);
});

// The church under its OWN name — the one Google shows, and the Macedonian
// name a Skopjan gives — is the same anchor as the bare «католичка». Neither
// spelling appears in the map's row («Римокатоличка Катедрала Пресвето Срце
// Исусово»), so each one is checked in BOTH scripts the extractor hands over:
// Latin as typed, and its letter-by-letter Cyrillic fold («сацред хеарт»).
test('the church answers to its own name — «Sacred Heart», «Свето Срце», «Катедрала»', async () => {
  const said: Array<[string, RegExp]> = [
    ['SAKAM DA IZNAJMAM STANCE KAJ SACRED HEART CATHOLIC CHURCH', /Катедрала/u],
    ['SAKAM DA IZNAJMAM STANCE KAJ SVETO SRCE', /Катедрала/u],
    ['SAKAM STAN KAJ KATOLICKA KATEDRALA', /Катедрала/u],
  ];
  let i = 0;
  for (const [msg, expected] of said) {
    const { say, sessions, chatId } = makeHandler(`cathedral-name-${i++}`, ROWS);
    await say('ZDRAVO');
    await say(msg);
    const anchor = sessions.get(chatId)!.slots.poiAnchor ?? '';
    assert.match(anchor, expected, `«${msg}» anchors on the cathedral, got ${anchor || 'nothing'}`);
    assert.match(anchor, /Пресвето Срце Исусово/u, `the same row every time, got ${anchor}`);
  }
});

// THE OTHER CHURCH STILL EXISTS. The map files the parish as «Католичка црква
// Свети Јосиф» — the type leads, the saint follows — and the coverage guard
// refuses a name whose first word the client did not say (the rule that keeps
// «ELS Novo Lisice» from answering «vo novo lisice»). A client who names the
// saint must still reach his church, and must never be sent to the cathedral.
test('«кај Свети Јосиф» reaches the parish — the saint is the identity', async () => {
  const said = [
    'SAKAM STAN KAJ SVETI JOSIF',
    'SAKAM STAN KAJ SV. JOSIF',
    'SAKAM STAN KAJ KATOLICKA CRKVA SVETI JOSIF',
  ];
  let i = 0;
  for (const msg of said) {
    const { say, sessions, chatId } = makeHandler(`st-josif-${i++}`, ROWS);
    await say('ZDRAVO');
    await say(msg);
    const anchor = sessions.get(chatId)!.slots.poiAnchor ?? '';
    assert.match(anchor, /Свети Јосиф/u, `«${msg}» is the parish, got ${anchor || 'nothing'}`);
    assert.doesNotMatch(anchor, /Катедрала|Срце/u,
      `«${msg}» is NOT the cathedral: ${anchor}`);
  }
});
