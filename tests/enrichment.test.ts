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

// ── Mocks ───────────────────────────────────────────────────────────────────

/** LLM always down — forces deterministic paths. */
class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('LLM down'); }
}

/** Minimal LLM that returns INTERESTED for property interest messages. */
class InterestLlm implements LlmClient {
  async complete(args: { role: string; messages: { role: string; content: string }[] }): Promise<string> {
    if (args.role === 'respond') return 'Одличен избор!';
    const last = args.messages[args.messages.length - 1].content;
    if (/GO SAKAM|ZAINTERESIRAN|MI SE SVIGJA/i.test(last)) {
      return JSON.stringify({ event: 'INTERESTED', propertyId: 79 });
    }
    if (/СОГЛАСУВАМ|SOGLASNUVAM|ZA SOGLAS/i.test(last)) return JSON.stringify({ event: 'FEE_AGREED' });
    return JSON.stringify({ event: 'STAY' });
  }
}

/** Mock enrichment store that captures insert calls. */
class MockEnrichment {
  records: Array<{
    chatId: string;
    state: string;
    eventType: string;
    userMsg: string;
    replyText: string;
    replySource: string;
    bankKey?: string;
  }> = [];

  insert(rec: {
    chatId: string;
    state: string;
    eventType: string;
    userMsg: string;
    replyText: string;
    replySource: string;
    bankKey?: string;
  }): void {
    this.records.push(rec);
  }
}

