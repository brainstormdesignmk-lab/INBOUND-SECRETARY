/**
 * THE [20:44]–[21:03] КАТОЛИЧКА CAPTURE — one client, one flat, six turns.
 *
 *   [20:45] ZDRAVO , STO IMATE INTERESNO KAJ KATOLICKA ?
 *   [20:47] ZA IZNAJMUVANJE SUM
 *   [20:47] IMAVTE EDNA GARSONJERA TAMU SO KIRIJA OD 200 EVRA
 *            → «Колку спални соби би Ви одговарале во станот?»   ← a NEW search
 *   [20:54] PRASUVAM ZA GARSONJERA KAJ KATOLICKA GLUPERDO
 *            → served as an ordinary question                     ← no strike
 *   [20:58] DALI E SLOBODNA VO MOMENTOV ?
 *            → a location restatement + a visit offer             ← wrong lane
 *   [21:00] STO DA RAZGLEDAM , LOPOVI STE SITE
 *            → served as an ordinary question                     ← no strike
 *   [21:03] KAKO BE PRODADEN . / TAMAN MISLEV DEKA SUM NASOL STANCE
 *            → «Точно, Станот … се наоѓа во Водно. Дали сакате да организираме
 *              посета?»                                            ← a visit on a SOLD flat
 *
 * Five contracts, one file, because the turns are one conversation:
 *
 *   1. The same place question in FLIPPED word order («NESTO INTERESNO KAJ X
 *      IMATE ?» / «IMATE NESTO … KAJ X ?») is the place-stock ask, never cards.
 *   2. A flat the client DESCRIBES (гарсоњера, 200 евра, ТАМУ = the place bound
 *      one turn earlier) is a RECALL: serve the compatible options and ask which
 *      one it was — never a bedrooms questionnaire for a new search.
 *   3. «DALI E SLOBODNA VO MOMENTOV ?» is an AVAILABILITY ask (the «во» is not a
 *      place): the ack + the owner-confirm question, never area advice and
 *      never a location restatement with a visit offer.
 *   4. GLUPERDO and «LOPOVI STE SITE» spend a strike and serve the
 *      professional-tone warning; a THIRD-PARTY «sopstvenikot e lopov» does not.
 *   5. A SOLD flat is never offered for a visit: reacting to the sale gets the
 *      owner's market-is-alive line + the alternatives question.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
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
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { classifyOffensive } from '../src/antiabuse/offensive';
import { detectInventoryAsk, extractInventoryPlace } from '../src/llm/deterministic';

const cfg = loadConfig();
const hasMap = !!cfg.skopjePoisDb && fs.existsSync(cfg.skopjePoisDb);

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

function makeHandler(id: string) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new PropertyService(cfg.propertyDataUrl);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId: id, handler, sent };
}

// ── 1. the flipped-order place ask ──────────────────────────────────────────

test('[20:44] the flipped word order is the SAME place question', () => {
  const SHAPES = [
    'ZDRAVO , NESTO INTERESNO KAJ KATOLICKA IMATE ?',   // verb TRAILING
    'IMATE NESTO INTERESNO KAJ KATOLICKA ?',           // verb LEADING, no «ли»
    'NESTO INTERESNO KAJ TRI BISERI IMATE ?',
    'ZDRAVO , STO INTERESNO IMATE KAJ KATOLICKA ?',
  ];
  for (const t of SHAPES) {
    assert.equal(detectInventoryAsk(t), true, `the flipped shape is not an inventory ask: ${t}`);
    assert.ok(extractInventoryPlace(t), `the place is not read: ${t}`);
    // …and the trailing have-verb is GRAMMAR, never part of the place name.
    assert.doesNotMatch(extractInventoryPlace(t)!, /IMATE|imate/i,
      `the have-verb leaked into the place: ${t} → ${extractInventoryPlace(t)}`);
  }
  // A feature question is still not an inventory ask (the guard that keeps
  // this arm from swallowing «имате паркинг во зградата?»).
  assert.equal(detectInventoryAsk('IMATE PARKING VO ZGRADATA ?'), false);
});

test('[20:44] e2e: the flipped shape gets prose + the market question, no cards',
  { skip: !hasMap && 'no offline map' }, async () => {
    const { say, sessions, chatId } = makeHandler('flip');
    const reply = await say('ZDRAVO , NESTO INTERESNO KAJ KATOLICKA IMATE ?');
    assert.doesNotMatch(reply, /Евидентен број/u, `no card before the market is known: ${reply}`);
    assert.match(reply, /(?:куп|набав)\p{L}*[\s\S]{0,80}изнајм|изнајм\p{L}*[\s\S]{0,80}(?:куп|набав)/iu,
      `the market question is the funnel step: ${reply}`);
    const s = sessions.get(chatId)!;
    assert.match(String(s.slots.poiAnchor ?? ''), /католич/iu, `the place was not bound: ${s.slots.poiAnchor}`);
    assert.equal(s.slots.inventoryPending, true, 'the type is still owed');
  });

// ── 2. the described flat is a recall, not a new search ─────────────────────

test('[20:47] e2e: a flat described by type+price+«таму» serves THAT flat',
  { skip: !hasMap && 'no offline map' }, async () => {
    const { say, sessions, chatId } = makeHandler('described');
    await say('ZDRAVO , STO IMATE INTERESNO KAJ KATOLICKA ?');
    await say('ZA IZNAJMUVANJE SUM');
    const reply = await say('IMAVTE EDNA GARSONJERA TAMU SO KIRIJA OD 200 EVRA');
    // The flat he saw: гарсоњера, 200 евра, at the place the chat already holds.
    assert.match(reply, /гарсоњера/iu, `the described category is served: ${reply}`);
    assert.match(reply, /200/u, `the remembered price is served: ${reply}`);
    assert.match(reply, /Дали некој од овие|Дали некоја од овие|или „вториот"/u,
      `the which-one ask is the recall closer: ${reply}`);
    // The capture's defect: a NEW-search questionnaire (bedrooms) over a flat he
    // had already seen.
    assert.doesNotMatch(reply, /[Кк]олку спални|[Кк]олкав број на спални/u,
      `a criteria ask over a described flat: ${reply}`);
  });

// ── 3. the availability ask owns its turn ───────────────────────────────────

test('[20:58] e2e: «SLOBODEN LI E VO MOMENTOV?» is the availability ack',
  { skip: !hasMap && 'no offline map' }, async () => {
    for (const ask of ['DALI E SLOBODNA VO MOMENTOV ?', 'SLOBODEN LI E VO MOMENTOV ?']) {
      const { say, chatId, sessions } = makeHandler(`avail-${ask.length}`);
      await say('ZDRAVO , STO IMATE INTERESNO KAJ KATOLICKA ?');
      await say('ZA IZNAJMUVANJE SUM');
      await say('IMAVTE EDNA GARSONJERA TAMU SO KIRIJA OD 200 EVRA');
      const reply = await say(ask);
      assert.match(reply, /би требало|Би требало|сеуште|сè уште/iu,
        `${ask}: the availability ack is the answer: ${reply}`);
      assert.match(reply, /сопственик/u, `${ask}: the owner-confirm question is owed: ${reply}`);
      // The two lanes this turn used to fall into.
      assert.doesNotMatch(reply, /Сите делови на градот|Сите локации|најважно/iu,
        `${ask}: area advice answered an availability question: ${reply}`);
      assert.doesNotMatch(reply, /Дали сакате да организираме посета/u,
        `${ask}: a visit offer replaced the availability answer: ${reply}`);
      assert.ok(sessions.get(chatId)!.slots.interestedPropertyId !== undefined,
        `${ask}: the flat under discussion is not on file`);
    }
  });

// ── 4. the two offences ─────────────────────────────────────────────────────

test('[20:54]/[21:00] GLUPERDO and «LOPOVI STE SITE» spend a strike', () => {
  for (const t of ['PRASUVAM ZA GARSONJERA KAJ KATOLICKA GLUPERDO',
    'STO DA RAZGLEDAM , LOPOVI STE SITE', 'ЛОПОВИ СТЕ СИТЕ', 'VIE STE LOPOVI', 'gluperdo']) {
    assert.equal(classifyOffensive(t).isOffensive, true, `not caught as an offence: ${t}`);
  }
  // A client accusing the OWNER (or saying something is silly) is not a jab at
  // the agent — the strike family is second-person/directed only.
  for (const t of ['SOPSTVENIKOT E LOPOV', 'GLUPO E DA SE CRIES', 'NE ZNAM KONKRETEN STAN']) {
    assert.equal(classifyOffensive(t).isOffensive, false, `innocent client words struck: ${t}`);
  }
});

test('[20:54] e2e: the offence gets the professional-tone warning, not a serve',
  { skip: !hasMap && 'no offline map' }, async () => {
    const { say } = makeHandler('offence');
    await say('ZDRAVO , STO IMATE INTERESNO KAJ KATOLICKA ?');
    const reply = await say('PRASUVAM ZA GARSONJERA KAJ KATOLICKA GLUPERDO');
    assert.match(reply, /професионал/iu, `the tone warning is not served: ${reply}`);
    assert.doesNotMatch(reply, /Евидентен број/u, `a card answered an insult: ${reply}`);
  });

// ── 5. the sold flat ────────────────────────────────────────────────────────

test('[21:03] e2e: reacting to a SALE gets the market line, never a visit',
  { skip: !hasMap && 'no offline map' }, async () => {
    const h = makeHandler('sold');
    await h.say('ZDRAVO , STO IMATE INTERESNO KAJ KATOLICKA ?');
    await h.say('ZA IZNAJMUVANJE SUM');
    await h.say('IMAVTE EDNA GARSONJERA TAMU SO KIRIJA OD 200 EVRA');
    await h.say('PRVIOT');
    await h.say('DA, SE SOGLASUVAM');
    await h.say('DALI E SLOBODNA VO MOMENTOV ?');
    await h.say('DA');
    await h.say('ZORAN 078/914 196');
    await h.say('UTRE POPLADNE POSLE 6');
    const eb = Number(h.sessions.get(h.chatId)!.slots.interestedPropertyId);
    assert.ok(Number.isFinite(eb) && eb > 0, 'setup: no flat under discussion');

    const before = h.sent.length;
    h.handler.ownerFollowup(h.chatId, eb, { status: 'gone', note: 'продадена' });
    for (let i = 0; i < 40 && h.sent.length === before; i++) await new Promise(r => setTimeout(r, 25));
    assert.match(h.sent.at(-1) ?? '', /продадена/u, `the gone relay did not run: ${h.sent.at(-1)}`);
    assert.match(h.sent.at(-1) ?? '', /нешто друго/u, 'the gone relay must end with the alternative offer');

    // The client absorbs the news — and must NOT be invited to a visit.
    for (const reaction of ['KAKO BE PRODADEN .', 'TAMAN MISLEV DEKA SUM NASOL STANCE']) {
      const reply = await h.say(reaction);
      assert.match(reply, /жива материја/u, `${reaction}: the market line is the answer: ${reply}`);
      assert.match(reply, /нешто друго/u, `${reaction}: the alternatives question is owed: ${reply}`);
      assert.doesNotMatch(reply, /организираме посета|да го погледнете/u,
        `${reaction}: a VISIT was offered for a sold flat: ${reply}`);
    }
  });
