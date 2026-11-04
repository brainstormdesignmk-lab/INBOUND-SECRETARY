/**
 * A+B APPLIED TO ROWS THAT PREDATE THEM (the [22:58] capture round).
 *
 * A stored capture from an older build carries the prose only. The backfill
 * derives its {place} template with the generation predicate — inventory ask,
 * a place the map holds, the place present in the answer, no feed AREA named —
 * and the rendered form must clear the serve-time contract. A row that fails a
 * leg is reported with a reason and left alone: the tool never guesses.
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

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('the backfill never calls a model'); }
}

const ROWS: Property[] = [
  { eb: 53, id: 53, location: 'Аеродром', address: 'Ул. Јане Сандански 1', price: 55000, bedrooms: 1, sqm: 44, size: '44 м²', service: 'buy', lat: 41.9850, lon: 21.4660 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const props = new FakeProps(ROWS);
  const bank = new BankStore(db);
  const handler = new InboundHandler({
    cfg, db, sessions, bank,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  return { handler, bank, sent, sessions };
}

const Q = 'ZDRAVO\nSTO IMTE INTERESNO KAJ KAPITOL MOL ?';
/** The [22:59] prose the operator kept — no template yet (an older capture). */
const ANSWER =
  'Здраво! Во близина на Капитол Мол имаме одлични понуди, па со задоволство би Ви помогнала да го најдеме вистинскиот избор за Вас. Кажете ми, дали Ве интересира купување или изнајмување на недвижност?';
/** District-bound: true only in Аеродром, so it must NEVER become a template. */
const Q_DISTRICT = 'STO IMATE VO AERODROM ?';
const ANSWER_DISTRICT =
  'Во Аеродром имаме одлични понуди. Дали Ве интересира купување или изнајмување на недвижност?';

test('the backfill templates a stored capture and refuses a district-bound one', async () => {
  const { handler, bank, sent } = makeHandler();
  bank.addDynamic('dynamic:idle:sto-imte-interesno', 'idle', Q, ANSWER);
  bank.addDynamic('dynamic:idle:sto-aerodrom', 'idle', Q_DISTRICT, ANSWER_DISTRICT);
  assert.equal(bank.retrievePlaceTemplate('ТЦ Капитол'), undefined, 'nothing templated yet (an older capture)');

  // DRY RUN — reports, writes nothing.
  const dry = await handler.backfillPlaceTemplates();
  const placeRow = dry.find(r => r.msg === Q)!;
  assert.ok(placeRow.template, `the capture is derivable: ${JSON.stringify(placeRow)}`);
  assert.equal(placeRow.written, false, 'a dry run writes nothing');
  assert.equal(placeRow.anchor, 'ТЦ Капитол');
  assert.equal(bank.retrievePlaceTemplate('ТЦ Капитол'), undefined);

  const districtRow = dry.find(r => r.msg === Q_DISTRICT)!;
  assert.equal(districtRow.template, undefined, 'a district-bound answer is never templated');
  assert.match(districtRow.reason ?? '', /district-bound|never names/iu, JSON.stringify(districtRow));

  // APPLY — only the derivable row gets a template.
  const applied = await handler.backfillPlaceTemplates({ apply: true });
  assert.equal(applied.find(r => r.msg === Q)!.written, true);
  assert.equal(applied.find(r => r.msg === Q_DISTRICT)!.written, false);
  assert.ok(bank.retrievePlaceTemplate('ТЦ Капитол'), 'the capture now carries its template');

  // …and the row now serves the SAME place in different words, no model call.
  await handler.handle('test', 'b1', 'STO IMA KAJ KAPITOL MOL ?');
  const served = sent[sent.length - 1] ?? '';
  assert.match(served, /ТЦ Капитол/u, `the backfilled template serves: ${served}`);
  assert.ok(!/\{place\}/u.test(served), `the slot is rendered, never served raw: ${served}`);
});

test('a processed row is audit history — the backfill leaves it alone', async () => {
  const { handler, bank } = makeHandler();
  bank.addDynamic('dynamic:idle:sto-imte-interesno', 'idle', Q, ANSWER);
  const row = bank.dynamicRows(100).find(r => r.msg === Q)!;
  // A promoted/bound row is marked processed: its prose is already settled.
  bank.markDynamicProcessedIfMatches(row.id, Q, ANSWER);
  const report = await handler.backfillPlaceTemplates({ apply: true });
  assert.equal(report.find(r => r.id === row.id), undefined, 'processed rows are not in the report at all');
  assert.equal(bank.retrievePlaceTemplate('ТЦ Капитол'), undefined);
});
