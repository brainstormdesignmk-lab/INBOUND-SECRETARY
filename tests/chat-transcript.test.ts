// THE V16K11 INCIDENT — the live conversation could not be printed.
//
//   operator: "list the latest viber chat live here in full"
//   appliance: `sessions` had 0 rows; the history lived in one row that the
//              idle sweeper deletes, and nothing else stored the assistant's
//              replies. The transcript was gone.
//
// The fix is a per-turn table written at the ONE turn-end seam (closeTurn) from
// the same audit `sendRaw` feeds — the text actually sent, not a lane's belief.
// These tests pin the two properties that matter: the transcript records both
// sides of every turn, and it survives the session being deleted (the sweeper)
// and the process being reopened.

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
import { ChatLogStore } from '../src/store/chatLog';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

const ROWS: Property[] = [
  { eb: 76, id: 76, location: 'Центар', address: 'Ул. Тест 76', price: 200, sqm: 24, service: 'rent', size: '24 м²' } as Property,
  { eb: 50, id: 50, location: 'Центар', address: 'Ул. Тест 50', price: 300, bedrooms: 2, sqm: 74, service: 'rent', house: true, size: '74 м²' } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(dbPath: string) {
  const db = new Db(dbPath);
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const props = new FakeProps(ROWS);
  const cfg = loadConfig();
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent, db };
}

const tmpDb = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-log-')), 'log.db');

test('every turn is recorded on both sides, and survives the session wipe', async () => {
  const dbPath = tmpDb();
  const { handler, sessions, sent, db } = makeHandler(dbPath);
  const chatId = 'v16k11-transcript';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'zdravo');
  await handler.handle('test', chatId, 'mi treba stan pod kirija / centar');
  await handler.handle('test', chatId, 'dvosoben ili kukja moze do 300 evra');

  const log = new ChatLogStore(db);
  const rows = log.recent(chatId);
  assert.equal(rows.length, 3, `one row per turn: ${rows.length}`);
  assert.equal(rows[0]!.userText, 'zdravo');
  assert.ok(rows[0]!.replyText.length > 0, 'the reply is stored, not only the question');
  assert.equal(rows[2]!.userText, 'dvosoben ili kukja moze do 300 evra');
  assert.match(rows[2]!.replyText, /Евидентен број/u, 'the serve itself is the record');
  assert.equal(rows[2]!.replyText, sent[sent.length - 1],
    'the row holds EXACTLY what the client received');
  assert.ok(rows[2]!.stateAfter.length > 0);
  // THE TURN'S CLOCK IS ON THE RECORD (the operator's «she took 3–7 minutes»):
  // a slow turn has to be visible after the fact, in the transcript itself.
  assert.equal(typeof rows[0]!.ms, 'number', 'each turn stores how long it took');
  assert.ok(rows[0]!.ms! >= 0 && rows[0]!.ms! < 600_000, `a plausible duration: ${rows[0]!.ms}`);
  assert.match(ChatLogStore.render(rows), /· \d+(?:\.\d+)?(?:ms|s)/u,
    'the dump shows the duration beside the reply');

  // THE SWEEPER'S OWN DELETION: the session row goes away, the transcript stays.
  sessions.delete(chatId);
  // SessionStore.get returns null (not undefined) when the row is gone.
  assert.equal(sessions.get(chatId), null, 'the session is really gone');
  db.close();

  const reopened = new Db(dbPath);
  const after = new ChatLogStore(reopened).recent(chatId);
  assert.equal(after.length, 3, 'the transcript outlives the session AND the process');
  assert.match(ChatLogStore.render(after), /klient: dvosoben ili kukja/u, 'it renders as a readable chat');
  reopened.close();
});

// THE TABLE THAT ALREADY EXISTS ON THE APPLIANCE GAINS THE COLUMN IN PLACE:
// a transcript that has to be dropped to add a field is not a transcript.
test('an older chat_log (no ms column) is migrated, its rows kept', () => {
  const dbPath = tmpDb();
  const db = new Db(dbPath);
  db.db.exec(`CREATE TABLE chat_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, at INTEGER NOT NULL,
    state_before TEXT NOT NULL DEFAULT '', state_after TEXT NOT NULL DEFAULT '',
    source TEXT, bank_key TEXT, lanes TEXT NOT NULL DEFAULT '',
    user_text TEXT NOT NULL DEFAULT '', reply_text TEXT NOT NULL DEFAULT '')`);
  db.db.prepare(`INSERT INTO chat_log (chat_id, at, user_text, reply_text) VALUES (?, ?, ?, ?)`)
    .run('old-chat', Date.now() - 1000, 'zdravo', 'Здраво!');

  const log = new ChatLogStore(db);
  log.append({
    chatId: 'old-chat', at: Date.now(), ms: 42, stateBefore: 'idle', stateAfter: 'idle',
    lanes: [], userText: 'pak jas', replyText: 'Се слушаме.',
  });
  const rows = log.recent('old-chat');
  assert.equal(rows.length, 2, `the pre-existing row survives: ${rows.length}`);
  assert.equal(rows[0]!.userText, 'zdravo');
  assert.equal(rows[0]!.ms, undefined, 'a row from before the column has no duration');
  assert.equal(rows[1]!.ms, 42, 'the new row carries it');
  db.close();
});

test('the dump lists the chats that have a transcript', async () => {
  const dbPath = tmpDb();
  const { handler, sessions, db } = makeHandler(dbPath);
  for (const chat of ['chat-a', 'chat-b']) {
    sessions.set(freshSession('test', chat));
    await handler.handle('test', chat, 'zdravo');
  }
  const log = new ChatLogStore(db);
  const chats = log.chats();
  assert.deepEqual(chats.map(c => c.chatId).sort(), ['chat-a', 'chat-b']);
  assert.ok(chats.every(c => c.turns === 1));
  db.close();
});
