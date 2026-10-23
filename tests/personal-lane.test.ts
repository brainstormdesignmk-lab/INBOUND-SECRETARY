// PERSONAL LANE — the [08:35–08:38] transcript, pinned.
//
//   "KAKO TI E IMETO?"       14 s of classify → generic greeting
//   "KAKO SE VIKAS?"         dynamic-recall served an improvised name answer
//   "UBAVO IME IMAS"         30 s of classify → generic greeting
//   "KOLKU GODINI IMAS LINA?" stored „Јас сум дигитален асистент, па немам
//                            години“ in bank_dynamic and served it forever
//
// The contract: these three shapes are deterministic (no LLM, no classify),
// their replies never expose a machine identity and never state an age, and
// they are excluded from dynamic generate+store so the bank cannot learn an
// improvised persona. The validator must also REJECT the old stored bytes, so
// tightening the rule neutralises rows that predate it.

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
import { BankStore } from '../src/store/bank';
import { EnrichmentStore } from '../src/store/enrichment';
import { detectPersonalAsk, personalReply, revealsMachineIdentity } from '../src/llm/personal';
import { validateDynamicAnswer, shouldTryDynamic } from '../src/llm/dynamicFallback';
import { replyIsClean } from '../src/llm/enrichQuality';

class ThrowingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('LLM must not be called for personal small talk'); }
}
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
}

test('detection: name / age / compliment, and business asks stay out', () => {
  for (const t of ['KAKO TI E IMETO?', 'KAKO SE VIKAS?', 'kako se vikas', 'како се викаш?', 'TVOETO IME?']) {
    assert.equal(detectPersonalAsk(t), 'name', t);
  }
  for (const t of ['KOLKU GODINI IMAS LINA ?', 'kolku godini imas', 'КОЛКУ ГОДИНИ ИМАШ', 'na kolku godini si', 'kolku si stara']) {
    assert.equal(detectPersonalAsk(t), 'age', t);
  }
  for (const t of ['UBAVO IME IMAS', 'ubavo ime imas', 'MNOGU SI UBAVA', 'многу си убава', 'prekrasna si']) {
    assert.equal(detectPersonalAsk(t), 'compliment', t);
  }
  // Business traffic is never personal small talk.
  for (const t of ['KOLKU GODINI IMA ZGRADATA?', 'kolku godini ima zgradata', 'ubav stan imate', 'kolku e cenata?', 'kade se naogja?', 'kako se vika ulicata?']) {
    assert.equal(detectPersonalAsk(t), undefined, t);
  }
});

test('replies keep the persona: no machine identity, no age, clean prose', () => {
  for (const ask of ['name', 'age', 'compliment'] as const) {
    for (let i = 0; i < 20; i++) {
      const reply = personalReply(ask, i === 0 ? [] : [personalReply(ask, [])]);
      assert.equal(revealsMachineIdentity(reply), false, `${ask}: ${reply}`);
      assert.equal(replyIsClean(reply), true, `${ask}: ${reply}`);
      assert.equal(/\d/.test(reply), false, `${ask} must not state a number: ${reply}`);
    }
  }
});

test('validator rejects the stored age/identity answer on GENERATION and on RECALL', () => {
  const stored = 'Ти благодарам! Јас сум дигитален асистент, па немам години, но секогаш сум подготвена да Ви помогнам.';
  assert.ok(validateDynamicAnswer(stored, 'KOLKU GODINI IMAS LINA ?').length > 0);
  assert.equal(validateDynamicAnswer('Годината на градба не е во моите записи, ќе проверам кај сопственикот. Дали да го контактирам?').length, 0);
});

test('gate: personal turns never generate or store; an uncovered question still does', () => {
  const s = freshSession('test', 'personal-gate');
  s.state = 'idle';
  for (const t of ['KAKO TI E IMETO?', 'KAKO SE VIKAS?', 'KOLKU GODINI IMAS LINA ?', 'UBAVO IME IMAS']) {
    assert.equal(shouldTryDynamic(s, t), false, t);
  }
  assert.equal(shouldTryDynamic(s, 'kade ima reptil tamu ?'), true);
});

test('handler: the three transcript lines answer deterministically, store nothing, and leave the funnel intact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-lane-'));
  const dbFile = path.join(dir, 'lina.db');
  const cfg = loadConfig();
  const db = new Db(dbFile);
  const sessions = new SessionStore(db);
  const props = new FakeProps([{ eb: 76, id: 76, location: 'Центар', price: 185000, service: 'buy', size: '80 м²' } as Property]);
  const channels = new ChannelRegistry();
  const sent: Array<{ text: string; source?: string }> = [];
  channels.register({ name: 'test', send: async (_c, text, source) => { sent.push({ text, source }); } });
  const mapPath = path.join(dir, 'map.db');
  writeMap(mapPath, [], []);
  const offlineMap = new OfflineMapStore(mapPath);
  const bank = new BankStore(db);
  const enrichment = new EnrichmentStore(db);
  try {
    const handler = new InboundHandler({
      cfg, db, sessions,
      classifier: new Classifier(new ThrowingLlm(), cfg, props),
      responder: new Responder(new ThrowingLlm(), cfg),
      properties: props,
      appointments: new AppointmentStore(db), escalations: new EscalationStore(db), meta: new MetaStore(db),
      channels, landmarks: new LandmarkService(db, { osm: false, offlineMap }), bank, enrichment,
    });
    for (const line of ['KAKO TI E IMETO?', 'UBAVO IME IMAS', 'KOLKU GODINI IMAS LINA ?']) {
      await handler.handle('test', 'personal-1', line);
      const last = sent.at(-1);
      assert.equal(last?.source, 'deterministic:personal', `${line} → ${last?.source}`);
      assert.equal(revealsMachineIdentity(last?.text ?? ''), false, `${line} → ${last?.text}`);
      assert.equal(/дигитал|асистент|бот|робот|\bAI\b/iu.test(last?.text ?? ''), false, `${line} → ${last?.text}`);
    }
    assert.equal(bank.dynamicGroups().length, 0, 'personal turns must never enter bank_dynamic');
    assert.equal(enrichment.pendingCount(), 0, 'personal turns must never be queued for enrichment');
    assert.equal(sessions.get('personal-1')?.state, 'idle', 'the funnel must not move');
  } finally {
    offlineMap.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F4 source: listRecent returns newest first', () => {
  const db = new Db(':memory:');
  const en = new EnrichmentStore(db);
  en.insert({ chatId: 'c1', state: 'idle', eventType: 'A', userMsg: 'first', replyText: 'прв одговор', replySource: 'dynamic' });
  en.insert({ chatId: 'c1', state: 'idle', eventType: 'B', userMsg: 'second', replyText: 'втор одговор', replySource: 'dynamic' });
  const rows = en.listRecent(2);
  assert.equal(rows[0].eventType, 'B');
  assert.equal(rows[1].eventType, 'A');
});
