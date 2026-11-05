// THE [18:52] CAPTURE — the owner panel read «Клиентот не е во можност за
// посета во Среда во 6». A naked 6 where 18:00 belongs, in the one sentence
// whose whole job is to name a term accurately.
//
// The cause: the owner follow-up composed the REFUSED half from the stored raw
// counter (mkTimePhrase only fixes day spellings), while the NEW half went
// through normalizeOwnerTime. Two renderers, one sentence — and the client
// panel had a third (normalizeTimePhrase + mkTimePhrase).
//
// The contract: EVERY term shown to a person goes through renderVisitTerm —
// day + clock resolved to the canonical «Петок, 06.11.2026 во 17:00», Latin
// transliterated first, a day-less or unresolvable phrase left as it is (the
// [10:24] rule: never date an undated term).
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
import { detectOwnerVerdict } from '../src/llm/deterministic';
import { renderVisitTerm } from '../src/llm/prompts';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ROWS: Property[] = [
  { eb: 57, id: 57, location: 'Центар', price: 350, service: 'rent', bedrooms: 2, size: '55 м²' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

const NOW = new Date(2026, 10, 6, 9, 0, 0); // Friday 06.11.2026

test('[18:52] renderVisitTerm: a term is shown with its date and clock', () => {
  // The capture itself: the owner's own counter, both scripts.
  assert.equal(renderVisitTerm('Среда во 6', NOW), 'Среда, 11.11.2026 во 18:00');
  assert.equal(renderVisitTerm('Sreda vo 6', NOW), 'Среда, 11.11.2026 во 18:00');
  // A Latin client phrase is transliterated BEFORE it is resolved.
  assert.equal(renderVisitTerm('UTRE VO 4', NOW), 'Сабота, 07.11.2026 во 16:00');
  // A day-less clock keeps its own form — dating it to today is the [10:24] bug.
  assert.equal(renderVisitTerm('18:00', NOW), '18:00');
  // An already-canonical phrase is idempotent.
  assert.equal(renderVisitTerm('Понеделник, 09.11.2026 во 17:00', NOW), 'Понеделник, 09.11.2026 во 17:00');
});

test('[18:52] e2e: the owner follow-up names the REFUSED term canonically, never «во 6»', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  const ownerAsks: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(llm, cfg, props),
    responder: new Responder(llm, cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  handler.onOwnerAsk = (_c: string, _eb: number, q: string) => { ownerAsks.push(q); };
  const chatId = 'relay-render';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 57');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA');
  await send('DA, SE SOGLASUVAM');
  await send('MARKO 078/914 196');
  const s0 = await send('MOZAM VO PETOK VO 5');
  assert.equal(s0.state, 'owner_checking');

  // The owner counters with a bare-hour phrase — exactly the capture's shape.
  handler.ownerAnswer(chatId, 57, detectOwnerVerdict('NE MOZAM PETOK VO 5 , SREDA VO 6', s0.slots.visitTime ?? '')!);
  await new Promise(r => setTimeout(r, 60));
  const afterCounter = sessions.get(chatId)!;
  assert.equal(afterCounter.slots.ownerCounterTime, 'Среда во 6', 'the counter is stored raw — rendering is a read, not a write');
  // The CLIENT panel reads the counter canonically too.
  const clientRelay = sent[sent.length - 1] ?? '';
  assert.match(clientRelay, /Среда, \d{2}\.\d{2}\.\d{4} во 18:00/u, `the client relay is canonical: ${clientRelay}`);

  // The client proposes another term — the OWNER follow-up is composed now.
  await send('NE MOZAM SREDA VO 6 , PONEDELNIK VO 7');
  await new Promise(r => setTimeout(r, 60));
  const followup = ownerAsks[ownerAsks.length - 1] ?? '';
  assert.match(followup, /^Клиентот не е во можност за посета во Среда, \d{2}\.\d{2}\.\d{4} во 18:00\./u,
    `the refused term carries its date and clock: ${followup}`);
  assert.match(followup, /Има друг предлог: Понеделник, \d{2}\.\d{2}\.\d{4} во 19:00\./u,
    `the new proposal is canonical: ${followup}`);
  // The naked hour can never appear as a term.
  assert.ok(!/во 6\b/u.test(followup), `a naked hour reached the owner: ${followup}`);
  db.close();
});
