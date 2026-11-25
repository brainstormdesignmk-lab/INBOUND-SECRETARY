/**
 * THE [05:20] BUSINESS PAIR — ONE UNIT PER PLACE THE CLIENT NAMED.
 *
 * The operator's rule, in his own words: «HE SAID PRIMARY CENTAR, RAMPA SECOND
 * OPTION SO SHE MUST GIVE ONE OF EACH — CENTER / RAMPA IN THE PAIR. IN THIS
 * TURN SHE WAS FOCUSED ON RAMPA — WRONG».
 *
 * What happened: «PA CENTAR U GLOBALA AMA MOZE I KISELA VODA OKOLU RAMPA» names
 * TWO places — the client's primary (a district) and his second option (a
 * landmark) — and the serve ranked the whole business pool by distance to the
 * NEAREST anchor, so both rows came from the Рампа side and the primary place
 * was never served. A two-place ask is a comparison BETWEEN PLACES; the pair is
 * one unit each, in the client's own order.
 *
 * The fixture places the two places far apart in the real map (Аеродром vs
 * Рампа) so the assertion is unambiguous: with the old ranking BOTH rows are
 * the Рампа-side ones and the Аеродром row is never shown.
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
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

function makeHandler(rows: Property[], id: string) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent[sent.length - 1] ?? '';
  };
  return { say, sessions, chatId: id };
}

// Coordinates are the SHIPPED map's own anchors (тобако РАМПА 41.9870,21.4369 ·
// Аеродром 41.9840,21.4650 — 2.4 km apart, just outside the 2 km business
// ring), so each place can only be answered by its own cluster: one business
// space at Аеродром, two on the Рампа side. All three carry Центар as the
// feed's area word, which is exactly the trap — the AREA does not decide where
// a unit stands.
const STOCK: Property[] = [
  { eb: 59, id: 59, location: 'Аеродром', address: 'Ул. А 1', price: 950, sqm: 105, size: '105 м²', service: 'rent', business: true, lat: 41.9840, lon: 21.4650 },
  { eb: 42, id: 42, location: 'Центар', address: 'Ул. Б 2', price: 1000, sqm: 126, size: '126 м²', service: 'rent', business: true, lat: 41.9870, lon: 21.4370 },
  { eb: 57, id: 57, location: 'Центар', address: 'Ул. В 3', price: 1000, sqm: 90, size: '90 м²', service: 'rent', business: true, lat: 41.9878, lon: 21.4378 },
];

test('two named places: the business pair is ONE unit per place, in his order', async () => {
  const { say } = makeHandler(STOCK, 'biz-two-places');
  // The business funnel asks its own criterion first (the capture's client had
  // already answered it); the turn under test is the two-place ask.
  await say('SAKAM DA IZNAJMAM DELOVEN PROSTOR');
  await say('OKOLU 100 KVADRATI');
  const reply = await say('PRVO AERODROM AMA MOZE I OKOLU RAMPA');
  // The lead names BOTH places: he asked for a comparison between them. The
  // map's own wording is «тобако РАМПА» (capitals), so the assertion folds case.
  assert.match(reply, /аеродром/iu, `the primary place is named: ${reply}`);
  assert.match(reply, /рампа/iu, `the second option is named: ${reply}`);
  // …and in HIS order: the primary place leads the sentence.
  assert.ok(reply.search(/аеродром/iu) < reply.search(/рампа/iu),
    `the place he named FIRST must lead: ${reply}`);
  // …and the pair holds one of each. The Аеродром unit is the only one that can
  // answer his FIRST place, so it must be on the table.
  assert.match(reply, /Евидентен број 59/u,
    `the primary place's unit must be served — the old ranking served both Рампа-side rows: ${reply}`);
  // The second card is a Рампа-side row (42 or 57), never the same row twice.
  assert.match(reply, /Евидентен број (?:42|57)/u, `the second option's unit is served: ${reply}`);
  assert.equal(new Set(reply.match(/Евидентен број \d+/gu)).size, 2,
    `exactly two cards, and no row served twice: ${reply}`);
});

test('one named place keeps the pair protocol: the two nearest units', async () => {
  // A single place is NOT a comparison between places — the two nearest units
  // are the protocol it always had, and this fix must not narrow it to one.
  const { say } = makeHandler(STOCK, 'biz-one-place');
  await say('SAKAM DA IZNAJMAM DELOVEN PROSTOR');
  await say('OKOLU 100 KVADRATI');
  const reply = await say('OKOLU RAMPA');
  assert.match(reply, /Евидентен број 42/u, `the nearest unit: ${reply}`);
  assert.match(reply, /Евидентен број 57/u, `and the second nearest: ${reply}`);
});

test('the served business pair is MEASURED when the client asks how far it stands', async () => {
  // Defect #2 of the [05:20] capture: the same question was answered with the
  // business-area question ("За кој дел од градот сте најмногу заинтересирани…"),
  // never with a distance, although the pair on the table IS measurable. The
  // lane that owns it is the distance matrix — one measured line per row, the
  // same rule the residential pair already had.
  const { say } = makeHandler(STOCK, 'biz-distance-pair');
  await say('SAKAM DA IZNAJMAM DELOVEN PROSTOR');
  await say('OKOLU 100 KVADRATI');
  await say('PRVO AERODROM AMA MOZE I OKOLU RAMPA');
  const reply = await say('NA KOE RASTOJANIE SE OD RAMPA ?');
  assert.match(reply, /Растојание/u, `the answer is a measured line: ${reply}`);
  for (const eb of ['42', '59']) {
    assert.match(reply, new RegExp(`Евидентен број ${eb}[\\s\\S]{0,40}(?:метри|километар|km)`, 'u'),
      `EB ${eb} is measured, not dropped: ${reply}`);
  }
  // …and it is never the area grill: he named the place, she knows the pair.
  assert.doesNotMatch(reply, /За кој дел од градот/ui, `never the business-area question: ${reply}`);
});

// ── defects #3, #4, #5: the pair ON THE TABLE is the referent ───────────────
// A stock that still holds an unshown unit at his SIZE: the 126/105 pair has
// gone out, 57 is too small for «околу 100 квадрати» and 88 is the next one.
const STOCK_MORE: Property[] = [
  ...STOCK,
  { eb: 88, id: 88, location: 'Центар', address: 'Ул. Г 4', price: 1200, sqm: 140, size: '140 м²', service: 'rent', business: true, lat: 41.9885, lon: 21.4385 },
];

test('«освен овие … дали имате други?» serves the NEXT unshown unit, never the same cards again', async () => {
  // Defect #3 of the [05:20] capture. Two things went wrong: the detector read
  // «дали … имате» as the SINGLE-FLAT availability question (the objectAsk
  // veto), and the plural availability leg then re-answered the very two cards
  // the client had just read — with the visit fee on top. He asked for OTHER
  // properties and was quoted a viewing.
  const { say, sessions, chatId } = makeHandler(STOCK_MORE, 'pair-more-stock');
  await say('SAKAM DA IZNAJMAM DELOVEN PROSTOR');
  await say('OKOLU 100 KVADRATI');
  // THE SIZE IS NOT A BUDGET: «околу 100 квадрати» set a 100-euro monthly cap
  // as well, and every later pool query filtered on it (the field answer was
  // «нема деловни простори од 126 м² до 100 евра месечно»).
  assert.equal(sessions.get(chatId)?.slots.budget, undefined,
    'a size in м² is never stored as a money budget');
  const pair = await say('PRVO AERODROM AMA MOZE I OKOLU RAMPA');
  for (const eb of [59, 42]) {
    assert.match(pair, new RegExp(`Евидентен број ${eb}`, 'u'), `the pair: ${pair}`);
  }
  const reply = await say('OSVEN OVIE STO MI GI POKAZA DALI IMATE DRUGI ?');
  // The unshown unit is served…
  assert.match(reply, /Евидентен број 88/u, `the next unshown unit: ${reply}`);
  // …and NEITHER card he already read comes back.
  for (const eb of [59, 42]) {
    assert.doesNotMatch(reply, new RegExp(`Евидентен број ${eb}(?!\\d)`, 'u'),
      `a card already served must not repeat: ${reply}`);
  }
  // No availability claim and no fee: this is stock, not a viewing.
  assert.doesNotMatch(reply, /достапн/iu, `never the availability ack: ${reply}`);
  assert.doesNotMatch(reply, /надомест|денари|провизиј/iu, `never the fee: ${reply}`);
  // The session moved out of discovery: cards went out, so the next stock ask
  // must not cross the state-lane guard that denies a property batch there.
  assert.equal(sessions.get(chatId)?.state, 'presentation');
});

test('«освен овие … дали имате други?» with nothing left says so honestly', async () => {
  // The drained arm. The stock here is EXACTLY the pair (expectation fixed
  // while writing this: with the third 90 м² row in the feed the pool was not
  // empty — the size filter relaxes rather than deny stock, so «околу 100
  // квадрати» correctly continues to the 90 м² unit. Drained means the search
  // has nothing else AT ALL, which is a two-row feed), so the answer is the
  // honest exhausted line + the pivot, never a repeat of the served pair and
  // never the fee.
  const { say } = makeHandler(STOCK.slice(0, 2), 'pair-more-drained');
  await say('SAKAM DA IZNAJMAM DELOVEN PROSTOR');
  await say('OKOLU 100 KVADRATI');
  await say('PRVO AERODROM AMA MOZE I OKOLU RAMPA');
  const reply = await say('OSVEN OVIE STO MI GI POKAZA DALI IMATE DRUGI ?');
  // CONTRACT-LEVEL, not one wording (AGENTS.md §2): the bank rotates variants,
  // so the assertion is "it says the stock is ALL reviewed" plus "it offers the
  // pivot" — pinning the sentence I happened to see would fail on the next
  // variant.
  assert.match(reply, /сите|исцрпив|повеќе немам/iu, `the honest drained line: ${reply}`);
  // …and the pivot's own wording rotates too: «поштo излезе нешто соодветно» /
  // «известам» and the offer of ANOTHER part of the city («друга населба», «друг
  // дел од градот»). Pinning only «друга населба» failed on a legitimate variant.
  assert.match(reply, /известам|друга населба|друг дел од градот/iu, `the pivot follows: ${reply}`);
  assert.doesNotMatch(reply, /Евидентен број \d+ ·/u, `no card is re-served: ${reply}`);
  assert.doesNotMatch(reply, /надомест|денари|провизиј/iu, `never the fee: ${reply}`);
});

test('«колку м² имаат двата дуќани?» answers BOTH rows, in business wording', async () => {
  // Defect #4 of the [05:20] capture: one row was answered, and a BUSINESS
  // space was called «станбена површина». The pair referent list was
  // Cyrillic-only, so a Latin «DVATA» named no pair at all.
  const { say } = makeHandler(STOCK, 'pair-both-sqm');
  await say('SAKAM DA IZNAJMAM DELOVEN PROSTOR');
  await say('OKOLU 100 KVADRATI');
  await say('PRVO AERODROM AMA MOZE I OKOLU RAMPA');
  const reply = await say('KOLKU M2 IMAAT DVATA DUKJANI ?');
  // Both figures are on the table, each attached to its own Евидентен број.
  assert.match(reply, /(?:Евидентен број 59|Евидентен број 42|Број 59|Број 42)/u, reply);
  assert.match(reply, /105 м²/u, `the first row's surface: ${reply}`);
  assert.match(reply, /126 м²/u, `the second row's surface: ${reply}`);
  assert.equal(new Set(reply.match(/Евидентен број \d+/gu)).size, 2,
    `each clause names its own row: ${reply}`);
  // A дуќан has no living surface.
  assert.doesNotMatch(reply, /станбена/iu, `a business space is never «станбена»: ${reply}`);
  assert.match(reply, /деловна/iu, `the wording follows the row: ${reply}`);
});

test('«кој има 126 м²?» names the pair member, never a fresh search', async () => {
  // Defect #5 of the [05:20] capture: the figure a served row carries was read
  // as a SEARCH CRITERION, and the number became money («нема деловни простори
  // од 126 м² до 100 евра месечно»). A figure on the table is an IDENTIFIER.
  const { say, sessions, chatId } = makeHandler(STOCK, 'pair-which-figure');
  await say('SAKAM DA IZNAJMAM DELOVEN PROSTOR');
  await say('OKOLU 100 KVADRATI');
  await say('PRVO AERODROM AMA MOZE I OKOLU RAMPA');
  const reply = await say('KOJ IMA 126 M2 ?');
  assert.match(reply, /Евидентен број 42/u, `the row carrying 126 м²: ${reply}`);
  assert.doesNotMatch(reply, /Евидентен број 59(?!\d)/u, `not the other row: ${reply}`);
  // …and it is an answer, not a search.
  assert.doesNotMatch(reply, /нема деловни простори|до 100 евра|претпочитана локација/iu,
    `never a fresh search: ${reply}`);
  // The discussion moves to the row he pointed at.
  assert.equal(sessions.get(chatId)?.slots.propertyId, 42);
});

test('«кој има 90 м²?» is answered from the OFFER when the table has no such row', async () => {
  // THE COLD LEG of defect #5. The pair on the table is 105 м² + 126 м²; the
  // client asks about 90 м², a figure no served row carries. The old block fell
  // through on purpose, so the same identity question was served as a fresh
  // search (and, in the field, read as money). A figure is still an IDENTIFIER:
  // the row that carries it is named, out of the whole offer, in the funnel's
  // own category.
  const { say, sessions, chatId } = makeHandler(STOCK, 'pair-which-figure-cold');
  await say('SAKAM DA IZNAJMAM DELOVEN PROSTOR');
  await say('OKOLU 100 KVADRATI');
  await say('PRVO AERODROM AMA MOZE I OKOLU RAMPA');
  const reply = await say('KOJ IMA 90 M2 ?');
  assert.match(reply, /Евидентен број 57/u, `the row carrying 90 м²: ${reply}`);
  assert.doesNotMatch(reply, /нема деловни простори|претпочитана локација/iu,
    `never a fresh search: ${reply}`);
  // The cold row was NOT served as a card (no ad text, no owner-confirm line);
  // the identity line is the answer, and the discussion moves to it.
  assert.doesNotMatch(reply, /достапна|сопственикот/iu, `an identity line, not a card: ${reply}`);
  assert.equal(sessions.get(chatId)?.slots.propertyId, 57);
});

test('«кој има 300 м²?» says the offer has none — never a search with 300 as money', async () => {
  const { say, sessions, chatId } = makeHandler(STOCK, 'pair-which-figure-none');
  await say('SAKAM DA IZNAJMAM DELOVEN PROSTOR');
  await say('OKOLU 100 KVADRATI');
  await say('PRVO AERODROM AMA MOZE I OKOLU RAMPA');
  const reply = await say('KOJ IMA 300 M2 ?');
  assert.match(reply, /нема недвижност со 300 м²/iu, `the honest absence line: ${reply}`);
  assert.match(reply, /\?\s*$/u, `and it ends with the question: ${reply}`);
  assert.doesNotMatch(reply, /Евидентен број \d+ ·/u, `no card is invented: ${reply}`);
  // The number is a figure, never a price ceiling.
  assert.doesNotMatch(reply, /до 300 евра|300 евра месечно/iu, `300 is not money: ${reply}`);
  // Nothing was re-pointed: the row under discussion stands.
  assert.notEqual(sessions.get(chatId)?.slots.propertyId, 300);
});
