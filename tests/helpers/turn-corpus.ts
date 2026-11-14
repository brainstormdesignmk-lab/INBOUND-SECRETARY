/**
 * PHASE 1 — THE TURN CORPUS.
 *
 * The 2,240 subtests in this repo assert lanes in PROSE: they read the served
 * sentence and hope it implies the routing decision. Nothing asserted "this
 * turn must not change state", so a factual question could quietly move the
 * funnel into `closing` and only the *next* turn's copy showed the damage
 * (the [12:35] capture: a «why did you tell me it was gone» turn answered with
 * the 500-денар fee script).
 *
 * A corpus case states FIVE dimensions explicitly, and the engine checks all
 * five against the real pipeline (`InboundHandler.handle`, LLM off):
 *
 *   intent      — the lanes the turn must be routed through (`session.lastTurn.lanes`)
 *   target      — the property the answer must be about (an evident number)
 *   facts       — literals the reply must carry (sanctioned data, not wording)
 *   prohibited  — what must never appear (the defect's own signature)
 *   stateDelta  — the state and the money counters after the turn
 *
 * Cases live in `tests/corpus/turns.jsonl`: a new field capture is one JSON
 * line, not a new test file. Adding a case must never require touching this
 * module.
 *
 * The engine also enforces the Phase 2 contract on every case: the audit
 * record must exist for the turn and must carry the text the client actually
 * received — an explanation lane is worthless if the record can disagree with
 * the sentence it claims to explain.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config';
import { Db } from '../../src/store/db';
import { SessionStore, freshSession } from '../../src/fsm/session';
import { Classifier } from '../../src/llm/classify';
import { Responder } from '../../src/llm/respond';
import { PropertyService, Property } from '../../src/data/properties';
import { AppointmentStore } from '../../src/store/appointments';
import { EscalationStore } from '../../src/store/escalations';
import { MetaStore } from '../../src/store/meta';
import { ChannelRegistry } from '../../src/channels/types';
import { InboundHandler } from '../../src/handlers/inbound';
import { LlmClient } from '../../src/llm/types';
import { recentRoutes } from '../../src/handlers/router';
import { findProjectRoot } from './project-root';
import { ROUTE_LANES } from '../../src/handlers/router';
import { LandmarkService } from '../../src/geo/landmarks';
import { OfflineMapStore, writeMap } from '../../src/geo/offlineMap';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

/** The feed as the capture days held it. A case may narrow it with `feed`. */
const FEED: Property[] = [
  {
    eb: 44, id: 44, location: 'Скопје Север', address: 'Скопје Север',
    price: 130000, bedrooms: 4, sqm: 150, service: 'buy', house: true,
    lat: 42.0345, lon: 21.4149, geo_source: 'osm_street_anchor',
    dostapnoOd: 'Веднаш', features: ['парно'],
    details: 'Куќа со двор, 4 собни, во Скопје Север.',
  } as Property,
  {
    eb: 55, id: 55, location: 'Влае', address: 'Влае',
    price: 40000, bedrooms: 3, sqm: 240, service: 'buy', house: true,
    lat: 42.0123, lon: 21.39, geo_source: 'osm_building',
    dostapnoOd: 'Веднаш',
    details: 'Куќа за реновирање во Влае.',
  } as Property,
  {
    eb: 66, id: 66, location: 'Центар', address: 'Рузвелтова',
    price: 137000, bedrooms: 3, sqm: 79, service: 'buy',
    lat: 41.9965, lon: 21.4315, geo_source: 'osm_building',
    dostapnoOd: 'Веднаш', features: ['лифт', 'парно'],
    details: 'Трособен стан во центар, две спални, две тераси, лифт и парно.',
  } as Property,
  {
    eb: 53, id: 53, location: 'Центар', address: 'Македонија',
    price: 55000, bedrooms: 1, sqm: 44, service: 'buy',
    lat: 41.9951, lon: 21.4315, geo_source: 'stored', dostapnoOd: 'Веднаш',
    details: 'Гарсоњера во центар.',
  } as Property,
  {
    eb: 95, id: 95, location: 'Центар', address: 'Партизанска 12',
    price: 204000, bedrooms: 3, sqm: 74, service: 'buy',
    lat: 41.9932, lon: 21.4345, geo_source: 'stored', dostapnoOd: 'Веднаш',
    details: 'Трисобен стан во Центар, реновиран.',
  } as Property,
  {
    eb: 96, id: 96, location: 'Автокоманда', address: 'Автокоманда',
    price: 88000, bedrooms: 2, sqm: 62, service: 'buy',
    lat: 42.0009, lon: 21.4681, geo_source: 'stored', dostapnoOd: 'Веднаш',
    details: 'Двособен стан во Автокоманда.',
  } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async getById(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.id === eb); }
  async getAllEbs(): Promise<Set<number>> { return new Set(this.rows.map(r => r.eb)); }
  get healthy(): boolean { return true; }
}

