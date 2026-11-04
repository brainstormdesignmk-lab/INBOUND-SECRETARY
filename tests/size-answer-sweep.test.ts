// THE SIZE-ANSWER SWEEP — every shape a client uses to answer «колку спални
// соби?» must LAND, and none may make the funnel ask the same question again.
//
// Harvested from the field captures before writing this file:
//
//   python3 - <<'PY'   # every distinct size-worded client message in data/*.jsonl
//   … rows whose text matches spaln|sobi|soba|garsonjer|ednosob|dvosob|trosob|
//     so edna|so dve|so tri|N+N
//   PY
//
// 54 distinct messages; the ANSWER shapes (as opposed to recall/locate asks,
// which own their own lanes) are the list below, with market-standard siblings
// for the notations the captures contain only once («2+1», «1+1», «3+1»).
//
// THE TWO CONVENTIONS this sweep pins, both shared with `detectBedrooms`:
//   • «една спална» is a ДВОСОБЕН (2 rooms) and «две спални» a ТРИСОБЕН (3) —
//     `roomsFromBedrooms`; the same +1 applies to the plus-notation («2+1» = two
//     bedrooms + living room = 3 rooms) and to a BARE count answering the ask
//     («2» = two bedrooms = 3 rooms);
//   • «DVE SOBI» / «2 SOBI» name ROOMS directly — no +1.
//
// A shape may settle the size axis without a number: «GARSONJERA» (the studio
// IS the size answer), «SPALNI BILO KOLKU» / «NEBITNO» (slots.sizeWaived).

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
import { OfflineMapStore } from '../src/geo/offlineMap';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// One row per room category, all within every cap used below, so a landed size
// criterion always has something to serve.
const ROWS: Property[] = [
  { eb: 801, id: 801, location: 'Центар', price: 58000, bedrooms: 1, sqm: 30, size: '30 м²', service: 'buy', lat: 41.9993, lon: 21.4165 },
  { eb: 802, id: 802, location: 'Центар', price: 88000, bedrooms: 2, sqm: 44, size: '44 м²', service: 'buy', lat: 41.9992, lon: 21.4166 },
  { eb: 803, id: 803, location: 'Центар', price: 96000, bedrooms: 2, sqm: 48, size: '48 м²', service: 'buy', lat: 41.9991, lon: 21.4164 },
  { eb: 804, id: 804, location: 'Центар', price: 140000, bedrooms: 3, sqm: 68, size: '68 м²', service: 'buy', lat: 41.9990, lon: 21.4163 },
  { eb: 805, id: 805, location: 'Центар', price: 170000, bedrooms: 4, sqm: 85, size: '85 м²', service: 'buy', lat: 41.9989, lon: 21.4162 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new FakeProps(ROWS);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId: id };
}

/** THE SIZE QUESTION itself — as a question. A card may SAY «две спални соби»
 *  (the feed writes it in every description); only a «?» after the noun, or a
 *  «колку/колкав … спални» clause, is the funnel asking it. The waiver ACK
 *  («големината не е проблем») is not an ask and must not match. */
const ASKS_SIZE = /колку спални|колкав број на спални|спални соби[^.!?\n]{0,40}\?/iu;

interface Case {
  text: string;
  /** ROOMS, the feed's axis (bedrooms field). */
  rooms?: number;
  range?: [number, number];
  garsonjera?: boolean;
  waived?: boolean;
}

