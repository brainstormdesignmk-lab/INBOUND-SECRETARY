// The [00:05]–[00:08] live burst, pinned end to end.
//
//   [00:05] the batch is on screen, the client says E OVOJ MOZE
//   [00:06] Lina discloses the fee and moves to closing
//   [00:06] ZA KOJ STAN STANUVA ZBOR ? WRONG ANSWER
//           → she repeated the fee instead of naming the flat
//   [00:07] MA KAKVI 500 DEN , DALI SI TI NORMALNA
//           → answered with ANOTHER fee persuasion (no strike, an offence
//             answered as if it were a fee objection)
//   [00:07] NAGING WRONGLY ROUTED
//   [00:08] KOJA SIMBOLICNA CENA . 500DEN SE PARI
//           → answered with the FLAT's price (133.000) instead of the fee
//
// Four obligations, one transcript:
//   1. the CHOICE arms the flat and hands the turn to the fee question — never
//      to contact collection before the money gate;
//   2. the WHICH-question answers with EB + neighbourhood + price and asks
//      whether the choice stands (property.which.anchor, filled at serve time);
//   3. a directed insult is the STRIKE, not fee resistance — the strike ladder
//      must win over every other lane, even when the insult carries "500 DEN";
//   4. "koja simbolichna cena" / "500 DEN SE PARI" is a FEE objection and
//      climbs the ladder — it must never be read as a property-price ask.
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
import { setLearnedBank } from '../src/data/responseBank';
import { detectWhichPropertyAsk, detectPropertyChoice } from '../src/llm/deterministic';
import { classifyOffensive } from '../src/antiabuse/offensive';
import { OFFENSE_WARNINGS } from '../src/antiabuse/strikes';

setLearnedBank({
  variants: () => [],
  addVariant: () => false,
  addExample: () => false,
  metric: () => {},
  retrieve: () => undefined,
} as any);

class FailingLlm { async complete(): Promise<string> { throw new Error('429'); } }
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

// EB 88 verbatim from the transcript: Аеродром, 68 м², 133.000 евра.
const ROWS: Property[] = [
  {
    eb: 88, id: 88, location: 'Аеродром', price: 133000, service: 'buy',
    bedrooms: 3, size: '68 м²', address: 'Аеродром',
    lift: true, heating: 'Парно', parking: 'Јавен паркинг', furnished: true,
  },
] as unknown as Property[];

async function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm() as any, cfg, properties),
    responder: new Responder(new FailingLlm() as any, cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { sessions, sent,
    send: async (chatId: string, m: string) => {
      await Promise.race([
        handler.handle('test', chatId, m),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`turn timeout (>10s): ${m.slice(0, 40)}`)), 10_000).unref()),
      ]);
      return { session: sessions.get(chatId)!, reply: sent.at(-1) ?? '' };
    } };
}

// ── Detector pins ────────────────────────────────────────────────────────────

test('which-flat family: the question about the anchor is recognised in both scripts', () => {
  for (const t of [
    'ZA KOJ STAN STANUVA ZBOR ?', 'za koj stan stanuva zbor', 'ЗА КОЈ СТАН СТАНУВА ЗБОР ?',
    'ZA KOJ STAN ZBORUVAME', 'за кој стан зборуваме?', 'koj stan go odbravme',
    'КОЈ СТАН ГО ИЗБРАВМЕ?', 'koj stan e toa?', 'кое е станот?',
    'za stanot sto go odbravte', 'ЗА СТАНОТ ШТО ГО ОДБРАВТЕ',
    'koj stan mi go pokazavte?',
  ]) assert.equal(detectWhichPropertyAsk(t), true, `not recognised: ${t}`);

  // A money question is never this family — its own lanes own the amount.
  for (const t of ['ZA KOJ STAN E 500 DENARITE?', '500DEN ZA POSETA ?', 'E OVOJ MOZE', 'DALI SI TI NORMALNA']) {
    assert.equal(detectWhichPropertyAsk(t), false, `false positive: ${t}`);
  }
});

