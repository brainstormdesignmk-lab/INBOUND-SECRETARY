// THE [23:2x] FIELD TRANSCRIPT — two turns inside the one-kilometre ring.
//
//   [23:25] ЛИНА: «Тоа е недвижноста на 1,3 km од Лептокарија: Евидентен број
//           77 — двособен стан, во Центар, 45 м², 130.000 евра. Сакате ли да Ви
//           ја опишам подетално, или да закажеме посета?»
//   [23:25] КЛИЕНТ: «ОВОЈ НЕ Е ЛОШ»
//   [23:25] ЛИНА: …the place-ring paragraph about Лептокарија again…
//   [23:26] КЛИЕНТ: «ОПИШЕТЕ МИ ЈА ВЕ МОЛАМ»
//   [23:26] ЛИНА: the card of EB 54 (Карпош III, 35 м², 69.500) — the WRONG flat.
//
// Two independent causes:
//   1. The generated rejection literal «ovoj ne» (data/hardening/rejection.json
//      row "ovoj ne") was emitted as a SUBSTRING match, so it fired inside
//      «ОВОЈ НЕ Е ЛОШ» — an understated POSITIVE. detectPositiveEval is vetoed
//      by detectRejection, so the praise lane never ran and the pending ring
//      ask re-served its paragraph. The generator now folds its STOP list (the
//      Latin entries never matched the folded tokens) and matches a bare,
//      content-word-less literal as the WHOLE message.
//   2. The ring-row answer presented ONE flat but only moved `propertyId`;
//      the describe lane reads the DESCRIBED table first and served the flat
//      from a batch two turns earlier.
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
import { LlmClient } from '../src/llm/types';
import { detectPositiveEval, detectRejection, detectUnderstatedPositive } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// EB 77 is the flat the ring row names (Центар, 45 м², 130.000). EB 54 is the
// stale card from the earlier batch (Карпош III, 35 м², 69.500).
const ROWS: Property[] = [
  { eb: 77, id: 77, location: 'Центар', address: 'У. Македонија', price: 130000,
    bedrooms: 2, sqm: 45, size: '45 м²', service: 'buy', lat: 41.9945, lon: 21.4310 },
  { eb: 54, id: 54, location: 'Карпош III', address: 'У. Јане Сандански', price: 69500,
    bedrooms: 1, sqm: 35, size: '35 м²', service: 'buy', lat: 42.0040, lon: 21.3930 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  async getById(id: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === id || r.id === id);
  }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: undefined,
  } as never);
  const chatId = 'field-ring';
  const send = async (m: string) => {
    await handler.handle('test', chatId, m);
    return { session: sessions.get(chatId)!, reply: sent[sent.length - 1] ?? '' };
  };
  // The state the ring left behind: the widen question is open and EB 54's
  // batch is still in the described table.
  const primeRing = () => {
    const s = sessions.get(chatId);
    if (!s) return;
    s.state = 'presentation';
    s.slots.service = 'buy';
    s.slots.propertyId = 54;
    s.slots.interestedPropertyId = 54;
    s.slots.describedEbs = [54];
    s.slots.currentBatch = [54];
    s.slots.presentedIds = [54];
    s.slots.poiAnchor = 'Лептокарија';
    s.slots.poiTooFarAsk = true;
    s.slots.poiTooFarAnchor = 'Лептокарија';
    s.slots.poiNearestId = 77;
    s.slots.poiNearestM = 1300;
    sessions.set(s);
  };
  return { send, sessions, primeRing, chatId };
}

test('«ОВОЈ НЕ Е ЛОШ» is an understated positive, never a rejection', () => {
  for (const m of ['ОВОЈ НЕ Е ЛОШ', 'OVOJ NE E LOS', 'Овој не е лош .']) {
    assert.equal(detectRejection(m), false, `not a rejection: ${m}`);
    assert.equal(detectPositiveEval(m), true, `a positive evaluation: ${m}`);
    assert.equal(detectUnderstatedPositive(m), true, `understated, not a pick: ${m}`);
  }
  // A real rejection keeps firing, including the bare elliptical one.
  assert.equal(detectRejection('OVOJ NE'), true);
  assert.equal(detectRejection('ne mi se dopaga ovoj'), true);
  // Clear praise is NOT understated (it keeps property.liked).
  assert.equal(detectUnderstatedPositive('ODLICEN IZBOR'), false);
});

test('[23:25] the weak approval gets the clientele/visit theme, never the ring again', async () => {
  const { send, primeRing } = makeHandler();
  await send('ZDRAVO');
  primeRing();
  // The transcript's own order: the ring row is named first, so EB 77 is the
  // flat on the table when the client evaluates it.
  await send('КОЈ Е ТОЈ СТАН НА 1.3КМ?');
  const { session, reply } = await send('ОВОЈ НЕ Е ЛОШ');
  // The owner-dictated theme: every property has its clientele, it must be
  // seen live, and the close offers the visit. Wording rotates (seed +
  // learned variants), so the assertion is the contract, not one sentence.
  // „Објекта треба да го осетите на лице место…" is one of the pool's approved
  // lines and names the thing as „објект" — the theme is the SUBJECT, not the
  // one noun.
  assert.match(reply, /недвижн|објект|простор/iu, `the property theme expected: ${reply}`);
  assert.match(reply, /(во живо|лично|на лице место|во живо)/iu, `see it live expected: ${reply}`);
  // The THEME's invariant is the visit offer, in any of its wordings. Two of
  // the pool's lines are the owner's own verbatim closes («…би сакале да ја
  // посетите, и јас ќе договорам се.») — they close declaratively, so a
  // „must end with ?" assertion would fail on copy the owner dictated by hand.
  assert.match(reply, /(посет|закаж|разглед|термин|видите|види)/iu, `the visit offer expected: ${reply}`);
  assert.ok(!/подалеку|друга населба|Лептокарија/iu.test(reply),
    `the place-ring paragraph must not be re-served: ${reply}`);
  // The flat on the table stays the subject, and the funnel is armed.
  assert.equal(session.slots.interestedPropertyId, 77, 'the ring row is the flat under discussion');
  assert.equal(session.state, 'closing');
});

test('[23:25] the ring row becomes the table: «ОПИШЕТЕ МИ ЈА» describes EB 77, never EB 54', async () => {
  const { send, primeRing } = makeHandler();
  await send('ZDRAVO');
  primeRing();
  const named = await send('КОЈ Е ТОЈ СТАН НА 1.3КМ?');
  assert.match(named.reply, /Евидентен број 77/u, `the ring row must be named: ${named.reply}`);
  assert.equal(named.session.slots.propertyId, 77);
  assert.equal(named.session.slots.askedEb, 77, 'the asked record must follow the ring row');
  assert.deepEqual(named.session.slots.describedEbs, [77], 'the ring row IS the table now');

  const desc = await send('ОПИШЕТЕ МИ ЈА ВЕ МОЛАМ');
  assert.match(desc.reply, /Евидентен број 77/u, `must describe the named flat: ${desc.reply}`);
  assert.doesNotMatch(desc.reply, /Евидентен број 54|35 м²|Карпош/iu,
    `the stale batch card must never be described: ${desc.reply}`);
});
