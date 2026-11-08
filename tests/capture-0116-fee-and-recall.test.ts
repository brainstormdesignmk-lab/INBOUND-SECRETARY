/**
 * THE [01:2x] CAPTURE — the money burst and the which-flat recall.
 *
 *   [01:2x] PARI ZA POSETA
 *           NESTO NOVO A ?                                     ← rung not burned
 *   [01:2x] ЛИНА: «Дали Ви се допаѓа некој од овие станови?…»   ← answered with
 *                                                                  properties
 *   [01:2x] ZA KOJ STAN TI KAZAV DA DOGOVORIS PREESKA ?         ← contact ask
 *   [01:2x] ЛИНА: «Ве молам споделете ги Вашето име и презиме…»
 *
 *   1. THE OPTIONS-ASK VETO WAS UNSCOPED. A fee jab riding a shopping ask was
 *      kept off the ladder so a client who had ALREADY heard the fee could not
 *      climb another rung — but the veto also fired for a client who had never
 *      been told it, so «PARI ZA POSETA / NESTO NOVO» was answered with the
 *      drained-options line and feeRejections stayed 0. The veto now applies
 *      only once the fee was actually put to him.
 *   2. A WHICH-FLAT RECALL IS NOT A VISIT ORDER. «ZA KOJ STAN TI KAZAV DA
 *      DOGOVORIS PREESKA ?» carries a flat noun and договори, so the
 *      fee-agreement lane read it as consent and opened contact collection.
 *      The arrangement already knows the flat — the answer is the ЕБ.
 *   3. THE VISIT QUESTION MUST NAME ITS FLAT: the fee script is generic, so a
 *      client shown two flats could not tell which visit he was agreeing to.
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
import { BankStore } from '../src/store/bank';
import { detectArrangementRecall } from '../src/llm/deterministic';
import { arbitrateMoney } from '../src/llm/moneyArbitration';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ROWS: Property[] = [
  { eb: 53, id: 53, location: 'Аеродром', address: 'Бисер', price: 55000, bedrooms: 2, sqm: 44, size: '44 м²', service: 'buy', lat: 41.9851, lon: 21.4658 },
  { eb: 89, id: 89, location: 'Аеродром', address: 'Парк Авионче', price: 110000, bedrooms: 2, sqm: 70, size: '70 м²', service: 'buy', lat: 41.9894, lon: 21.4768 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string, opts: { appointmentFor?: number } = {}) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const appointments = new AppointmentStore(db);
  if (opts.appointmentFor !== undefined) {
    appointments.insert({
      chatId: id, clientName: 'DIJANA', clientPhone: '078456712',
      propertyId: opts.appointmentFor, service: 'buy', viewingFee: '500',
      time: 'Четврток, 12.11.2026 во 19:00', agentPhone: '076247467',
    });
  }
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions, bank: new BankStore(db),
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS),
    appointments, escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  return { handler, sessions, sent, chatId: id, appointments };
}

// ── 1. THE MONEY BURST AT LAST BURNS A RUNG ────────────────────────────────

test('[01:2x] the options-ask veto only applies once the fee was told', () => {
  const ctx = {
    state: 'presentation', propertyOnTable: true, feeAgreed: false,
    feeBlocked: false, provisionBlocked: false,
  };
  const burst = 'PARI ZA POSETA\nNESTO NOVO A ?';
  // Never told the fee → the money phrase is the client's question about it.
  assert.equal(arbitrateMoney(burst, { ...ctx, feeTold: false }).lane, 'nag');
  // Already told (a repeat jab riding a shopping ask) → no extra rung.
  assert.notEqual(arbitrateMoney(burst, { ...ctx, feeTold: true }).lane, 'nag');
});

test('[01:2x] «PARI ZA POSETA / NESTO NOVO A ?» burns rung 1, never the options line', async () => {
  const { handler, sent, sessions, chatId } = makeHandler('capture-0116-nag');
  await handler.handle('test', chatId, 'SAKAM DA KUPAM DVOSOBEN STAN KAJ BISER ILI KAPITOL');
  await handler.handle('test', chatId, 'DO 120000');
  await handler.handle('test', chatId, 'PARI ZA POSETA\nNESTO NOVO A ?');
  const answer = sent[sent.length - 1] ?? '';
  assert.equal(sessions.get(chatId)!.slots.feeRejections, 1,
    'the fee jab is a nag and must advance the ladder');
  assert.doesNotMatch(answer, /поскапо/u,
    `a fee objection is never answered with more properties: ${answer}`);
  assert.match(answer, /денари/u,
    `the rung states the charge it is defending: ${answer}`);
});

// ── 2. WHICH FLAT WAS THE ARRANGEMENT FOR ──────────────────────────────────

test('[01:2x] the arrangement recall is its own question, not a visit order', () => {
  assert.equal(detectArrangementRecall('ZA KOJ STAN TI KAZAV DA DOGOVORIS PREESKA ?'), true);
  assert.equal(detectArrangementRecall('ЗА КОЈ СТАН ТИ КАЖАВ ДА ДОГОВОРИШ ВЧЕРА?'), true);
  assert.equal(detectArrangementRecall('ZA KOJ STAN DOGOVORIVME TERMIN ?'), true);
  // A COMMAND names no choice — it orders one.
  assert.equal(detectArrangementRecall('DOGOVORI GO 69'), false);
  // A where-is question carries no arranging verb.
  assert.equal(detectArrangementRecall('ZA KOJ STAN E ?'), false);
  // An ordinary visit order is not a recall either.
  assert.equal(detectArrangementRecall('SAKAM DA GO POSETAM STANOT'), false);
});

test('[01:2x] the recall names the booked ЕБ instead of asking for the phone', async () => {
  const { handler, sent, chatId } = makeHandler('capture-0116-recall', { appointmentFor: 69 });
  await handler.handle('test', chatId, 'ZA KOJ STAN TI KAZAV DA DOGOVORIS PREESKA ?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /Евидентен број 69/u,
    `the answer is the flat he arranged: ${answer}`);
  assert.match(answer, /12\.11\.2026/u, `and the arranged term: ${answer}`);
  assert.doesNotMatch(answer, /телефон|име и презиме/u,
    `the client is checking a booking — never asked for contact details: ${answer}`);
});

test('[01:2x] with no booking the recall says so and asks which flat', async () => {
  const { handler, sent, chatId } = makeHandler('capture-0116-recall-none');
  await handler.handle('test', chatId, 'ZA KOJ STAN TI KAZAV DA DOGOVORIS PREESKA ?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /Немам забележано/u, `an honest miss: ${answer}`);
  assert.doesNotMatch(answer, /телефон/u, `still never the contact ask: ${answer}`);
});

// ── 3. THE VISIT QUESTION NAMES ITS FLAT ───────────────────────────────────

test('[01:2x] the fee/visit question names the flat it is about', async () => {
  const { handler, sent, chatId } = makeHandler('capture-0116-subject');
  await handler.handle('test', chatId, 'SAKAM DA KUPAM DVOSOBEN STAN KAJ BISER ILI KAPITOL');
  await handler.handle('test', chatId, 'DO 120000');
  await handler.handle('test', chatId, 'SAKAM DA JA POSETAM 53');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /Евидентен број 53/u,
    `the client must know WHICH visit he is being asked about: ${answer}`);
  assert.match(answer, /Аеродром/u, `and where it is: ${answer}`);
});