/** One turn of the record, as a case may replay it (the [12:35] prerequisite). */
export interface CorpusPriorTurn {
  /** The client's message. */
  text: string;
  /** What the appliance answered. */
  reply: string;
  /** The lanes that answered it, when the case knows them. */
  lanes?: string[];
}

export interface CorpusSetup {
  state?: string;
  batch?: number[];
  presented?: number[];
  location?: string;
  /** Earlier turns, oldest first, written into the audit trail. */
  recentTurns?: CorpusPriorTurn[];
}

export interface CorpusStateDelta {
  /** Expected FSM state after the last turn; 'unchanged' means it must not move. */
  state?: string;
  counters?: {
    feeRejections?: number;
    provisionRejections?: number;
  };
}

export interface CorpusCase {
  id: string;
  capture: string;
  setup?: CorpusSetup;
  /** Feed rows (evident numbers) this case needs; all six when omitted. */
  feed?: number[];
  /** Every client message of the case; the LAST one is the turn under test. */
  turns: string[];
  /** Lanes the last turn must be routed through (all of them). */
  intent: string[];
  /** The lane the router's MIRROR (ROUTING_ORDER) must predict. Absent means
   *  the case does not assert the prediction; a mismatch here is the Phase 4
   *  defect class — the mirror said one thing and another lane served. */
  predicted?: string;
  /** The property the answer must be about. */
  target?: number;
  /** Literals the answer must carry (case-insensitive). */
  facts?: string[];
  /** Regexes the answer must never match — the defect's own signature. */
  prohibited?: string[];
  stateDelta?: CorpusStateDelta;
}

export interface CorpusRun {
  reply: string;
  lanes: string[];
  stateBefore: string;
  state: string;
  /** Every lane tag logged for this chat during the last turn (router ring). */
  loggedLanes: string[];
  /** The lane the mirror predicted for this turn, when it predicted at all. */
  predicted?: string;
  feeRejections: number;
  provisionRejections: number;
  auditText: string;
}

/** The corpus lives beside the tests so it ships with them. Resolved from the
 *  PROJECT root, never from `__dirname`: the bundled gate runs these files from
 *  `dist-test/tests/`, where a relative hop lands on `dist-test/corpus` — the
 *  JSONL is not copied there, and the whole file died on ENOENT (2026-11-13). */
export const CORPUS_PATH = path.join(findProjectRoot(__dirname), 'tests', 'corpus', 'turns.jsonl');

/**
 * Parse and validate the corpus. A malformed line fails HERE, with its line
 * number, so a typo in a capture can never silently shrink the corpus.
 */
export function loadCorpus(file: string = CORPUS_PATH): CorpusCase[] {
  const raw = fs.readFileSync(file, 'utf8');
  const cases: CorpusCase[] = [];
  const seen = new Set<string>();
  raw.split('\n').forEach((line, i) => {
    const text = line.trim();
    if (!text || text.startsWith('//')) return;
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`${file}:${i + 1} is not JSON: ${(err as Error).message}`);
    }
    const where = `${path.basename(file)}:${i + 1}`;
    if (typeof parsed.id !== 'string' || !parsed.id) throw new Error(`${where}: every case needs an id`);
    if (seen.has(parsed.id)) throw new Error(`${where}: duplicate id «${parsed.id}»`);
    seen.add(parsed.id);
    if (typeof parsed.capture !== 'string' || !parsed.capture) throw new Error(`${where}: ${parsed.id} needs the capture it came from`);
    if (!Array.isArray(parsed.turns) || parsed.turns.length === 0 || parsed.turns.some((t: unknown) => typeof t !== 'string' || !t)) {
      throw new Error(`${where}: ${parsed.id} needs at least one client turn`);
    }
    // INTENT IS THE POINT: a case that does not say which lane must answer is
    // prose again, and prose is what this corpus exists to replace.
    if (!Array.isArray(parsed.intent) || parsed.intent.length === 0) {
      throw new Error(`${where}: ${parsed.id} must declare the lane(s) that answer it`);
    }
    if (parsed.target !== undefined && !Number.isFinite(parsed.target)) throw new Error(`${where}: ${parsed.id} target must be an evident number`);
    cases.push(parsed as CorpusCase);
  });
  return cases;
}

function rowsFor(c: CorpusCase): Property[] {
  if (!c.feed) return FEED;
  const wanted = new Set(c.feed);
  return FEED.filter(p => wanted.has(p.eb));
}

