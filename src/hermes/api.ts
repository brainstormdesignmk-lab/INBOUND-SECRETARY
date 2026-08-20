// Lina's /hermes/v1 API — the two-machine bridge.
//
// Hermes (the agency-side agent) runs on its own box. It cannot read Lina's
// local SQLite, so Lina serves a minimal, token-guarded HTTP surface on the
// same :8080 Express server the Viber webhook uses:
//
//   GET  /hermes/v1/work                    — one pull: landmark candidates,
//                                             pending price changes, pending
//                                             owner checks, upcoming visits
//   POST /hermes/v1/landmarks               — Hermes' named landmarks (written
//                                             as source='hermes', street never
//                                             accepted) + resolves matching
//                                             landmark_requested events
//   POST /hermes/v1/prices/:id/result       — ok/fail for an applied price sync
//   POST /hermes/v1/owners/:chatId/answer   — Hermes' owner verdict (writes the
//                                             bus + fast-paths ownerAnswer)
//   GET  /hermes/v1/visits                  — finalized visits + turn statuses
//
// Auth: every route requires `x-admin-token: <HERMES_TOKEN>` (the same shared
// token the price-sync edge function checks). With HERMES_TOKEN unset the API
// is disabled (503) — it never runs unauthenticated.

import { Express, Request, Response, NextFunction } from 'express';
import { AppConfig } from '../config';
import { InboundHandler } from '../handlers/inbound';
import { LandmarkStore, sanitizeLandmarkAnswer, landmarkCacheKey } from '../geo/landmarks';
import { Db } from '../store/db';
import { PropertyService } from '../data/properties';
import { OwnerVerdict } from '../backoffice/ownerAgent';

export interface HermesApiDeps {
  cfg: AppConfig;
  db: Db;
  pipeline: InboundHandler;
  properties: PropertyService;
}

export function registerHermesApi(app: Express, deps: HermesApiDeps): void {
  const { cfg, pipeline, properties } = deps;
  const landmarks = new LandmarkStore(deps.db);

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
    const landmarkCandidates: Array<{ address?: string; location?: string }> = [];
    for (const p of all) {
      const row = landmarks.get(landmarkCacheKey(p));
      if (row && row.source !== 'table') continue; // already precise
      if (!p.address && !p.location) continue;
      landmarkCandidates.push({ address: p.address, location: p.location });
    }
    const ownerChecks = pipeline.events.listPending('owner_check_requested')
      .map(ev => {
        const payload = JSON.parse(ev.payload) as { proposedTime?: string };
        return { chat_id: ev.chatId, eb: ev.eb, proposed_time: payload.proposedTime ?? '' };
      });
    res.json({
      landmarks: landmarkCandidates,
      price_changes: pipeline.priceChanges.listPending()
        .map(r => ({ id: r.id, eb: r.eb, old_price: r.oldPrice, new_price: r.newPrice })),
      owner_checks: ownerChecks,
      visits: thisVisits(),
    });
  });

  // Hermes' named landmarks. The street is re-checked here (defense in depth):
  // an answer containing the address is rejected and stays for the next run.
  app.post('/hermes/v1/landmarks', guard, (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [];
    const accepted: string[] = [];
    const rejected: Array<{ address?: string; location?: string; reason: string }> = [];
    for (const it of items) {
      const address = typeof it?.address === 'string' ? it.address : undefined;
      const location = typeof it?.location === 'string' ? it.location : undefined;
      const cleaned = sanitizeLandmarkAnswer(typeof it?.landmark === 'string' ? it.landmark : '', address);
      if (!cleaned) {
        rejected.push({ address, location, reason: 'invalid or contains the street address' });
        continue;
      }
      const key = landmarkCacheKey({ address, location });
      landmarks.put(key, {
        landmark: cleaned,
        type: typeof it?.type === 'string' && it.type ? it.type : 'llm',
        mapsUrl: typeof it?.maps_url === 'string' ? it.maps_url : undefined,
        source: 'hermes',
      });
      accepted.push(key);
      // Resolve any runtime landmark_requested events for this address.
      for (const ev of pipeline.events.listPending('landmark_requested')) {
        const payload = JSON.parse(ev.payload) as { address?: string; location?: string };
        if (landmarkCacheKey(payload) === key) pipeline.events.resolve(ev.id);
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

  // Hermes' owner verdict — written to the events bus so ANY process holding
  // the pending check (this one or the TUI's) picks it up; also fast-paths the
  // same-process agent.
  app.post('/hermes/v1/owners/:chatId/answer', guard, (req, res) => {
    const chatId = req.params.chatId;
    const b = req.body ?? {};
    const eb = Math.floor(Number(b.eb));
    const status = b.status;
    if (!Number.isFinite(eb) || eb <= 0 || !['ok', 'counter', 'gone'].includes(status)) {
      res.status(400).json({ error: 'eb (positive int) and status (ok|counter|gone) required' });
      return;
    }
    const verdict: OwnerVerdict = { status };
    if (typeof b.owner_time === 'string' && b.owner_time) verdict.ownerTime = b.owner_time;
    if (typeof b.price === 'number' && b.price > 0) verdict.price = b.price;
    if (typeof b.note === 'string' && b.note) verdict.note = b.note;
    pipeline.events.insert('owner_check_result', chatId, eb, { ...verdict, source: 'api' });
    const applied = pipeline.ownerAnswer(chatId, eb, verdict);
    res.json({ applied, verdict });
  });

  // Monitoring: finalized visits + their protocol-turn statuses.
  app.get('/hermes/v1/visits', guard, (_req, res) => {
    res.json(thisVisits());
  });

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
