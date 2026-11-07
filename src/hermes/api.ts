// Lina's /hermes/v1 API — the two-machine bridge.
//
// Hermes (the agency-side agent) runs on its own box. It cannot read Lina's
// local SQLite, so Lina serves a minimal, token-guarded HTTP surface on the
// same :8080 Express server the Viber webhook uses:
//
//   GET  /hermes/v1/work                    — one pull: landmark candidates,
//                                             pending price AND address changes,
//                                             pending owner checks, upcoming visits
//   POST /hermes/v1/landmarks               — Hermes' named landmarks (written
//                                             as source='hermes', street never
//                                             accepted) + resolves matching
//                                             landmark_requested events
//   POST /hermes/v1/prices/:id/result       — ok/fail for an applied price sync
//   POST /hermes/v1/addresses/:id/result    — ok/fail for an applied address sync
//   POST /hermes/v1/owners/:chatId/reply    — the owner's MESSAGE, raw. Lina
//                                             parses it (one grammar), answers
//                                             it, and returns the text to
//                                             deliver. Idempotent on
//                                             {message_id}.
//   POST /hermes/v1/owners/:chatId/answer   — an already-parsed owner verdict
//                                             (for a caller that cannot relay
//                                             text); writes the bus + fast-paths
//                                             ownerAnswer
//   GET  /hermes/v1/visits                  — finalized visits + turn statuses
//
// Auth: every route requires `x-admin-token: <HERMES_TOKEN>` (the same shared
// token the price-sync edge function checks). With HERMES_TOKEN unset the API
// is disabled (503) — it never runs unauthenticated.

import { Express, Request, Response, NextFunction } from 'express';
import { AppConfig } from '../config';
import { InboundHandler } from '../handlers/inbound';
import { LandmarkStore, sanitizeLandmarkAnswer } from '../geo/landmarks';
import { Db } from '../store/db';
import { PropertyService } from '../data/properties';
import { OwnerVerdict } from '../backoffice/ownerAgent';
import { OwnerStore } from '../store/owners';
import { parseVisitDateTime } from '../visits/time';

export interface HermesApiDeps {
  cfg: AppConfig;
  db: Db;
  pipeline: InboundHandler;
  properties: PropertyService;
}