/** Replay a case on the real pipeline and return what actually happened. */
export async function runCorpusCase(c: CorpusCase): Promise<CorpusRun> {
  const mapPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'turn-corpus-')), 'map.db');
  writeMap(mapPath, [], []);
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_chatId, text) => { sent.push(text); } });
  const props = new FakeProps(rowsFor(c));
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(mapPath) }),
  });

  const chatId = `corpus-${c.id}`;
  const s = freshSession('test', chatId);
  const setup = c.setup ?? {};
  if (setup.state) s.state = setup.state;
  if (setup.batch) s.slots.currentBatch = setup.batch;
  if (setup.presented) s.slots.presentedIds = setup.presented;
  if (setup.location) s.slots.location = setup.location;
  if (setup.recentTurns) {
    // The record the explain lane reads: newest LAST, replies already sent.
    s.recentTurns = setup.recentTurns.map((t, i) => ({
      at: Date.now() - (setup.recentTurns!.length - i) * 60_000,
      chatId, channel: 'test', text: t.text,
      stateBefore: s.state, stateAfter: s.state,
      lanes: t.lanes ?? [], facts: [], replies: [t.reply],
    }));
    s.lastTurn = s.recentTurns[s.recentTurns.length - 1];
  }
  sessions.set(s);

  const stateBefore = s.state;
  let reply = '';
  let loggedLanes: string[] = [];
  for (let i = 0; i < c.turns.length; i++) {
    if (i === c.turns.length - 1) {
      const mark = recentRoutes(500).length;
      await handler.handle('test', chatId, c.turns[i]!);
      reply = sent[sent.length - 1] ?? '';
      loggedLanes = recentRoutes(500).slice(mark)
        .filter(r => r.chatId === chatId).map(r => r.intent);
    } else {
      await handler.handle('test', chatId, c.turns[i]!);
    }
  }

  const after = sessions.get(chatId)!;
  const audit = after.lastTurn;
  return {
    reply,
    lanes: audit?.lanes ?? [],
    stateBefore,
    state: after.state,
    loggedLanes,
    predicted: audit?.predicted,
    feeRejections: after.slots.feeRejections ?? 0,
    provisionRejections: after.slots.provisionRejections ?? 0,
    auditText: (audit?.replies ?? []).join('\n'),
  };
}

const has = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase());

const namedEb = (reply: string, eb: number): boolean =>
  new RegExp(`(?:Евидентен број|EB|#)\\s*${eb}(?!\\d)`, 'i').test(reply);

/** Assert every dimension of one case; failures name the case and the dimension. */
export async function assertCorpusCase(c: CorpusCase): Promise<void> {
  const run = await runCorpusCase(c);
  const where = `${c.id} (${c.capture})`;
  const shown = `\n--- reply ---\n${run.reply}\n--- lanes ---\n${run.lanes.join(', ') || '(none recorded)'}`
    + `\n--- logged ---\n${run.loggedLanes.join(', ') || '(no lane tag at all — the serving path must tag its lane)'}`;

  assert.ok(run.reply.trim().length > 0, `${where}: the turn must answer${shown}`);
  assert.ok(run.auditText.trim().length > 0, `${where}: no audit record for the turn — the explain lane would have nothing to read${shown}`);
  assert.ok(
    has(run.auditText, run.reply) || has(run.reply, run.auditText),
    `${where}: the record and the served text disagree${shown}\n--- record ---\n${run.auditText}`,
  );

  if (c.predicted !== undefined) {
    // Compare through the router's OWN normalisation (ROUTE_LANES): the executor
    // logs `FEE_PUSH:fast` where the registry's intent is `FEE_PUSH`, and a raw
    // string compare would fail on a lane that agrees with itself.
    const predictedNorm = ROUTE_LANES[run.predicted ?? '']?.intent ?? run.predicted;
    assert.equal(
      predictedNorm, c.predicted,
      `${where}: predicted — the mirror said ${run.predicted ?? '(nothing)'} but the case requires ${c.predicted}${shown}`,
    );
  }
  for (const lane of c.intent) {
    assert.ok(run.lanes.includes(lane), `${where}: intent — expected lane ${lane}${shown}`);
  }
  if (c.target !== undefined) {
    assert.ok(namedEb(run.reply, c.target), `${where}: target — the answer is not about EB ${c.target}${shown}`);
  }
  for (const fact of c.facts ?? []) {
    assert.ok(has(run.reply, fact), `${where}: facts — «${fact}» is missing${shown}`);
  }
  for (const banned of c.prohibited ?? []) {
    assert.doesNotMatch(run.reply, new RegExp(banned, 'iu'), `${where}: prohibited — /${banned}/ matched${shown}`);
  }
  const delta = c.stateDelta ?? {};
  if (delta.state === 'unchanged') {
    assert.equal(run.state, run.stateBefore, `${where}: stateDelta — the turn moved the funnel (${run.stateBefore} → ${run.state})${shown}`);
  } else if (delta.state) {
    assert.equal(run.state, delta.state, `${where}: stateDelta — expected state ${delta.state}${shown}`);
  }
  if (delta.counters?.feeRejections !== undefined) {
    assert.equal(run.feeRejections, delta.counters.feeRejections, `${where}: stateDelta — fee rungs${shown}`);
  }
  if (delta.counters?.provisionRejections !== undefined) {
    assert.equal(run.provisionRejections, delta.counters.provisionRejections, `${where}: stateDelta — commission rungs${shown}`);
  }
}