const CASES: Case[] = [
  // ── the funnel's own vocabulary: bedrooms (rooms = bedrooms + 1) ──────────
  { text: 'DVE SPALNI', rooms: 3 },
  { text: 'SO DVE SPALNI', rooms: 3 },
  { text: 'EDNA SPALNA', rooms: 2 },
  { text: 'daj so edna', rooms: 2 },
  { text: 'BARAM STAN SO EDNA SPALNA DO 100000 EVRA', rooms: 2 },
  { text: 'DAJ MI DVE SPALNI DO 500', rooms: 3 },
  { text: '350 EVRA IMAM 2 SPALNI PREPORACLIVO MOZE I EDNA AKO E DOBAR', rooms: 3 },
  // ── bare counts: a number answering «колку спални?» is BEDROOMS ───────────
  { text: '2', rooms: 3 },
  { text: 'DVA', rooms: 3 },
  // ── the plus-notation (bedrooms + living room) ───────────────────────────
  { text: '2+1', rooms: 3 },
  { text: '1+1', rooms: 2 },
  { text: '3+1', rooms: 4 },
  // ── rooms named DIRECTLY: no +1 ──────────────────────────────────────────
  { text: 'DVE SOBI', rooms: 2 },
  { text: 'SO DVE SOBI', rooms: 2 },
  { text: '2 SOBI', rooms: 2 },
  // ── the room-type adjective ──────────────────────────────────────────────
  { text: 'DVOSOBEN', rooms: 2 },
  { text: 'DVOSOBEN MI TREBA', rooms: 2 },
  { text: 'DA KUPAM SAKAM DVOSOBEN', rooms: 2 },
  { text: 'TROSOBNI IMAS', rooms: 3 },
  { text: 'A TROSOBNI', rooms: 3 },
  { text: 'DVOSOBEN ILI TROSOBEN DO 190 000 EVRA', rooms: 2 },
  // ── flexibility: a RANGE, never a minimum ────────────────────────────────
  { text: 'EDNA ILI DVE', range: [2, 3] },
  { text: 'moze i so edna , a moze i so dve', range: [2, 3] },
  // ── the counted category pair: one bedroom / two bedrooms, cap each ──────
  { text: 'MOZE SO EDNA DO 100 000 ILI SO DVE DO 150 000', range: [2, 3] },
  // ── the studio IS the size answer ────────────────────────────────────────
  { text: 'GARSONJERA', garsonjera: true },
  { text: 'garsonjera so edna', garsonjera: true },
  // ── a released size ──────────────────────────────────────────────────────
  { text: 'SPALNI BILO KOLKU', waived: true },
  { text: 'NEBITNO', waived: true },
];

test('every captured size answer LANDS and none re-asks «колку спални соби?»', async () => {
  const failures: string[] = [];
  for (const [i, c] of CASES.entries()) {
    const { say, sessions, chatId } = makeHandler(`size-${i}`);
    // The funnel's real opening: the place is known, so the bedrooms and price
    // questions are the ones on the table.
    await say('ZDRAVO SAKAM DA KUPAM STAN OKOLU UNIVERZALNA SALA');
    const reply = await say(c.text);
    const s = sessions.get(chatId)!.slots;

    if (ASKS_SIZE.test(reply)) {
      failures.push(`${JSON.stringify(c.text)} → THE SIZE QUESTION CAME BACK: ${reply.replace(/\s+/g, ' ').slice(0, 140)}`);
      continue;
    }
    // The axis must be SETTLED, whatever wording the client chose.
    const settled = s.bedrooms !== undefined
      || (s.bedroomsMin !== undefined && s.bedroomsMax !== undefined)
      || s.garsonjera === true
      || s.sizeWaived === true;
    if (!settled) {
      failures.push(`${JSON.stringify(c.text)} → nothing landed on the size axis: ${JSON.stringify(s)}`);
      continue;
    }
    if (c.rooms !== undefined && s.bedrooms !== c.rooms) {
      failures.push(`${JSON.stringify(c.text)} → rooms ${s.bedrooms}, expected ${c.rooms}`);
    }
    if (c.range) {
      if (s.bedroomsMin !== c.range[0] || s.bedroomsMax !== c.range[1]) {
        failures.push(`${JSON.stringify(c.text)} → range ${s.bedroomsMin}..${s.bedroomsMax}, expected ${c.range[0]}..${c.range[1]}`);
      }
    }
    if (c.garsonjera && s.garsonjera !== true) failures.push(`${JSON.stringify(c.text)} → the studio category was lost`);
    if (c.waived && s.sizeWaived !== true) failures.push(`${JSON.stringify(c.text)} → the waiver was lost`);
  }
  assert.deepEqual(failures, []);
});
