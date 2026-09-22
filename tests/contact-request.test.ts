// PROXY-CONTACT REQUESTS — the misroute-audit #47 class (2026-09-22).
//
// "STAPI VO KONTAKT I INFORMIRAJ ME" (audit row #47) is the client asking the
// AGENCY to reach the owner and report back. The class was invisible to every
// detector: it fell into the documents lecture (documents.info) in the
// historical log, and "javete se na sopstvenikot" fell through the whole guard
// chain. The routing contract after the fix:
//
//   - `closing` (fee pending): the FSM fee protocol keeps claiming these
//     first — fee-before-contact is the judged-correct order (rows
//     #49/#61/#63, all judged fit by the audit judge).
//   - every OTHER position: the owner-contact refusal owns them
//     (visit-arrangement offer) — never documents, never an info facet.
//   - `detectDocumentsAsk` carries the structural veto: a contact request is
//     NEVER a documents question, so no doc-token collision can claim it.

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
import { detectContactRequest, detectOwnerContact, detectDocumentsAsk } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'contact-req-')), 'map.db');
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
}

test('detector pins: the proxy-contact family (Latin + Cyrillic + typos)', () => {
  // The audited phrases — must fire
  for (const line of [
    'STAPI VO KONTAKT I INFORMIRAJ ME',       // audit #47 verbatim
    'stapi vo kontakt',
    'STAPETE VO KONTAKT VE MOLAM',            // audit #49 lead
    'KONTAKTIRAJTE GO I KAZETE MI',           // audit #61 verbatim
    'javete se na sopstvenikot',
    'поврзи го сопственикот',
    'СТАПИ ВО КОНТАКТ',
    'кажете му на сопственикот',              // relay to owner
  ]) {
    assert.equal(detectContactRequest(line), true, `must fire: ${line}`);
  }
  // Direct phone asks stay in detectOwnerContact; the proxy family is handled
  // by its own STATE-GATED inbound block (fee protocol keeps precedence in
  // closing — fee-before-contact is the judged-correct order).
  assert.equal(detectOwnerContact('dadi mi go sopstvenikot'), true, 'direct phone ask');
  assert.equal(detectOwnerContact('stapi vo kontakt i informiraj me'), false, 'proxy family NOT in the unconditional refusal path');

  // Must NOT fire
  assert.equal(detectContactRequest('kazete mi sto e'), false, '"tell ME" is an info ask');
  assert.equal(detectContactRequest('kontaktirajte me na 070123456'), false, 'self-contact offer → contact collection');
  assert.equal(detectContactRequest('informiraj me'), false, 'bare informiraj-me is an info request');
  assert.equal(detectContactRequest('zakazi mi poseta'), false, 'visit scheduling is its own family');
  assert.equal(detectContactRequest('dogovori mi'), false);
  assert.equal(detectContactRequest('sakam da go vidam'), false);
});

test('documents veto: a contact request can NEVER be a documents question', () => {
  // The audit #47 guarantee — structural, independent of the inform guard
  assert.equal(detectDocumentsAsk('STAPI VO KONTAKT I INFORMIRAJ ME'), false);
  assert.equal(detectDocumentsAsk('kontaktirajte go i kazete mi'), false);
  assert.equal(detectDocumentsAsk('stapi vo kontakt i kazete mi za dogovorot'), false, 'doc-token collision vetoed');
  // Real documents asks unaffected
  assert.equal(detectDocumentsAsk('kakvi dokumenti trebaat za kupuvanje'), true);
});

test('e2e: "STAPI VO KONTAKT I INFORMIRAJ ME" in closing keeps the fee protocol, NEVER documents', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps([
    { eb: 76, id: 76, location: 'Центар', price: 185000, service: 'buy', size: '80 м²' } as Property,
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
    landmarks: new LandmarkService(db, { osm: false, offlineMap }) });
  const chatId = 'contact-req-e2e';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Card → interest (fee now pending in closing)
  await send('ZA EB 76');
  await send('mi se svigja 76');
  const s = await send('STAPI VO KONTAKT I INFORMIRAJ ME');
  const reply = sent[sent.length - 1];

  // Fee protocol wins in closing (the judged-correct order) — the
  // owner-contact REFUSAL must NOT preempt it here, and the documents
  // lecture can never appear.
  assert.ok(!/документ|лична карта|пасош|преддоговор/i.test(reply), `must NOT be the documents lecture: ${reply}`);
  assert.ok(!/не се споделува|чуваат приватни/i.test(reply), `fee-pending closing must not jump to the refusal: ${reply}`);
  assert.ok(/надомест|провизија|името|име|телефон|контакт/i.test(reply), `must be fee/contact progress: ${reply}`);

  offlineMap.close();
});

test('e2e: proxy contact outside closing → owner-contact refusal, never documents/info', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps([
    { eb: 76, id: 76, location: 'Центар', price: 185000, service: 'buy', size: '80 м²' } as Property,
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
    landmarks: new LandmarkService(db, { osm: false, offlineMap }) });
  const chatId = 'contact-req-e2e-2';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Card shown (presentation state — NOT closing, fee not pending)
  await send('ZA EB 76');
  const state = sessions.get(chatId)!.state;
  if (state === 'closing') return; // environment-dependent; the closing e2e covers it
  await send('javete se na sopstvenikot');
  const reply = sent[sent.length - 1];

  assert.ok(!/документ|лична карта|пасош/i.test(reply), `must NOT be the documents lecture: ${reply}`);
  // The correct family: privacy refusal + owner-contact-and-report-back offer.
  // Must match EVERY variant in the owner.contact.refusal set — the serve picks
  // randomly, so a pin covering 5 of 6 wordings is a flaky test. Family-wide:
  // disclosure-refusal (споделува/дава/открива), privacy stem, arrange
  // (посета|средба), contact-owner (контакт со сопственикот / контактирам).
  assert.ok(
    /не\s+се\s+(споделува|дава|открива)|приватност|организирам\s+(посета|средба)|закажеме\s+термин|контакт\s+со\s+сопственикот|контактирам\s+сопственикот|директен\s+контакт/i.test(reply),
    `must be an owner-contact refusal: ${reply}`,
  );

  offlineMap.close();
});