const FEED: Property[] = [
  { eb: 79, id: 79, location: 'Водно', price: 300, service: 'rent', bedrooms: 2, size: '35 м²', address: 'Водно' },
  { eb: 80, id: 80, location: 'Кисела Вода', price: 46000, service: 'buy' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

function makeHandler(llmOverride?: LlmClient) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(FEED);
  const llm = llmOverride ?? new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const enrichment = new MockEnrichment();
  const handler = new InboundHandler({
    cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
    enrichment: enrichment as any,
  });
  return { handler, sessions, sent, enrichment, db };
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('investment opinion: Cyrillic logs with bankKey=investment.opinion', async () => {
  const { handler, sessions, enrichment, db } = makeHandler();
  const chatId = 'invest-cyr';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Bootstrap: greeting → intent → presentation
  await send('SAKAM DA KUPAM STAN VO VODNO');
  await send('DO 500 EVRA, DVOSOBEN');

  // Investment opinion
  const s = await send('MISLAM DEKA CENITE SE PREVISOKI ZA TOJ REON');
  assert.equal(s.state, 'presentation', 'should stay in presentation (digression)');

  const record = enrichment.records.find(r => r.userMsg.includes('PREVISOKI'));
  assert.ok(record, 'investment opinion should be logged to enrichment');
  assert.equal(record!.bankKey, 'investment.opinion', 'should carry bankKey=investment.opinion');
  assert.equal(record!.replySource, 'deterministic', 'reply source should be deterministic');
  assert.ok(record!.replyText.length > 0, 'reply text should not be empty');

  db.close();
});

test('investment opinion: Latin logs with bankKey=investment.opinion', async () => {
  const { handler, sessions, enrichment, db } = makeHandler();
  const chatId = 'invest-lat';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('SAKAM DA KUPAM STAN VO VODNO');
  await send('DO 500 EVRA');
  await send('DA TI KAZAM ISKRENO SO DENESNIVE CENI NEZNAM DALI E PAMETNO DA SE INVESTIRA VO STAN');

  const record = enrichment.records.find(r => r.userMsg.includes('INVESTIRA'));
  assert.ok(record, 'Latin investment opinion should be logged');
  assert.equal(record!.bankKey, 'investment.opinion', 'should carry bankKey=investment.opinion');

  db.close();
});

test('investment opinion in closing state: blocks fee disclosure, logs bankKey', async () => {
  const { handler, sessions, sent, enrichment, db } = makeHandler(new InterestLlm());
  const chatId = 'closing-digress';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('SAKAM DA KUPAM STAN VO VODNO');
  await send('DO 500 EVRA, DVOSOBEN');
  let s = await send('GO SAKAM');
  assert.equal(s.state, 'closing', 'should be in closing state');

  // Investment opinion in closing — should NOT trigger fee disclosure
  s = await send('MISLAM DEKA CENITE SE PREVISOKI');
  assert.equal(s.state, 'closing', 'should stay in closing');

  const lastReply = sent[sent.length - 1];
  assert.ok(!lastReply.includes('300 денари') && !lastReply.includes('5 евра'),
    `should not be fee disclosure, got: ${lastReply}`);

  const record = enrichment.records.find(r => r.userMsg.includes('PREVISOKI'));
  assert.ok(record, 'should be logged');
  assert.equal(record!.bankKey, 'investment.opinion');

  db.close();
});

test('fee.ask: logs with bankKey=fee.ask.buy when agreement in closing', async () => {
  const { handler, sessions, enrichment, db } = makeHandler(new InterestLlm());
  const chatId = 'fee-log';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('SAKAM DA KUPAM STAN VO VODNO');
  await send('DO 500 EVRA, DVOSOBEN');
  let s = await send('GO SAKAM');
  assert.equal(s.state, 'closing', 'should be in closing state');

  // Agreement → fee disclosure with bankKey
  s = await send('ДА, СОГЛАСУВАМ');
  const feeRecord = enrichment.records.find(r => r.bankKey?.startsWith('fee.ask'));
  assert.ok(feeRecord, 'fee.ask should be logged to enrichment');
  assert.ok(feeRecord!.bankKey!.startsWith('fee.ask'), `bankKey should start with fee.ask, got: ${feeRecord!.bankKey}`);

  db.close();
});

test('non-investment reply without bankKey is NOT logged (deterministic gate)', async () => {
  const { handler, sessions, enrichment, db } = makeHandler();
  const chatId = 'gate-check';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('SAKAM DA KUPAM STAN VO VODNO');
  await send('DO 500 EVRA');

  // Generic message that produces a deterministic reply WITHOUT a bankKey
  await send('DOBRO');

  // The reply should NOT be logged (no bankKey, deterministic source)
  const record = enrichment.records.find(r => r.userMsg === 'DOBRO');
  assert.ok(!record, 'deterministic reply without bankKey should NOT be logged');

  db.close();
});

// ── Provision routing tests ──────────────────────────────────────────────────

test('provision routing: danok question → provision.who.danok.buy in buy funnel', async () => {
  const { handler, sessions, enrichment, db } = makeHandler();
  const chatId = 'prov-danok-buy';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Establish buy funnel step by step (avoid property_locate)
  await send('ZDRAVO');
  await send('SAKAM DA KUPAM STAN');
  await send('VO VODNO');
  await send('DO 90000 EVRA');
  await send('2 SPALNI');

  // Ask about danok specifically
  await send('KOJ GO PLAKJA DANOKOT ?');

  const s = sessions.get(chatId)!;
  // Check the last reply contains danok-related text
  const lastReply = s.history[s.history.length - 1].text;
  assert.ok(
    /данок|danok/i.test(lastReply),
    `reply should mention данок/danok, got: ${lastReply.slice(0, 100)}`
  );
  assert.ok(
    /купувач/i.test(lastReply),
    `reply should mention купувач (buyer obligation), got: ${lastReply.slice(0, 100)}`
  );

  // Check enrichment log carries the correct bankKey
  const record = enrichment.records.find(r => r.userMsg.includes('DANOKOT'));
  assert.ok(record, 'danok question should be logged to enrichment');
  assert.equal(record!.bankKey, 'provision.who.danok.buy', 'bankKey should be provision.who.danok.buy');

  db.close();
});

test('provision routing: lawyer question → provision.who.buy in buy funnel', async () => {
  const { handler, sessions, enrichment, db } = makeHandler();
  const chatId = 'prov-who-buy';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Establish buy funnel step by step
  await send('ZDRAVO');
  await send('SAKAM DA KUPAM STAN');
  await send('VO VODNO');
  await send('DO 90000 EVRA');
  await send('2 SPALNI');

  // Ask about lawyer/notary
  await send('KOJ GO PLAKJA ADVOKATOT ?');

  const s = sessions.get(chatId)!;
  const lastReply = s.history[s.history.length - 1].text;
  assert.ok(
    /адвокат|advokat/i.test(lastReply),
    `reply should mention адвокат/advokат, got: ${lastReply.slice(0, 100)}`
  );
  assert.ok(
    /купувач/i.test(lastReply),
    `reply should mention купувач (buyer obligation), got: ${lastReply.slice(0, 100)}`
  );

  const record = enrichment.records.find(r => r.userMsg.includes('ADVOKATOT'));
  assert.ok(record, 'lawyer question should be logged to enrichment');
  assert.equal(record!.bankKey, 'provision.who.buy', 'bankKey should be provision.who.buy');

  db.close();
});

test('provision routing: danok question → provision.who.rent in rent funnel', async () => {
  const { handler, sessions, enrichment, db } = makeHandler();
  const chatId = 'prov-danok-rent';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Establish rent funnel
  await send('SAKAM DA IZNAJMAM STAN VO VODNO');
  await send('DO 500 EVRA');

  // Ask about lawyer/notary in rent context
  await send('KOJ GO PLAKJA ADVOKATOT ?');

  const s = sessions.get(chatId)!;
  const lastReply = s.history[s.history.length - 1].text;
  assert.ok(
    /адвокат|advokat/i.test(lastReply),
    'reply should mention адвокат/advokat'
  );
  assert.ok(
    /50.*50|договор/i.test(lastReply),
    'reply should mention 50/50 or договор (rent provision)'
  );

  const record = enrichment.records.find(r => r.userMsg.includes('ADVOKATOT'));
  assert.ok(record, 'rent lawyer question should be logged');
  assert.equal(record!.bankKey, 'provision.who.rent', 'bankKey should be provision.who.rent');

  db.close();
});

test('provision routing: provision.ask → provision.ask.buy in buy funnel', async () => {
  const { handler, sessions, enrichment, db } = makeHandler();
  const chatId = 'prov-ask-buy';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Establish buy funnel step by step
  await send('ZDRAVO');
  await send('SAKAM DA KUPAM STAN');
  await send('VO VODNO');
  await send('DO 90000 EVRA');
  await send('2 SPALNI');

  // Ask about provision
  await send('KOLKU VI E PROVIZIJATA?');

  const s = sessions.get(chatId)!;
  const lastReply = s.history[s.history.length - 1].text;
  assert.ok(
    /0\s*%|нула/i.test(lastReply),
    `buy provision should mention 0%, got: ${lastReply.slice(0, 100)}`
  );
  assert.ok(
    /500\s*денари/i.test(lastReply),
    `buy provision should mention 500 денари visit fee, got: ${lastReply.slice(0, 100)}`
  );

  const record = enrichment.records.find(r => r.userMsg.includes('PROVIZIJATA'));
  assert.ok(record, 'provision ask should be logged');
  assert.equal(record!.bankKey, 'provision.ask.buy', 'bankKey should be provision.ask.buy');

  db.close();
});

test('provision routing: provision.ask → provision.ask.rent in rent funnel', async () => {
  const { handler, sessions, enrichment, db } = makeHandler();
  const chatId = 'prov-ask-rent';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Establish rent funnel step by step
  await send('ZDRAVO');
  await send('SAKAM DA IZNAJMAM STAN');
  await send('VO VODNO');
  await send('DO 500 EVRA');

  // Ask about provision
  await send('KOLKU VI E PROVIZIJATA?');

  const s = sessions.get(chatId)!;
  const lastReply = s.history[s.history.length - 1].text;
  assert.ok(
    /50\s*%|педесет/i.test(lastReply),
    `rent provision should mention 50%, got: ${lastReply.slice(0, 100)}`
  );
  assert.ok(
    /депозит/i.test(lastReply),
    `rent provision should mention депозит, got: ${lastReply.slice(0, 100)}`
  );

  const record = enrichment.records.find(r => r.userMsg.includes('PROVIZIJATA'));
  assert.ok(record, 'rent provision ask should be logged');
  assert.equal(record!.bankKey, 'provision.ask.rent', 'bankKey should be provision.ask.rent');

  db.close();
});