export function registerHermesApi(app: Express, deps: HermesApiDeps): void {
  const { cfg, pipeline, properties } = deps;
  const landmarks = new LandmarkStore(deps.db);
  const owners = new OwnerStore(deps.db);

  const guard = (req: Request, res: Response, next: NextFunction): void => {
    if (!cfg.hermesToken) {
      res.status(503).json({ error: 'hermes api disabled — HERMES_TOKEN not set' });
      return;
    }
    if (req.headers['x-admin-token'] !== cfg.hermesToken) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  // One pull of everything Hermes can work on.
  app.get('/hermes/v1/work', guard, async (_req, res) => {
    const all = await properties.getAll();
    // Landmark cache is keyed by property.id (not address_key) since the tier
    // migration — a property is precise when it has a servable cached row.
    const landmarkCandidates: Array<{ id: number; address?: string; location?: string }> = [];
    for (const p of all) {
      if (p.id == null) continue;
      const row = landmarks.get(p.id);
      if (row && row.tier && row.tier !== 'osm_low_confidence') continue; // already precise
      if (!p.address && !p.location) continue;
      landmarkCandidates.push({ id: p.id, address: p.address, location: p.location });
    }
    // OWNER CHECKS ARE DELIVERABLE WORK, not just a monitoring list. The check
    // carries the ask Lina ALREADY COMPOSED (`askText`, bank-served through the
    // same pool the operator pane uses) plus the owner's contact, so a remote
    // transport sends LINA'S sentence instead of composing its own copy — one
    // copy source for the owner channel, rotation included.
    //
    // `deliver_text: null` means nobody has to send anything: the check was
    // re-armed AFTER the owner spoke (he is already answering the question), so
    // re-delivering the ask would repeat it at him. A present string means the
    // ask is owed.
    const ownerChecks = pipeline.events.listPending('owner_check_requested')
      .filter(ev => ev.eb !== null && ev.eb !== undefined)
      .map(ev => {
        const payload = JSON.parse(ev.payload) as { proposedTime?: string; askText?: string };
        const owner = owners.get(ev.eb as number);
        return {
          chat_id: ev.chatId,
          eb: ev.eb,
          proposed_time: payload.proposedTime ?? '',
          deliver_text: payload.askText || null,
          owner_name: owner?.name || undefined,
          owner_phone: owner?.phone || undefined,
        };
      });
    res.json({
      landmarks: landmarkCandidates,
      price_changes: pipeline.priceChanges.listPending()
        .map(r => ({ id: r.id, eb: r.eb, old_price: r.oldPrice, new_price: r.newPrice })),
      address_changes: pipeline.addressChanges.listPending()
        .map(r => ({ id: r.id, eb: r.eb, old_address: r.oldAddress, new_address: r.newAddress })),
      owner_checks: ownerChecks,
      visits: thisVisits(),
    });
  });

  // Hermes' named landmarks. The street is re-checked here (defense in depth):
  // an answer containing the address is rejected and stays for the next run.
  // The cache is keyed by property.id. The push carries the id /work returned;
  // when absent (older Hermes clients) it is resolved from address+location so
  // the write still lands on the right property's row.
  app.post('/hermes/v1/landmarks', guard, async (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [];
    // Cache resolution for backward-compatible pushes without an id.
    const all = await properties.getAll();
    const normKey = (a?: string, l?: string) => `${l ?? ''} | ${a ?? ''}`.toLowerCase().replace(/\s+/g, ' ');
    const byKey = new Map(all.map(p => [normKey(p.address, p.location), p.id]));
    const accepted: number[] = [];
    const rejected: Array<{ id?: number; address?: string; location?: string; reason: string }> = [];
    for (const it of items) {
      const address = typeof it?.address === 'string' ? it.address : undefined;
      const location = typeof it?.location === 'string' ? it.location : undefined;
      const cleaned = sanitizeLandmarkAnswer(typeof it?.landmark === 'string' ? it.landmark : '', address);
      if (!cleaned) {
        rejected.push({ id: it?.id, address, location, reason: 'invalid or contains the street address' });
        continue;
      }
      const directId = Math.floor(Number(it?.id));
      const id = Number.isFinite(directId) && directId > 0
        ? directId
        : (byKey.get(normKey(address, location)) ?? NaN);
      if (!Number.isFinite(id)) {
        rejected.push({ id: it?.id, address, location, reason: 'no property id and no property matches this address' });
        continue;
      }
      landmarks.put(id, {
        landmark: cleaned,
        type: typeof it?.type === 'string' && it.type ? it.type : 'llm',
        mapsUrl: typeof it?.maps_url === 'string' ? it.maps_url : undefined,
        source: 'hermes',
      }, 'extract');
      accepted.push(id);
      // Resolve any runtime landmark_requested events for this property.
      for (const ev of pipeline.events.listPending('landmark_requested')) {
        const payload = JSON.parse(ev.payload) as { eb?: number; address?: string; location?: string };
        if (payload.eb === id || (payload.address === undefined && payload.location === undefined)) {
          // Events carry eb when known; address-only payloads can't be keyed to
          // a property id — leave them pending for a future id-carrying push.
          if (payload.eb === id) pipeline.events.resolve(ev.id);
        }
      }
    }
    res.json({ accepted: accepted.length, rejected });
  });

  // Hermes applied a price change via the Supabase function — report back.
  app.post('/hermes/v1/prices/:id/result', guard, (req, res) => {
    const id = Number(req.params.id);
    const ok = req.body?.ok === true;
    const row = deps.db.db.prepare(`SELECT id FROM price_changes WHERE id = ? AND status = 'pending'`).get(id);
    if (!row) {
      res.json({ resolved: false, reason: 'no pending row' });
      return;
    }
    if (ok) pipeline.priceChanges.resolve(id);
    res.json({ resolved: ok });
  });

  // Hermes applied an ADDRESS correction via the Supabase function — report
  // back. Same contract as the price result: resolved only on ok=true.
  app.post('/hermes/v1/addresses/:id/result', guard, (req, res) => {
    const id = Number(req.params.id);
    const ok = req.body?.ok === true;
    const row = deps.db.db.prepare(`SELECT id FROM address_changes WHERE id = ? AND status = 'pending'`).get(id);
    if (!row) {
      res.json({ resolved: false, reason: 'no pending row' });
      return;
    }
    if (ok) pipeline.addressChanges.resolve(id);
    res.json({ resolved: ok });
  });

  // THE OWNER'S MESSAGE, RAW — the transport seam. A channel that holds the
  // owner's conversation relays what he typed; Lina parses it with the SAME
  // seam the operator pane uses and hands back the sentence to deliver. One
  // grammar and one copy source: a second parser on machine B is how a client
  // gets booked into a term the owner never gave (the [23:41] class), and a
  // second copywriter stops the owner pool from rotating.
  app.post('/hermes/v1/owners/:chatId/reply', guard, async (req, res) => {
    const chatId = req.params.chatId;
    const b = req.body ?? {};
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'text (non-empty string) required' });
      return;
    }
    if (text.length > 2000) {
      res.status(400).json({ error: 'text too long (max 2000 chars)' });
      return;
    }
    const eb = b.eb === undefined || b.eb === null ? undefined : Math.floor(Number(b.eb));
    if (eb !== undefined && (!Number.isFinite(eb) || eb <= 0)) {
      res.status(400).json({ error: 'eb must be a positive integer when given' });
      return;
    }
    const messageId = typeof b.message_id === 'string' && b.message_id.trim() ? b.message_id.trim() : undefined;
    if (messageId && messageId.length > 200) {
      res.status(400).json({ error: 'message_id too long (max 200 chars)' });
      return;
    }
    const result = await pipeline.ownerMessage(chatId, text, { eb, messageId });
    if (result.effect === 'unknown_chat') {
      res.status(404).json({ error: 'no conversation for this chat', ...result });
      return;
    }
    if (result.effect === 'wrong_property') {
      res.status(409).json({ error: 'eb does not match the property this chat is on', ...result });
      return;
    }
    if (result.effect === 'no_pending') {
      res.status(409).json({ error: 'nothing is waiting on this owner', ...result });
      return;
    }
    console.log(`[EVENT] OWNER_REPLY ${JSON.stringify({ chatId, eb: eb ?? null, effect: result.effect, replay: !!result.replay })}`);
    res.json({ ...result, reply_text: result.replyText });
  });

  // AN ALREADY-PARSED OLDER VERDICT — for a caller that cannot relay the owner's
  // text. `available` is the honest shape for a HALF answer (the flat is free,
  // the term is open): it serves the ack and keeps the check waiting instead of
  // forcing the half-answer into `ok` (agreed) or `counter` (refused).
  // `confirm_time` is the term the caller is agreeing to, echoed back: consent
  // must name its object, and a different term is a counter, not an ok.
  app.post('/hermes/v1/owners/:chatId/answer', guard, (req, res) => {
    const chatId = req.params.chatId;
    const b = req.body ?? {};
    const eb = Math.floor(Number(b.eb));
    const status = b.status;
    if (!Number.isFinite(eb) || eb <= 0 || !['ok', 'counter', 'gone', 'available'].includes(status)) {
      res.status(400).json({ error: 'eb (positive int) and status (ok|counter|gone|available) required' });
      return;
    }
    const verdict: OwnerVerdict = { status };
    if (typeof b.owner_time === 'string' && b.owner_time) verdict.ownerTime = b.owner_time;
    if (typeof b.confirm_time === 'string' && b.confirm_time) {
      const agent = pipeline.ownerAgent as unknown as { pendingProposedTime?: (c: string) => string | null };
      const asked = typeof agent.pendingProposedTime === 'function' ? agent.pendingProposedTime(chatId) : null;
      if (asked && !sameTerm(asked, b.confirm_time)) {
        res.status(409).json({ error: 'confirm_time does not match the term this chat asked about', asked, verdict });
        return;
      }
      verdict.ownerTime = b.confirm_time;
    }
    if (typeof b.price === 'number' && b.price > 0) verdict.price = b.price;
    if (typeof b.note === 'string' && b.note) verdict.note = b.note;
    const applied = pipeline.ownerAnswer(chatId, eb, verdict);
    if (!applied) {
      // NO DANGLING BUS EVENT. The deferred agent writes the result event itself
      // when it holds the check; this route only publishes when ANOTHER process
      // holds it — and only if a pending request actually exists. An event for a
      // check nobody was waiting on sat in the bus forever, and every later
      // check for that chat had to defend against it.
      const waiting = pipeline.events.listPending('owner_check_requested')
        .some(ev => ev.chatId === chatId && ev.eb === eb);
      if (!waiting) {
        res.status(409).json({ error: 'no pending owner check for this chat/eb', verdict });
        return;
      }
      pipeline.events.insert('owner_check_result', chatId, eb, { ...verdict, source: 'api' });
      res.json({ applied: false, queued: true, verdict });
      return;
    }
    res.json({
      applied: true,
      verdict,
      // The availability ack is served on Lina's own owner channel; a caller that
      // needs the TEXT must use /reply (which returns it as `reply_text`).
      ...(status === 'available' ? { reply_text: null, note: 'ack served on the owner channel — use /reply to receive its text' } : {}),
    });
  });

  // Monitoring: finalized visits + their protocol-turn statuses.
  app.get('/hermes/v1/visits', guard, (_req, res) => {
    res.json(thisVisits());
  });

  /** Two terms are the same consent when they resolve to the same instant; when
   *  either cannot be parsed, compare their normalised words. The transport is
   *  expected to echo the term it was given, so a real echo always matches. */
  function sameTerm(a: string, b: string): boolean {
    const pa = parseVisitDateTime(a);
    const pb = parseVisitDateTime(b);
    if (pa && pb) return pa.getTime() === pb.getTime();
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    return norm(a) === norm(b);
  }

  function thisVisits(): Array<Record<string, unknown>> {
    const rows = deps.db.db.prepare(
      `SELECT a.id, a.property_id as eb, a.time, a.visit_at as visitAt, a.client_name as clientName,
              a.client_phone as clientPhone, a.agent_phone as agentPhone
       FROM appointments a WHERE a.status = 'finalized' ORDER BY a.visit_at`
    ).all() as Array<Record<string, unknown>>;
    return rows.map(r => {
      const turns = deps.db.db.prepare(
        `SELECT turn, scheduled_at as scheduledAt, status, owner_status as ownerStatus, client_status as clientStatus
         FROM visit_turns WHERE appointment_id = ? ORDER BY scheduled_at`
      ).all(r.id);
      return { ...r, turns };
    });
  }
}