test('property-choice family: "this one works" arms the flat, bare consent and fee traffic do not', () => {
  for (const t of ['E OVOJ MOZE', 'e ovoj moze', 'ОВОЈ МОЖЕ', 'ova mi se dopagja', 'moze ovoj']) {
    assert.equal(detectPropertyChoice(t), true, `not recognised: ${t}`);
  }
  for (const t of ['moze', 'da', '500 den moze?', 'DALI SI TI NORMALNA', 'koja e cenata?']) {
    assert.equal(detectPropertyChoice(t), false, `false positive: ${t}`);
  }
});

test('[00:07] "DALI SI TI NORMALNA" is a directed insult (heavy_insult, severity 2)', () => {
  for (const t of ['DALI SI TI NORMALNA', 'dali si ti normalna', 'ДАЛИ СИ ТИ НОРМАЛНА', 'si ti normalna?']) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, JSON.stringify(t) + ' must fire');
    assert.equal(d.category, 'heavy_insult', JSON.stringify(t));
    assert.equal(d.severity, 2, JSON.stringify(t));
  }
  // Asking about a PRICE being normal is a money question, never a strike.
  for (const t of ['normalna cena e ovaa?', 'дали е нормална цената?', 'dali e normalna cenata za Aerodrom']) {
    assert.equal(classifyOffensive(t).isOffensive, false, JSON.stringify(t) + ' must stay clean');
  }
});

// ── The transcript, end to end ───────────────────────────────────────────────

test('[00:05]–[00:08] the live burst answers the flat, the strike and the fee — each in its own lane', async () => {
  const { send } = await makeHandler();
  const chat = 'burst-0005';

  await send(chat, 'ZDRAVO');
  await send(chat, 'SAKAM DA KUPAM STAN VO AERODROM DO 150.000 EVRA');
  await send(chat, 'ZA EB 88');

  // 1 · the choice arms the flat and discloses the fee — never contact collection
  const pick = await send(chat, 'E OVOJ MOZE');
  assert.equal(pick.session.state, 'closing', `choice must enter closing: ${pick.reply}`);
  assert.equal(pick.session.slots.interestedPropertyId, 88, 'choice must arm EB 88');
  assert.match(pick.reply, /500 денари/u, `the fee must be disclosed: ${pick.reply}`);
  assert.ok(!/Вашето име|телефонски|број за контакт/iu.test(pick.reply),
    `contact collection must never precede the money gate: ${pick.reply}`);

  // 2 · WHICH flat — name EB + neighbourhood + price, ask whether it stands
  const which = await send(chat, 'ZA KOJ STAN STANUVA ZBOR ?');
  assert.match(which.reply, /88/u, `must name the EB: ${which.reply}`);
  assert.match(which.reply, /Аеродром/u, `must name the neighbourhood: ${which.reply}`);
  assert.match(which.reply, /133\.000/u, `must name the price: ${which.reply}`);
  assert.match(which.reply, /\?\s*$/u, `must ask whether the choice stands: ${which.reply}`);
  assert.ok(!/500 денари|10 евра/u.test(which.reply),
    `the fee must not be repeated instead of the anchor: ${which.reply}`);
  assert.equal(which.session.state, 'closing');

  // 3 · the insult is a STRIKE, not fee resistance
  const insult = await send(chat, 'MA KAKVI 500 DEN , DALI SI TI NORMALNA');
  assert.equal(insult.session.strikes, 1, `the insult must record a strike: ${insult.reply}`);
  assert.ok(OFFENSE_WARNINGS[1]?.includes(insult.reply) || /професионал/u.test(insult.reply),
    `a strike-1 warning belongs here: ${insult.reply}`);
  assert.ok(!/500 денари|10 евра|провизиј/u.test(insult.reply),
    `an offence must never be answered with fee persuasion: ${insult.reply}`);

  // 4 · "koja simbolichna cena / 500 den se pari" is a FEE objection
  const fee = await send(chat, 'KOJA SIMBOLICNA CENA . 500DEN SE PARI');
  assert.match(fee.reply, /500 денари|10 евра/u, `the fee objection belongs to the ladder: ${fee.reply}`);
  assert.ok(!/133\.000|133000/u.test(fee.reply),
    `the FLAT's price must never answer a fee objection: ${fee.reply}`);
  assert.equal(fee.session.state, 'closing');
  assert.ok((fee.session.slots.feeRejections ?? 0) >= 1, 'the objection must burn a ladder rung');
});
