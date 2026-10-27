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

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// ── THE [02:01..03] CAPTURE ROWS (rent, ≤ 350) ──────────────────────────────
// 76 — Центар гарсоњера 200 € (24 м²)                   → studio pass
// 94 — Кисела Вода 30 м² 300 € (≤ 35 м² → studio; no bedrooms → rides BOTH passes)
// 95 — Аеродром 2-спални 330 € (45 м²)                  → regular pass
// 91 — Центар 2-спални 230 € (48 м²)                    → regular pass, BIGGEST fit
// 96 — Центар 2-спални 350 € (39 м²)                    → regular pass
const ROWS: Property[] = [
  { eb: 76, id: 76, location: 'Центар', price: 200, service: 'rent', size: '24 м²', details: 'Гарсоњера целосно наместена.' },
  { eb: 94, id: 94, location: 'Кисела Вода', price: 300, service: 'rent', size: '30 м²' },
  { eb: 95, id: 95, location: 'Аеродром', price: 330, service: 'rent', bedrooms: 2, size: '45 м²' },
  { eb: 91, id: 91, location: 'Центар', price: 230, service: 'rent', bedrooms: 2, size: '48 м²' },
  { eb: 96, id: 96, location: 'Центар', price: 350, service: 'rent', bedrooms: 2, size: '39 м²' },
];

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new (class extends PropertyService {
    constructor() { super('http://fake-feed'); }
    async getAll(): Promise<Property[]> { return ROWS; }
    get healthy(): boolean { return true; }
  })();
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent };
}

// A flow driver: send returns the session and indexes the reply it produced.
async function runFlow(steps: string[]): Promise<{ s: import('../src/fsm/session').ChatSession; sent: string[]; handler: InboundHandler; sessions: SessionStore }> {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'cap02';
  for (const step of steps) await handler.handle('test', chatId, step);
  return { s: sessions.get(chatId)!, sent, handler, sessions };
}

// No invented units, no apology, no прирачка in any serve under test.
const NO_PRIRACKA = /прирачка/u;
const GARSONJERA_APOLOGY = /немам\s+(?:слободн\w*\s+)?гарсоњер/u;

test('[02:01..03] mixed ask (rooms + garsonjera stretch): the serve is a MIXED PAIR led by the biggest in-budget unit', async () => {
  const { s, sent } = await runFlow([
    'sakam da iznajmam stan',
    'STO POBLISKU DO CENTAR',
    'EDNA ILI DVE , A MOZE I GARSONJERA AKO E DOBRA',
    'DO 350 EVR',
  ]);
  // The funnel was completed with the near-center intent ON the session — the
  // [02:02] serve must be the ring-pair presenter, never the normal pool.
  assert.equal(s.state, 'presentation');
  const serve = sent[3];
  // Biggest in-budget unit LEADS: EB 91 (48 м², Центар) is the first EB named.
  const firstEb = serve.match(/Евидентен број\s+(\d+)/);
  assert.ok(firstEb, serve);
  assert.equal(parseInt(firstEb[1], 10), 91, `lead card must be the biggest fit (48 м²), got: ${serve}`);
  // MIXED PAIR: the two named units come from DIFFERENT categories nowhere —
  // exactly EB 91 (regular) + EB 94 (studio rider) on this ledger.
  const ebs = [...serve.matchAll(/Евидентен број\s+(\d+)/g)].map(m => parseInt(m[1], 10));
  assert.deepEqual(ebs, [91, 94]);
  // She NEVER apologizes about the category she does have stock for.
  assert.ok(!GARSONJERA_APOLOGY.test(serve), serve);
  assert.ok(!NO_PRIRACKA.test(serve), serve);
  assert.deepEqual(s.slots.presentedIds, [91, 94]);
});

test('[02:03] dvosobno-so-spalna RETIRES the garsonjera stretch: a 2-bedroom fit LEADS, no garsonjera apology, no re-ask', async () => {
  const { s, sent } = await runFlow([
    'sakam da iznajmam stan',
    'STO POBLISKU DO CENTAR',
    'EDNA ILI DVE , A MOZE I GARSONJERA AKO E DOBRA',
    'DO 350 EVR',
    'A DVOSOBNO NESTO SO POSEBNA SPALNA?',
  ]);
  // The stretch is retired — the search is now a plain 2-bedroom ask.
  assert.equal(s.slots.bedrooms, 2);
  assert.equal(s.slots.garsonjera, undefined);
  const reply = sent[4];
  // No invented units (the 04:09 probe invented "тести наместен стан со една
  // спална во буњаковец") — the reply names ONLY real row EBs from the ledger.
  const ebs = [...reply.matchAll(/Евидентен број\s+(\d+)/g)].map(m => parseInt(m[1], 10));
  for (const eb of ebs) assert.ok(ROWS.some(r => r.eb === eb), `invented EB ${eb}: ${reply}`);
  // No apology about a category the client just retired, no прирачка.
  assert.ok(!GARSONJERA_APOLOGY.test(reply), reply);
  assert.ok(!NO_PRIRACKA.test(reply), reply);
  // Does not re-ask the bedrooms question the client just answered.
  assert.ok(!reply.includes('Колку спални'), reply);
  // The first named unit is a 2-bedroom fit that fits the budget: EB 96
  // (39 м², Центар, 350 €) or EB 95 (45 м², Аеродром) — never a studio lead.
  const firstEb = reply.match(/Евидентен број\s+(\d+)/);
  assert.ok(firstEb, reply);
  assert.ok([96, 95].includes(parseInt(firstEb[1], 10)), `a dvosobno fit must lead: ${reply}`);
});

test('[02:02] plain rooms ask (NO garsonjera keyword): NO garsonjera apology and no studio cards in the pool', async () => {
  const { s, sent } = await runFlow([
    'sakam da iznajmam stan',
    'STO POBLISKU DO CENTAR',
    'EDNA ILI DVE',
    'DO 350 EVR',
  ]);
  assert.equal(s.state, 'presentation');
  assert.equal(s.slots.garsonjera, undefined);
  const serve = sent[3];
  assert.ok(!GARSONJERA_APOLOGY.test(serve), serve);
  assert.ok(!NO_PRIRACKA.test(serve), serve);
  // Without the stretch the pool holds ONLY the rooms fits: never a garsonjera
  // card (EB 76) for a client who never asked about it.
  assert.ok(!serve.includes('76'), serve);
  const ebs = [...serve.matchAll(/Евидентен број\s+(\d+)/g)].map(m => parseInt(m[1], 10));
  assert.ok(ebs.length > 0 && ebs.every(eb => [91, 95, 96].includes(eb)), `${ebs}: ${serve}`);
});

test('[02:01] near-center ask mid-funnel never re-asks the location question', async () => {
  const { s, sent } = await runFlow([
    'sakam da iznajmam stan',
    'STO POBLISKU DO CENTAR',
  ]);
  // The intent registered; stage 'ring' means no neighborhood re-ask.
  assert.ok(s.slots.nearCenter, 'near-center intent must register');
  assert.deepEqual(s.slots.nearCenter.ring, ['Карпош', 'Аеродром', 'Кисела Вода', 'Капиштец']);
  assert.equal(s.slots.nearCenter.stage, 'ring');
  const reply = sent[1];
  assert.ok(!reply.includes('Во кој дел од градот'), reply);
  // The funnel continues: the size question is what she asks.
  assert.ok(/спалн/i.test(reply), reply);
});
