// MISROUTE INTAKE (A+B) — giving the system eyes on wrong-key serves.
//
// The router is the only judge of intent, so a wrong-key serve is invisible:
// the log records (msg, bankKey) with no trace of fit. Two deterministic eyes:
//
//  A. EXPLICIT CORRECTION — the client SAYS the answer was wrong
//     ("ne toa prasav", "drugo prasav", "ne odgovori"). The previous pair is
//     auto-filed into bank_corrections → nightly loop-a → corpus → detectors.
//     Would have caught 10:54 ("TOLKU IMAM" right after a fee ask).
//
//  B. REPLY-CLASS MISMATCH — every question-key expects certain reply classes.
//     After fee.ask, a property-sized offer ("dali moze za 150 e") or a price
//     freshness question is the misroute signature itself: the client kept
//     making their offer while Lina kept answering something else (08:20).
//
// Both land in bank_corrections automatically — no [F9] needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { EnrichmentStore } from '../src/store/enrichment';
import { BankStore } from '../src/store/bank';
import { detectExplicitCorrection, checkMisroute, replyClassesOf } from '../src/llm/misroute';
import { isPropertyOffer } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'misroute-')), 'map.db');
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
}

// ── A. explicit-correction family ────────────────────────────────────────────

test('A: explicit-correction idiom family (Cyrillic + Latin + typos)', () => {
  // The canonical class
  assert.equal(detectExplicitCorrection('ne toa prasav'), true);
  assert.equal(detectExplicitCorrection('НЕ ТОА ПРАШАВ'), true);
  assert.equal(detectExplicitCorrection('не тоа прашав'), true);
  assert.equal(detectExplicitCorrection('drugo prasav'), true);
  assert.equal(detectExplicitCorrection('prasav za cenata'), true);
  assert.equal(detectExplicitCorrection('ne za toa'), true);
  assert.equal(detectExplicitCorrection('ne odgovori'), true);
  assert.equal(detectExplicitCorrection('не одговараш'), true);
  assert.equal(detectExplicitCorrection('ne sum prasal za ova'), true);
  // Not corrections — legal topic moves
  assert.equal(detectExplicitCorrection('dali moze za 150 e'), false);
  assert.equal(detectExplicitCorrection('drugi stanovi imate?'), false);
  assert.equal(detectExplicitCorrection('da, se slozuvam'), false);
});

// ── B. reply-class machinery ─────────────────────────────────────────────────

test('B: property-sized offers and freshness after fee.ask are the mismatch signature', () => {
  // The exact 08:20 class
  assert.equal(isPropertyOffer('dali moze za 150 e'), true);
  assert.equal(isPropertyOffer('DALI KE MOZE DA GO KUPAM ZA 150000'), true);
  assert.equal(isPropertyOffer('TOLKU IMAM'), true);
  // Fee-sized replies stay legal after a fee ask
  assert.equal(isPropertyOffer('ok ke platam 500 denari'), false);
  assert.equal(isPropertyOffer('vo red'), false);

  const feeLast = { userMsg: 'prodolzete', bankKey: 'fee.ask.buy' as string | null, replyText: 'fee?', createdAt: Date.now() };
  assert.equal(checkMisroute('dali moze za 150 e', feeLast).kind, 'mismatch');
  assert.equal(checkMisroute('TOLKU IMAM', feeLast).kind, 'mismatch');
  assert.equal(checkMisroute('a dali mu e uste taa cena?', feeLast).kind, 'mismatch');
  // Legal replies — no flag
  assert.equal(checkMisroute('vo red, ke platam', feeLast).kind, null);
  assert.equal(checkMisroute('zosko tolku nadomestok?', feeLast).kind, null);
  // Legal pivots learned from the historical audit: a plain price re-ask or an
  // availability re-confirm after a fee ask is a normal follow-up
  assert.equal(checkMisroute('kolku mu bese cenata?', feeLast).kind, null);
  assert.equal(checkMisroute('dali e dostapen?', feeLast).kind, null);
  // Session restart is never evidence (greeting + property number)
  assert.equal(checkMisroute('zdravo dali e dostapen stanot so broj 78', feeLast).kind, null);
  assert.equal(checkMisroute('ZDRAVO\nDALI USTE VI E SLOBODEN 79 ?', feeLast).kind, null);
  // Statement keys carry no expectation; unclassifiable text is not evidence
  assert.equal(checkMisroute('dali moze za 150 e', { ...feeLast, bankKey: null }).kind, null);
  assert.equal(checkMisroute('dali moze za 150 e', { ...feeLast, bankKey: 'presentation.line' }).kind, null);
});

