// The [17:14] transcript bug, pinned permanently.
//
// What happened: mid-discovery the client answered the area question with
// "PA AERODROM ILI KISELA VODA BI ODGOVARALO NAJMNOGU", then followed with
// "POMALO NESTO DO 300EVRA". "помало нешто" is a see-offers phrase, so the
// deterministic funnel override rebuilt the event as a BARE
// { type: 'SEARCH_REQUESTED' } — silently discarding the budget the original
// event carried (extractSlots("…DO 300EVRA") = budget "300"). applySlots had
// nothing to store, the presentation ran budget-less, and the ladder served
// a 380€ four-bedroom against an explicit ≤300 ask.
//
// The fix: the three bare-rebuild overrides in deterministicClassify
// (see-offers, suggest-alternatives, mentionsMore) plus the LLM-path
// see-offers twin now recompute the event WITH the message's own criteria
// (recomputeSearchEvent) — deterministic slots stay the single source of
// truth. The LadderKey shows it: …|rent|300| (budget present), and the
// budget hard filter (p.price <= max) makes an over-budget card impossible.
import { test } from 'node:test';
import assert from 'node:assert';
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

class FailingLlm implements LlmClient { async complete(): Promise<string> { throw new Error('429'); } }
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

function makeRows(): Property[] {
  return [
    { eb: 61, id: 61, location: 'Аеродром', price: 380, service: 'rent', bedrooms: 4, size: '78 м²' },
    { eb: 62, id: 62, location: 'Аеродром', price: 250, service: 'rent', bedrooms: 1, size: '32 м²' },
    { eb: 63, id: 63, location: 'Аеродром', price: 280, service: 'rent', bedrooms: 2, size: '45 м²' },
    { eb: 64, id: 64, location: 'Аеродром', price: 295, service: 'rent', bedrooms: 3, size: '60 м²' },
    { eb: 65, id: 65, location: 'Аеродром', price: 420, service: 'rent', bedrooms: 5, size: '95 м²' },
    { eb: 66, id: 66, location: 'Кисела Вода', price: 260, service: 'rent', bedrooms: 2, size: '48 м²' },
  ] as unknown as Property[];
}

async function makeHandler(rows: Property[]) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const classifier = new Classifier(new FailingLlm(), cfg, properties);
  const responder = new Responder(new FailingLlm(), cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder,
    properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent,
    send: async (chatId: string, m: string) => { await handler.handle('test', chatId, m); return sent.at(-1) ?? ''; } };
}

test('[17:14] see-offers with a budget keeps the budget: ladder serves in-budget only, never the 380€ card', async () => {
  // NOTE (pomalo layer): "POMALO NESTO …" now ASKS the bedrooms question
  // (size intent — tests/pomalo-size.test.ts). The budget-preservation
  // contract on the SEE-OFFERS lane is pinned here with a non-pomalo phrase.
  const { send, sessions } = await makeHandler(makeRows());
  const chat = 'see-budget';
  await send(chat, 'SAKAM DA IZNAJMAM STAN');
  await send(chat, 'PA AERODROM ILI KISELA VODA BI ODGOVARALO NAJMNOGU');
  const r = await send(chat, 'STO IMATE VO PONUDA DO 300EVRA');
  const s = sessions.get(chat)!;

  // The ≤300 budget landed (it used to be silently dropped).
  assert.equal(s.slots.budget, '300');
  // The ladder key carries it — the queue was built budget-aware.
  assert.ok(s.slots.ladderKey?.includes('300'), `ladderKey must embed the budget, got: ${s.slots.ladderKey}`);
  // The batch is in-budget: every card ≤ 300, and 380 never serves.
  assert.ok(s.slots.currentBatch && s.slots.currentBatch.length > 0, 'a batch was presented');
  for (const id of s.slots.currentBatch) {
    const row = makeRows().find(p => p.id === id)!;
    assert.ok((row.price as number) <= 300, `EB ${id} at ${row.price}€ exceeds the ≤300 ask`);
  }
  assert.ok(!s.slots.currentBatch.includes(61), 'EB 61 (380€) must never serve against ≤300');
  assert.ok(!r.includes('61'), 'the 380€ card must not appear in the reply');
  assert.ok(r.length > 0);
});

test('[17:14] budget-only correction in presentation state also keeps its budget (pure correction path)', async () => {
  // Same shape as "A ZA 250?" — presentation + a budget and nothing else.
  const { send, sessions } = await makeHandler(makeRows());
  const chat = 'pres-budget';
  await send(chat, 'SAKAM DA IZNAJMAM STAN');
  await send(chat, 'PA AERODROM ILI KISELA VODA BI ODGOVARALO NAJMNOGU');
  await send(chat, 'POMALO NESTO DO 300EVRA'); // see-offers into presentation, budget 300
  const r = await send(chat, 'A ZA 250?');      // pure budget correction
  const s = sessions.get(chat)!;
  assert.equal(s.slots.budget, '250', 'the correction must overwrite the budget');
  for (const id of s.slots.currentBatch ?? []) {
    const row = makeRows().find(p => p.id === id)!;
    assert.ok((row.price as number) <= 250, `EB ${id} at ${row.price}€ exceeds the corrected ≤250 ask`);
  }
  assert.ok(!r.includes('61') && !r.includes('65'), '380€/420€ never serve');
});

test('bare see-offers with NO budget still presents (regression guard on the original lane)', async () => {
  const { send, sessions } = await makeHandler(makeRows());
  const chat = 'bare-see';
  await send(chat, 'SAKAM DA IZNAJMAM STAN');
  const r = await send(chat, 'STO IMATE VO PONUDA'); // see-offers, no criteria at all
  const s = sessions.get(chat)!;
  assert.ok(r.length > 0, 'the see-offers lane still presents');
  assert.ok((s.slots.currentBatch ?? []).length > 0, 'cards serve without any budget');
  // Location stayed unlocked — city-wide offers, no crash, no ask-back loop.
  assert.equal(s.slots.budget, undefined);
});
