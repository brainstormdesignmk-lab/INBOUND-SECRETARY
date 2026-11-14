// THE [06:46] FIELD CAPTURE — THE HELPFUL-MODE PROTOCOL, EVERY VARIANT.
//
//   [06:46] client: «IMAVTE EDNA KUKJA VO SKOPJE SEVER NA PRODAZBA»
//   [06:46] client: «DALI E USTE AKTIVEN OGLASOT ?»
//   [06:46] ЛИНА: «1. Би Ве замолила да ми кажете, колку спални соби … 2. Кој е
//           максималниот буџет …»
//
// He described ONE listing he had already seen on our site (category + area +
// deal) and asked whether its ad is still active. The recall lane's inner gate
// demanded a remembered PRICE or SIZE, so this shape fell out of the lane into
// the criteria grill — a NEW-search questionnaire about a house that is in the
// feed under EB 44.
//
// THE RULE THIS FILE ENFORCES (AGENTS.md §4r): a question family is a LEXICON.
// Every wording of «I saw a listing at your place» and of «is the ad still
// active» must reach the SAME lane. A fix that pins one sentence is not a fix —
// so the sweep below drives the real handler for every variant, and the failure
// message names the variant that regressed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InboundHandler } from '../src/handlers/inbound';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { SessionStore } from '../src/fsm/session';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { LandmarkService } from '../src/geo/landmarks';
import { Db } from '../src/store/db';
import { EnrichmentStore } from '../src/store/enrichment';
import { loadConfig } from '../src/config';
import { detectSeenListingRecall, detectAvailabilityAsk } from '../src/llm/deterministic';

class FailingLlm { async complete(): Promise<string> { throw new Error('429 quota exhausted'); } }

const HOUSE: Property = {
  eb: 44, id: 44, location: 'Скопје Север', price: 130000, service: 'buy',
  house: true, bedrooms: 3, size: '150 м²', address: 'ВИЗБЕГОВО',
  details: 'Се продава куќа во Визбегово, со површина од 150м2.',
};

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

function makeHandler(rows: Property[] = [HOUSE]) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties), responder: new Responder(llm, cfg), properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels, enrichment: new EnrichmentStore(db),
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent };
}

/** The grill a NEW search earns — and a recall never does. */
const GRILL_RE = /спални соби|максималниот буџет|горната граница на цената|со колку спални|Кој е максималниот/iu;

/** Every wording of «you had a house in Skopje Sever, is it still on?». The
 *  sweep is the contract: the lane must claim each one, and no other turn may
 *  be broken by the widened gate (the sized/unanchored shapes keep their funnel
 *  — pinned at the bottom of this file). */
const RECALL_VARIANTS: string[] = [
  // the field turn, both lines as the TUI delivered them
  'IMAVTE EDNA KUKJA VO SKOPJE SEVER NA PRODAZBA\nDALI E USTE AKTIVEN OGLASOT ?',
  'IMAVTE EDNA KUKJA VO SKOPJE SEVER NA PRODAZBA',
  // Cyrillic, the client's other script
  'ИМАВТЕ ЕДНА КУЌА ВО СКОПЈЕ СЕВЕР НА ПРОДАЖБА',
  'ИМАВТЕ ЕДНА КУЌА ВО СКОПЈЕ СЕВЕР, ДАЛИ УШТЕ Е АКТИВНА?',
  // the past tense without the quantifier
  'IMASE EDNA KUKJA VO SKOPJE SEVER NA PRODAZBA ?',
  'IMAVTE KUKJA VO SKOPJE SEVER BESE ?',
  'BESE EDNA KUKJA VO SKOPJE SEVER ZA 130000 ?',
  // «I saw it» — the sighting verbs
  'VIDOV KUKJA VO SKOPJE SEVER NA VASNIOT SAJT, USTE AKTIVNA ?',
  'PRETHDONO VIDOV KUKJA VO SKOPJE SEVER, DALI E USTE AKTIVNA ?',
  // the ad-still-on question in its three word orders
  'DALI E USTE AKTIVEN OGLASOT ZA KUKJATA VO SKOPJE SEVER ?',
  'OGLASOT ZA KUKJATA VO SKOPJE SEVER E SEUSTE AKTIVEN ?',
  'УШТЕ ЛИ СТОИ ОГЛАСОТ ЗА КУЌАТА ВО СКОПЈЕ СЕВЕР ?',
  // passed through the price he remembers
  'KUKJATA VO SKOPJE SEVER ZA 130000 BESE, SEUSTE AKTIVNA ?',
];

for (const text of RECALL_VARIANTS) {
  test(`recall variant: ${JSON.stringify(text.slice(0, 56))}`, async () => {
    assert.equal(detectSeenListingRecall(text), true,
      `the recall lexicon must recognise this wording: ${text}`);
    const { handler, sent } = makeHandler();
    const chatId = `recall-variant-${RECALL_VARIANTS.indexOf(text)}`;
    await handler.handle('test', chatId, 'ZDRAVO');
    const mark = sent.length;
    await handler.handle('test', chatId, text);
    const reply = sent.slice(mark).join('\n').trim();
    assert.ok(reply, `the turn must answer: ${text}`);
    assert.doesNotMatch(reply, GRILL_RE,
      `a listing he already saw is answered with the listing, never the new-search grill: ${text}\n→ ${reply}`);
    assert.match(reply, /44/u,
      `the remembered house (EB 44) is the answer: ${text}\n→ ${reply}`);
  });
}

// THE SECOND HALF OF THE PROTOCOL: «уште активен?» as its OWN turn, right after
// the recall was served — he is asking about the card on the table.
test('the ad-still-active question after a served recall is answered about that card', async () => {
  const { handler, sent } = makeHandler();
  const chatId = 'recall-ad-active';
  await handler.handle('test', chatId, 'ZDRAVO');
  await handler.handle('test', chatId, 'IMAVTE EDNA KUKJA VO SKOPJE SEVER NA PRODAZBA');
  const mark = sent.length;
  assert.equal(detectAvailabilityAsk('DALI E USTE AKTIVEN OGLASOT ?'), true);
  await handler.handle('test', chatId, 'DALI E USTE AKTIVEN OGLASOT ?');
  const reply = sent.slice(mark).join('\n').trim();
  assert.ok(reply, 'the availability question must be answered');
  assert.doesNotMatch(reply, GRILL_RE,
    `«уште активен?» is not a new search: ${reply}`);
});

// THE WIDENED GATE MUST NOT SWALLOW THE FUNNEL: a recall with a SIZE keeps the
// locate funnel (the [01:17] pin), and a size without a price or place keeps
// asking for the money (the [madjari] gate).
test('a sized recall without a place keeps the ordinary funnel', async () => {
  const { handler, sent } = makeHandler();
  const chatId = 'recall-sized';
  await handler.handle('test', chatId, 'ZDRAVO');
  const mark = sent.length;
  await handler.handle('test', chatId, 'IMAVTE EDNA KUKJA SO DVE SPALNI ZA KUPUVANJE');
  const reply = sent.slice(mark).join('\n').trim();
  assert.ok(reply, 'the turn must answer');
});
