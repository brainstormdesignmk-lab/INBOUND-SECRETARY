/**
 * MACHINE TEXT IS NOT A CLIENT — the [22:28] capture and the 17 dead sends.
 *
 * Every row in the relay's `outbound/failed` directory is a notice, not a
 * person: the Drive-backup failure, Viber's «ChatGPT is in Viber» promo,
 * birthday cards, announcement titles. The bot composed a sales turn for each
 * (the [22:28] one: «Здраво. Дали планирате купување на недвижност или барате
 * опција за изнајмување?») and then the APK spent 6 × ~8 s trying to open a chat
 * that does not exist («APK send error: viber search input not found»), while
 * keeping a bogus session for a “client” called «Error during backup».
 *
 * Two arms, both from the captures: the chat title repeats as the body
 * («Happy birthday» named «Happy birthday»), or the body is Viber's own copy.
 *
 * The guard must stay NARROW: a real client's short message must never be
 * swallowed (the same chokepoint would silence a genuine chat), and the chat
 * must still work normally right after a notice was dropped.
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
import { isNonClientNotice } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ROW: Property = {
  eb: 84, id: 84, location: 'Центар', address: 'РОЗА ЛУКСЕМБУРГ',
  lat: 41.9951, lon: 21.4180, geo_source: 'google_cached',
  service: 'buy', price: 117000, bedrooms: 3, sqm: 48, size: '48 м²',
} as Property;

class Props extends PropertyService {
  constructor(private rows: Property[]) { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const sent: string[] = [];
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new Props([ROW]);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  return { handler, sessions, sent };
}

// The exact strings the relay captured on 2026-11-17 (processed/).
const NOTICES: Array<[string, string]> = [
  ['Error during backup', 'There was an error during the back up. Please make sure your Google Drive is connected correctly and try again.'],
  ['Rakuten Viber', 'ChatGPT is in Viber\n\nLearn how using ChatGPT in Viber can be fun, save time, and benefit your day-to-day life.'],
  ['Saso Kostovski', 'Happy birthday'],
  ['Happy birthday', 'Happy birthday'],
  ['Ready for the week? 📅', 'Ready for the week? 📅'],
  ['Halloween is coming 🎃', 'Halloween is coming 🎃'],
  ['Zoran Atanasov', 'from Zoran Atanasov, Saso Kostovski'],
];

test('the captured notice texts are recognised', () => {
  for (const [chatId, text] of NOTICES) {
    assert.equal(isNonClientNotice(text, chatId), true,
      `must be a non-client notice: ${JSON.stringify([chatId, text])}`);
  }
});

test('real client messages are never swallowed', () => {
  const clientLines: Array<[string, string]> = [
    ['V16K11', 'zdravo'],
    ['V16K11', 'sto imate za prodavanje kaj beverli hils'],
    ['V16K11', 'kolku e stanot?'],
    ['V16K11', 'Happy birthday to your colleague — I am looking for a flat'],
    ['test', 'ZDRAVO'],
    ['V16K11', 'baram stan do 250 evra'],
  ];
  for (const [chatId, text] of clientLines) {
    assert.equal(isNonClientNotice(text, chatId), false,
      `a client turn must reach the funnel: ${JSON.stringify([chatId, text])}`);
  }
});

test('a notice produces no reply, no session, no state', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'Error during backup';
  await handler.handle('test', chatId,
    'There was an error during the back up. Please make sure your Google Drive is connected correctly and try again.');
  assert.equal(sent.length, 0, `nothing is sent to a machine notice: ${sent.join(' | ')}`);
  // SessionStore.get returns null for an unknown chat — the point is that NO
  // row was written, so this chat never becomes a “client”.
  assert.equal(sessions.get(chatId), null,
    'a notice must not create a “client” session');
});

test('the very next real client turn still works normally', async () => {
  const { handler, sent } = makeHandler();
  await handler.handle('test', 'Saso Kostovski', 'Happy birthday');
  const before = sent.length;
  await handler.handle('test', 'V16K11', 'zdravo');
  assert.equal(sent.length, before + 1, 'the client turn is answered');
  // The greeting bank rotates between noun and verb forms ("купување" vs
  // "што би ја купиле"); the contract is the buy-or-rent offer, not one wording.
  assert.match(sent.at(-1)!, /куп|изнајм/iu,
    `the opening question: ${sent.at(-1)}`);
});
