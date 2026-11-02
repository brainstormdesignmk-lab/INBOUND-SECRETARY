// THE [02:24] FACT-OWNERSHIP CAPTURE — two flats on the table, facts about the
// WRONG one.
//
//   [02:24] the batch: EB 54 (Карпош III, 69.500 €) and EB 63 (Центар,
//           гарсоњера во сутерен, 36.000 €)
//   [02:24] 54 NE E LOSA OPCIJA
//   [02:25] DALI IMA LIFT ?   →  «Нема лифт.»        (that is EB 63's fact)
//   [02:25] NA KOJ SPRAT E ?  →  «Се наоѓа во сутерен.» (EB 63 again)
//
// EB 54 is on 2-ри кат and HAS a lift. The praise named 54, but the session
// slots still held the batch tail, so every follow-up fact answered a flat the
// client never asked about. The rule: while the client is asking about ONE
// apartment, the facts are that apartment's — until the chat shifts (a new
// number, or a new search).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InboundHandler } from '../src/handlers/inbound';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { SessionStore, freshSession } from '../src/fsm/session';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { LandmarkService } from '../src/geo/landmarks';
import { Db } from '../src/store/db';
import { loadConfig } from '../src/config';
import { setLearnedBank } from '../src/data/responseBank';

setLearnedBank({
  variants: () => [],
  addVariant: () => false,
  addExample: () => false,
  metric: () => {},
  retrieve: () => undefined,
} as any);

class FailingLlm { async complete(): Promise<string> { throw new Error('429 quota exhausted'); } }

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

// EB 54 — the flat the client praised: 2 кат of 3, WITH a lift.
const P54: Property = {
  eb: 54, id: 54, location: 'Карпош III', price: 69500, service: 'buy',
  bedrooms: 1, sqm: 38, size: '38 м²', floor: 2, totalFloors: 3,
  features: ['лифт'],
  details: 'Еднособен наместен стан во Карпош 3, на 2-ри кат од 3-ката.',
};
// EB 63 — the batch tail: a basement studio with NO lift.
const P63: Property = {
  eb: 63, id: 63, location: 'Центар', price: 36000, service: 'buy',
  sqm: 28, size: '28 м²', details: 'Гарсоњера во сутурен, реновирена.',
  noFeatures: ['лифт'],
};

const ROWS = [P54, P63];

test('[02:24] facts answer the flat the client NAMED, never the batch tail', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });

  const chatId = 'fact-owner-0224';
  // The exact state the capture was in: both flats presented, the slots still
  // pointing at the tail (63).
  const s = freshSession('test', chatId);
  s.state = 'presentation';
  s.slots.propertyId = 63;
  s.slots.interestedPropertyId = 63;
  s.slots.presentedIds = [54, 63];
  s.slots.currentBatch = [54, 63];
  s.slots.service = 'buy';
  sessions.set(s);

  const send = async (m: string) => {
    await Promise.race([
      handler.handle('test', chatId, m),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`turn timeout (>10s): ${m.slice(0, 40)}`)), 10_000).unref()),
    ]);
    return { session: sessions.get(chatId)!, reply: sent[sent.length - 1] ?? '' };
  };

  // The praise names 54 — the conversation moves to 54.
  const praise = await send('54 NE E LOSA OPCIJA');
  assert.equal(praise.session.slots.interestedPropertyId, 54, `the named flat must own the slot: ${praise.reply}`);
  assert.equal(praise.session.slots.propertyId, 54, 'the current flat moves with it');

  // «DALI IMA LIFT?» is 54's lift, not 63's basement.
  const lift = await send('DALI IMA LIFT ?');
  assert.ok(/лифт/iu.test(lift.reply), `a lift answer is expected for EB 54: ${lift.reply}`);
  assert.ok(!/Нема лифт/iu.test(lift.reply), `EB 63's absence must never answer for EB 54: ${lift.reply}`);
  assert.equal(lift.session.slots.interestedPropertyId, 54);

  // «NA KOJ SPRAT E ?» is 54's 2-ри кат, not the studio's basement.
  const floor = await send('NA KOJ SPRAT E ?');
  assert.ok(/2 кат/u.test(floor.reply), `EB 54 sits on the 2nd floor: ${floor.reply}`);
  assert.ok(!/сутерен/iu.test(floor.reply), `the basement belongs to EB 63: ${floor.reply}`);

  // A NEW number SHIFTS the chat — the rule is "until the chat shifts", and
  // saying 63 now must move the facts back to 63.
  const shift = await send('63 E POODLICNA');
  assert.equal(shift.session.slots.interestedPropertyId, 63, 'a newer number takes the conversation');
  const floor63 = await send('NA KOJ SPRAT E ?');
  assert.ok(!/2 кат/u.test(floor63.reply), `EB 54's floor must not answer after the shift to 63: ${floor63.reply}`);
  db.close();
});