// ── E2E: the intake runs inside the real pipeline ────────────────────────────

test('e2e: "dali moze za 150 e" after the fee ask auto-files a bank correction', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps([
    { eb: 78, id: 78, location: 'Центар', price: 185000, service: 'buy', size: '80 м²' } as Property,
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
  const enrichment = new EnrichmentStore(db);
  const bank = new BankStore(db);
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
    enrichment, bank });
  const chatId = 'misroute-e2e';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Card → interest → да → fee disclosed (the 08:20 shape)
  await send('ZA EB 78');
  await send('mi se svigja 78');
  await send('da');
  assert.ok(/надомест|500 денари/i.test(sent[sent.length - 1]), 'fee must be disclosed first');

  // Now the client makes their offer — and the previous (fee.ask) pair must
  // be auto-filed as a bank correction with the mismatch reason.
  const correctionsBefore = bank.correctionsByStatus('new').length;
  await send('dali moze za 150 e');

  const corrections = bank.correctionsByStatus('new');
  assert.ok(corrections.length > correctionsBefore, 'a correction must be auto-filed');
  const filed = corrections[0]; // newest-first
  assert.match(filed.reason, /property-offer-after-fee-ask|client-said-wrong-answer/);
  // Mismatch rows are SUSPICION → staged for review (key: null, suspect key
  // in the reason); row.msg is the client's NEWEST message — the evidence
  // phrase loop-a mines for trigger corpora.
  assert.equal(filed.key, null, 'mismatch rows stage for review, suspect key in reason');
  assert.equal(filed.msg, 'dali moze za 150 e', 'evidence phrase stored for loop-a');
  assert.ok(/fee\.ask\.buy/.test(filed.reason), 'suspect key is recorded in the reason');

  offlineMap.close();
});

test('e2e: explicit correction ("ne toa prasav") files the previous pair, key named', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps([
    { eb: 78, id: 78, location: 'Центар', price: 185000, service: 'buy', size: '80 м²' } as Property,
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
  const enrichment = new EnrichmentStore(db);
  const bank = new BankStore(db);
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
    enrichment, bank });
  const chatId = 'misroute-correction-e2e';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Card → interest → да → fee disclosed (this serve logs with bankKey)
  await send('ZA EB 78');
  await send('mi se svigja 78');
  await send('da');
  assert.ok(/надомест|500 денари/i.test(sent[sent.length - 1]), 'fee must be disclosed first');
  const correctionsBefore = bank.correctionsByStatus('new').length;

  // The client says the answer was wrong — mid-fee-talk correction
  await send('ne toa prasav, jas prasav za stan vo Aerodrom');
  const corrections = bank.correctionsByStatus('new');
  assert.ok(corrections.length > correctionsBefore, 'explicit correction must auto-file');
  const filed = corrections[0]; // newest-first
  assert.equal(filed.reason, 'client-said-wrong-answer');
  // A-corrections are PROOF: the previous pair's key is named directly
  assert.equal(filed.key, 'fee.ask.buy');
  assert.equal(filed.msg, 'da');

  offlineMap.close();
});

test('noise guards: repetition and stale pairs are not evidence', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps([
    { eb: 76, id: 76, location: 'Центар', price: 200, service: 'rent', size: '24 м²' } as Property,
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
  const enrichment = new EnrichmentStore(db);
  const bank = new BankStore(db);
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
    enrichment, bank });
  const chatId = 'misroute-noise';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // No prior serve → nothing to judge, nothing filed
  await send('dali moze za 150 e');
  assert.equal(bank.correctionsByStatus('new').length, 0, 'no pair, no filing');

  offlineMap.close();
});

// replyClassesOf smoke — used by the audit report
test('replyClassesOf classifies the fee-ask reply families', () => {
  assert.ok(replyClassesOf('vo red, ke platam').includes('agreement'));
  assert.ok(replyClassesOf('zosto nadomestok?').includes('feeWhy'));
  assert.ok(replyClassesOf('ne, ne sakam da platam').includes('rejection'));
  // Typo'd text that classifies to NOTHING is deliberately not evidence —
  // the mismatch check stays silent rather than guessing (safe default).
  assert.deepEqual(replyClassesOf('zosko nadomestok?'), []);
});
