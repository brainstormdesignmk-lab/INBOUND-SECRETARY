import { test } from 'node:test';
import assert from 'node:assert';
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
import { decideCapture, CaptureStore, normalizedKey } from '../src/store/capture';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'capture-')), 'cap.jsonl');
}

// ── decideCapture — the pure policy ──────────────────────────────────────────

test('decideCapture: fallthrough + prose + both + none + presentation exclusion', () => {
  assert.equal(decideCapture({ deterministicClassifyGaveUp: true, replySource: 'deterministic', isPresentationBatch: false }), 'fallthrough');
  assert.equal(decideCapture({ deterministicClassifyGaveUp: true, replySource: 'bank', isPresentationBatch: false }), 'fallthrough');
  assert.equal(decideCapture({ deterministicClassifyGaveUp: false, replySource: 'llm', isPresentationBatch: false }), 'prose');
  assert.equal(decideCapture({ deterministicClassifyGaveUp: true, replySource: 'llm', isPresentationBatch: false }), 'both');
  assert.equal(decideCapture({ deterministicClassifyGaveUp: false, replySource: 'deterministic', isPresentationBatch: false }), null);
  assert.equal(decideCapture({ deterministicClassifyGaveUp: false, replySource: 'fallback', isPresentationBatch: false }), null);
  // Presentation batches are code-built displays of an understood search —
  // never a classification gap, even when the deterministic pre-classify
  // gave up and the LLM classifier confirmed the search intent.
  assert.equal(decideCapture({ deterministicClassifyGaveUp: true, replySource: 'deterministic', isPresentationBatch: true }), null);
});

// ── CaptureStore — dedupe + file round-trip ─────────────────────────────────

test('CaptureStore: same wording same day deduped; different day re-captured; file round-trip', () => {
  const f = tmpFile();
  const s1 = new CaptureStore(f);
  s1.onTurn({ kind: 'fallthrough', text: 'ZEMATE PARI za poseta?', state: 'idle', at: '2026-09-28T10:00:00Z', chatId: 'c1', replySource: 'deterministic' });
  // Same message, different case/punctuation/spacing — SAME wording identity.
  s1.onTurn({ kind: 'fallthrough', text: 'zemate pari za poseta', state: 'idle', at: '2026-09-28T11:00:00Z', chatId: 'c2', replySource: 'deterministic' });
  // x→кс fold: the Latin-x typo twin must collide too.
  s1.onTurn({ kind: 'fallthrough', text: 'ZEMATE PARI ZA POSETA?', state: 'idle', at: '2026-09-28T12:00:00Z', chatId: 'c3', replySource: 'deterministic' });
  assert.equal(s1.pendingCount, 1, 'identity twins must dedupe');
  s1.flush();
  assert.equal(s1.pendingCount, 0);
  assert.equal(s1.fileCounts().total, 1);

  // Next day, the same phrase is a fresh capture (repetition across days is
  // still signal — the client asked again and the gap persists).
  const s2 = new CaptureStore(f);
  s2.onTurn({ kind: 'fallthrough', text: 'ZEMATE PARI ZA POSETA?', state: 'idle', at: '2026-09-29T09:00:00Z', chatId: 'c1', replySource: 'deterministic' });
  assert.equal(s2.pendingCount, 1, 'same wording on a later day re-captures');
  s2.flush();

  // Restart safety: the rebuilt index sees the previous days' keys.
  const s3 = new CaptureStore(f);
  s3.onTurn({ kind: 'fallthrough', text: 'zemate pari za poseta?', state: 'idle', at: '2026-09-29T10:00:00Z', chatId: 'c1', replySource: 'deterministic' });
  assert.equal(s3.pendingCount, 0, 'same-day duplicate after restart is still deduped');
  const all = s3.readAll();
  assert.equal(all.length, 2);
  assert.equal(all[0].kind, 'fallthrough');
  assert.equal(all[0].replySource, 'deterministic');
});

test('normalizedKey: case/punct/spacing collapse + x→кс fold; numbers preserved', () => {
  assert.equal(normalizedKey('До 160 000!'), normalizedKey('до 160000'));
  // x→кс collides WITHIN one script (Latin "blixina" ≡ Latin-typo twin);
  // cross-SCRIPT twins ("BLIXINA" vs "бликсина") are the sweep's job, not
  // the capture identity's — the fold only maps Latin x to кс in place.
  assert.equal(normalizedKey('blixina'), normalizedKey('bliksina'));
  assert.notEqual(normalizedKey('BLIXINA'), normalizedKey('бликсина'));
  assert.notEqual(normalizedKey('do 160000'), normalizedKey('do 150000'), 'different numbers stay different');
  assert.equal(normalizedKey('Zdravo, kako ste?'), normalizedKey('zdravo kako ste'));
});

// ── E2E — the handler actually reports to the sink ──────────────────────────

test('e2e: a bank-lane turn and a novel turn produce the right capture kinds', async () => {
  const rows: Property[] = [
    { eb: 30, id: 30, location: 'Центар', price: 100000, service: 'buy', bedrooms: 3, size: '60 м²' },
  ];
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const classifier = new Classifier(new FailingLlm(), cfg, properties);
  const responder = new Responder(new FailingLlm(), cfg);
  const channels = new ChannelRegistry();
  const channelsSend: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { channelsSend.push(text); } });
  const capture = new CaptureStore(tmpFile());
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder,
    properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
    capture,
  });
  const chatId = 'cap-e2e';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return channelsSend.at(-1) ?? ''; };

  // Turn 1: a PROVISION ask — the deterministic lane owns it (fast lane).
  // No fallthrough, no prose → NO capture (a known lane is not a gap).
  await send('KOLKU VI E PROVIZIJATA?');
  assert.equal(capture.pendingCount, 0, 'known lanes must not be captured');

  // Turn 2: pure gibberish (NO digits — a number would extract as a budget
  // slot and the deterministic path would own it) — the pre-classify gives
  // up, the LLM classifier throws (429) → STAY → deterministic reply. This
  // is the exact frontier shape the learning layer exists to catch.
  const r = await send('XQZW VORMPLE');
  assert.ok(r.length > 0, 'a reply was served even for gibberish');
  assert.equal(capture.pendingCount, 1, 'the fallthrough must be captured');
  const rec = capture.pending[0];
  assert.ok(rec, 'pending record exists');
  assert.equal(rec!.kind, 'fallthrough');
  assert.equal(rec!.text, 'XQZW VORMPLE');
  capture.flush();
  assert.equal(capture.fileCounts().fallthrough, 1);
});
