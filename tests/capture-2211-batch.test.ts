/**
 * THE [22:07]–[22:26] BATCH — three questions the funnel answered with
 * something else:
 *
 *   [22:08] ТИ ЌЕ ДОЈДЕШ СО МЕНЕ?
 *   [22:08] ЛИНА: … за разгледување … 300 денари (5 евра) …            ✗
 *   [22:26] КОЛКУ ПАРИ ТРЕБА ДА НОСАМ НА ПОТПИС ЗА ДА ГА ИЗНАЈМАМ 59
 *   [22:26] ЛИНА: Разбирам Вашиот став … 300 денари … преиспитајте     ✗
 *   [22:11] КОЛКУ Е ТОА ПОКВАДРАТ   (after «Станот со ЕБ 69 чини 99.000»)
 *   [22:11] ЛИНА: <a closing line, no number>                          ✗
 *
 * The owner's rules: the presentation is the AGENTS' job («ZA POSETI NA
 * NEDVIZNOSTI SO KLIENTI SE ZADOLZENI AGENTI KOI GI VRSAT PREZENTACIITE.
 * MOJATA RABOTA E KANCELARISKA»); a signing-day question is ARITHMETIC for the
 * named flat; a rate question about ONE flat is that flat's €/м².
 *
 * Each failure had its own cause, all fixed at the source:
 *  1. `detectTotalCostAsk` was true, but the fee-nag predicate also read the
 *     message as resistance («пари» + the ЕВИДЕНТЕН БРОЈ counted as a
 *     fee-sized amount), and the INFO block's price facet claimed it before
 *     the money lane — so the ladder persuaded and the rent was quoted.
 *  2. `detectAgentAttendanceAsk` demanded a viewing noun the bare «со мене?»
 *     does not carry, so the question fell into the fee disclosure.
 *  3. `detectProvisionAsk`'s bare «колку е …» arm matched EVERY how-much
 *     question — «КОЛКУ Е ТОА ПОКВАДРАТ» was read as a commission ask, which
 *     vetoed the INFO rate answer; and the value-ranking lane owned the same
 *     turn as a comparison of the whole batch.
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
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import {
  detectAgentAttendanceAsk, detectFeeNag, detectTotalCostAsk, detectProvisionAsk,
  AGENT_ATTENDS_VIEWING_ANSWER, isFeeTraffic,
} from '../src/llm/deterministic';
import { detectValueAsk } from '../src/llm/recommend';
import { detectInfoFacets } from '../src/llm/infoAnswer';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// EB 59 is the rent flat the client named (950 €/month); EB 69 and 70 are the
// presented pair whose price she quotes.
const ROWS: Property[] = [
  { eb: 59, id: 59, location: 'Центар', price: 950, sqm: 105, size: '105 м²', bedrooms: 2, service: 'rent' },
  { eb: 69, id: 69, location: 'Центар', price: 99000, sqm: 51, size: '51 м²', bedrooms: 2, service: 'buy' },
  { eb: 70, id: 70, location: 'Центар', price: 97000, sqm: 60, size: '60 м²', bedrooms: 2, service: 'buy' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getAllEbs(): Promise<number[]> { return this.rows.map(r => r.eb); }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  async getById(id: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === id || r.id === id);
  }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string, rows: Property[] = ROWS) {
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
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId: id };
}

// ── 1. the signing-day question is arithmetic, never resistance ─────────────

test('[22:26] a cash-at-signing question is a total-cost ask, not a fee nag', () => {
  const t = 'КОЛКУ ПАРИ ТРЕБА ДА НОСАМ НА ПОТПИС ЗА ДА ГА ИЗНАЈМАМ 59';
  assert.equal(detectTotalCostAsk(t), true, 'the signing-day family owns it');
  assert.equal(detectFeeNag(t), false, 'it is not resistance — no rung may burn');
  // The fee OBJECT keeps the ladder: «за посета» is the visit fee's question.
  assert.equal(detectTotalCostAsk('КОЛКУ ПАРИ ТРЕБА ДА НОСАМ ЗА ПОСЕТА ?'), false,
    'a viewing-fee question is not signing arithmetic');
  // The money-BESIDE-amount arm stays: «500DEN SE PARI» restates the fee as money.
  assert.equal(detectFeeNag('500DEN SE PARI'), true);
  assert.equal(detectFeeNag('PARI 500 DENARI ZA POSETA'), true);
  assert.equal(detectFeeNag('КОЛКУ ПАРИ ТРЕБА ДА ИМАМ СО МЕНЕ ЗА ДА ГА ИЗНАЈМАМ 57'), false);
});

test('[22:26] e2e: EB 59 named in the sentence is the anchor — the total is computed', async () => {
  const { say, sessions, chatId } = makeHandler('cash-2211');
  await say('ZDRAVO BARAM DVOSOBEN STAN ZA KIRIJA DO 1000 EVRA');
  await say('CENTAR');
  const before = sessions.get(chatId)!;
  assert.deepEqual(before.slots.presentedIds, [59], 'the rent flat is on the table');

  const reply = await say('КОЛКУ ПАРИ ТРЕБА ДА НОСАМ НА ПОТПИС ЗА ДА ГА ИЗНАЈМАМ 59');

  // 950 → commission 475 (50%), owner side 1.900 (deposit + first rent),
  // total at signing 2.375.
  assert.match(reply, /950 евра/u, `the rent is the anchor: ${reply}`);
  assert.match(reply, /475 евра/u, `the 50% commission for this rent: ${reply}`);
  assert.match(reply, /1\.900 евра/u, `deposit + first rent: ${reply}`);
  assert.match(reply, /2\.375 евра/u, `the total on signing day: ${reply}`);
  assert.ok(!/300 денари|надомест/u.test(reply), `the visit fee was re-sold: ${reply}`);
  const after = sessions.get(chatId)!;
  assert.equal(after.slots.feeRejections ?? 0, 0, 'no fee rung was burned by a money question');
  assert.equal(after.slots.provisionRejections ?? 0, 0, 'and no commission rung either');
});

// ── 2. who comes to the viewing ─────────────────────────────────────────────

test('[22:08] the bare «со мене?» is a viewing question when a flat is on the table', () => {
  assert.equal(detectAgentAttendanceAsk('ТИ ЌЕ ДОЈДЕШ СО МЕНЕ?'), false,
    'cold, the noun is required — the question could be about anything');
  assert.equal(detectAgentAttendanceAsk('ТИ ЌЕ ДОЈДЕШ СО МЕНЕ?', { propertyContext: true }), true);
  assert.equal(detectAgentAttendanceAsk('Дали ти ќе дојдеш со мене на посета?'), true,
    'with the noun it is unambiguous without any context');
  // The owner's copy: agents carry the presentations, the assistant's work is
  // office-based, and the question is WHO comes — never what it costs.
  assert.match(AGENT_ATTENDS_VIEWING_ANSWER, /придруж/u);
  assert.match(AGENT_ATTENDS_VIEWING_ANSWER, /канцелариск/u);
  assert.ok(!/\d/.test(AGENT_ATTENDS_VIEWING_ANSWER), 'no amount in the attendance answer');
  assert.match(AGENT_ATTENDS_VIEWING_ANSWER.trim(), /\?$/u, 'it ends on a question');
});

test('[22:08] e2e: «ТИ ЌЕ ДОЈДЕШ СО МЕНЕ?» is answered by policy, not by the fee', async () => {
  const { say, sessions, chatId } = makeHandler('attend-2211');
  await say('ZDRAVO BARAM DVOSOBEN STAN ZA KIRIJA DO 1000 EVRA');
  await say('CENTAR');
  await say('KOGA MOZE DA GO POSETIME ?');

  const reply = await say('TI KE DOJDES SO MENE?');

  assert.match(reply, /придруж/u, `an agent accompanies the client: ${reply}`);
  assert.match(reply, /канцелариск/u, `her own work is office-based: ${reply}`);
  assert.ok(!/300 денари|5 евра|надомест/u.test(reply),
    `the question was who comes, not what it costs: ${reply}`);
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.feeRejections ?? 0, 0, 'attendance never burns a fee rung');
  assert.notEqual(s.slots.viewingFeeAgreed, true, 'and it is never consent');
});

// ── 3. the rate of the flat she just quoted ─────────────────────────────────

test('[22:11] «КОЛКУ Е ТОА ПОКВАДРАТ» is ONE flat\'s rate, never a batch ranking', () => {
  for (const t of ['КОЛКУ Е ТОА ПОКВАДРАТ', 'КОЛКУ Е ТОА ПО КВАДРАТ', 'kolku e toa po kvadrat']) {
    assert.equal(detectValueAsk(t), false, `a single-flat rate is not a comparison: ${t}`);
  }
  // The comparison asks keep their lane.
  assert.equal(detectValueAsk('koja e cenata za m2?'), true);
  assert.equal(detectValueAsk('koja e podobra vrednost ?'), true);
  assert.equal(detectValueAsk('koj e poevtin po kvadrat?'), true);
  // The commission noun is what the commission detector reads — a how-MUCH
  // question is not it (the bare «колку е …» arm was the false positive).
  assert.equal(detectProvisionAsk('КОЛКУ Е ТОА ПОКВАДРАТ'), false);
  assert.equal(detectProvisionAsk('KOLKU E PROVIZIJATA?'), true);
  // THE VETO MUST NOT LEAK (the [11:07] rent capture, tests/locate-landmark):
  // with the bare «колку е …» arm gone, «КОЛКУ Е КИРИЈАТА И ШТО ПЛАЌАМ ЗА
  // ПОСЕТА?» was no longer commission traffic — and then NOTHING vetoed the
  // INFO block, so the price facet answered the rent alone and the fee half of
  // the question vanished. A pay verb beside a VIEWING noun is fee traffic even
  // without a fee-object noun, so the fee lane keeps the turn and answers both.
  assert.equal(isFeeTraffic('КОЛКУ Е КИРИЈАТА И ШТО ПЛАЌАМ ЗА ПОСЕТА?'), true);
  assert.equal(isFeeTraffic('KOLKU E KIRIJATA I STO PLACKAM ZA POSETA?'), true,
    'the Latin spelling is normalised, never a second grammar');
  // …and the property-money shapes stay OUT (the viewing noun is the fence).
  assert.equal(isFeeTraffic('KOLKU PLACKAM ZA STANOT?'), false);
  assert.equal(isFeeTraffic('КОЛКУ Е КИРИЈАТА?'), false);
  assert.equal(detectInfoFacets('КОЛКУ Е ТОА ПОКВАДРАТ')?.pricePerSqm, true);
});

test('[22:11] e2e: after the price answer, «тоа» is THAT flat — 97.000 / 60 = 1.617', async () => {
  const { say, sessions, chatId } = makeHandler('rate-2211');
  await say('ZDRAVO SAKAM DA KUPAM DVOSOBEN STAN VO CENTAR DO 100000 EVRA');
  const s0 = sessions.get(chatId)!;
  assert.deepEqual(s0.slots.presentedIds, [69, 70], 'the pair is on the table');
  const priced = await say('KAZI MI , KOJA MU BESE POSLEDNATA CENA ?');
  assert.match(priced, /Евидентен број 70 чини 97\.000 евра/u, priced);

  const reply = await say('КОЛКУ Е ТОА ПОКВАДРАТ');

  assert.match(reply, /1\.617/u, `97.000 / 60 м² is the rate he asked for: ${reply}`);
  assert.match(reply, /60 м²/u, `the arithmetic stays checkable: ${reply}`);
  assert.doesNotMatch(reply, /најниска цена за квадрат|Гледано по цена за квадрат/u,
    `a single flat cannot be ranked: ${reply}`);
  assert.doesNotMatch(reply, /Изборот на совршениот дом|индивидуален за секој клиент/u,
    `the closing line is not an answer: ${reply}`);
});
