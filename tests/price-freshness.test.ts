// THE [08:50] TRANSCRIPT — the client asked "mozno e da ima izmeni vo cenata?"
// and "a dali mu e uste taa cena ?" after the price was quoted, and Lina
// answered with a BARE amount ("Станот со Евидентен број 82 чини 143.000
// евра.") both times. The system price is the LAST KNOWN price — owners
// change terms without telling the agency — so a freshness question must
// serve the owner-relay disclaimer + contact ask, never a flat re-quote.
//
// Fix: detectPriceFreshness (wide variation family: still-current,
// unchanged, valid, ad/web source, probing-for-changes — both scripts) +
// a fast branch serving price.freshness with {price} substituted, and the
// client's "да" riding the EXISTING ownerContactPending → fee workflow.
// This test pins the whole flow with the LLM DOWN (deterministic stack).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession } from '../src/fsm/session';
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
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { detectPriceFreshness } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pricefresh-')), 'map.db');
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
}

test('detectPriceFreshness: the 08:50 family — still-current, changes, unchanged, ad-source, valid', () => {
  // The exact transcript lines
  assert.equal(detectPriceFreshness('mozno e da ima izmeni vo cenata ?'), true);
  assert.equal(detectPriceFreshness('a dali mu e uste taa cena ?'), true);
  assert.equal(detectPriceFreshness('dali mu e uste taa cena'), true);
  assert.equal(detectPriceFreshness('ДАЛИ МУ Е УШТЕ ТАА ЦЕНА ?'), true);
  // Gemini-style variations the operator asked to cover
  assert.equal(detectPriceFreshness('dali prodaznata cena e nepromeneta ?'), true);
  assert.equal(detectPriceFreshness('cenata dali e taa na oglasot ?'), true);
  assert.equal(detectPriceFreshness('dali cenata e taa na web stranicata ?'), true);
  assert.equal(detectPriceFreshness('dali uste vazi cenata ?'), true);
  assert.equal(detectPriceFreshness('cenata ista li e ?'), true);
  assert.equal(detectPriceFreshness('дали цената се уште важи?'), true);
  assert.equal(detectPriceFreshness('ima li promeni vo cenata ?'), true);
});

test('detectPriceFreshness: a PLAIN price ask is NOT freshness', () => {
  assert.equal(detectPriceFreshness('kolku e cenata ?'), false);
  assert.equal(detectPriceFreshness('koja e cenata na stanot'), false);
  assert.equal(detectPriceFreshness('kolku chini ?'), false);
  // statements / unrelated talk that merely mentions цена
  assert.equal(detectPriceFreshness('cenata e 143.000 evra'), false);
  assert.equal(detectPriceFreshness('sakam stan do 150000 evra'), false);
  assert.equal(detectPriceFreshness('mozno e da ima izmeni vo dogovorot'), false); // no price word
});

test('08:50 e2e: freshness question → disclaimer + contact ask → "да" → fee (LLM down)', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps([
    { eb: 82, id: 82, location: 'Центар', price: 143000, service: 'buy', size: '95 м²' } as Property,
  ]);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, props);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const mapPath = tmpMapDb();
  writeMap(mapPath, [], []);
  const offlineMap = new OfflineMapStore(mapPath);
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }), offlineMap });
  const chatId = 'freshness-test';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // The client asks about EB 82 (on the table, price quoted in the card)
  await send('ZA EB 82');
  // The 08:50 freshness question
  const s1 = await send('a dali mu e uste taa cena ?');
  const fresh = sent[sent.length - 1];
  assert.ok(fresh.includes('143.000'), `disclaimer must carry the last-known price: ${fresh}`);
  assert.ok(/сопственикот|сопственик/i.test(fresh), `must name the owner-relay protocol: ${fresh}`);
  assert.ok(/Дали (би сакале|сакате)/.test(fresh), `must END with the contact ask: ${fresh}`);
  assert.ok(!/чини \d/.test(fresh), `must NOT be a flat "чини X" re-quote: ${fresh}`);
  assert.equal(s1.slots.ownerContactPending, true, 'contact pending — the YES gate arms');
  assert.equal(s1.slots.interestedPropertyId, 82, 'funnel anchored on EB 82');

  // YES → the EXISTING fee workflow (no new funnel steps)
  await send('da');
  const fee = sent[sent.length - 1];
  assert.ok(/(?:500|300|надомест|провизија)/i.test(fee), `must disclose the fee after confirmation: ${fee}`);
  assert.ok(!fresh.toLowerCase().includes(fee.toLowerCase()), 'sanity');

  offlineMap.close();
});

test('08:50 e2e: a PLAIN price ask still gets the flat quote (no overreach)', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps([
    { eb: 82, id: 82, location: 'Центар', price: 143000, service: 'buy', size: '95 м²' } as Property,
  ]);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, props);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const mapPath = tmpMapDb();
  writeMap(mapPath, [], []);
  const offlineMap = new OfflineMapStore(mapPath);
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }), offlineMap });
  const chatId = 'freshness-negative-test';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZA EB 82');
  await send('kolku e cenata ?');
  const quote = sent[sent.length - 1];
  assert.ok(quote.includes('143.000'), `plain ask gets the price: ${quote}`);
  assert.ok(/чини/.test(quote), `plain ask keeps the flat-quote shape: ${quote}`);
  assert.ok(!/консултирам/.test(quote), `plain ask must NOT serve the disclaimer: ${quote}`);
  const s2 = sessions.get(chatId)!;
  assert.notEqual(s2.slots.ownerContactPending, true, 'no contact ask armed for a plain quote');

  offlineMap.close();
});
