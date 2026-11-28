// THE LOCAL TIER — inference + the abstain that keeps it honest.
//
// The model NEVER gets the last word: below the confidence floor it returns
// undefined and the remote classifier runs. That is not a fallback path, it is
// the design: an appliance that guesses confidently on unfamiliar phrasing is
// the failure this tier exists to avoid (the Tiny 2.1 lesson).
//
// The weights are cached by (path, mtime), so editing the file takes effect on
// the next turn without a restart, and a missing file simply disables the tier.

import * as fs from 'fs';
import { ChatSession } from '../fsm/session';
import { Classified } from './classify';
import { EventType } from '../fsm/machine';
import { buildRouteSig, sigKey } from './routeSig';
import { normalizedKey } from '../store/capture';
import { LocalModel, predictLocal, validateModel } from './localModel';
import { SAFE_EVENTS } from '../store/routes';

export type LocalMode = 'off' | 'shadow' | 'serve';

export function parseLocalMode(value: string | undefined): LocalMode {
  if (value === 'serve') return 'serve';
  if (value === 'shadow') return 'shadow';
  return 'off';
}

interface CacheEntry { mtimeMs: number; model: LocalModel }
const cache = new Map<string, CacheEntry>();

/** Load (and cache) a weight file. Returns undefined when there is no model —
 *  an absent file is a normal state on a fresh appliance, not an error. */
export function loadLocalModel(path: string): LocalModel | undefined {
  try {
    const st = fs.statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.model;
    const model = validateModel(JSON.parse(fs.readFileSync(path, 'utf8')));
    cache.set(path, { mtimeMs: st.mtimeMs, model });
    return model;
  } catch {
    return undefined;
  }
}

/** Test seam: drop the cache so a rewritten file is re-read immediately. */
export function clearLocalModelCache(): void { cache.clear(); }

export interface LocalDecision {
  event: string;
  confidence: number;
}

/** The prediction the tier WOULD serve, before mode gating — shadow mode needs
 *  exactly this to compare against the remote verdict. */
export function localDecision(
  model: LocalModel,
  session: ChatSession,
  text: string,
): LocalDecision | undefined {
  const norm = normalizedKey(text);
  if (!norm) return undefined;
  const pred = predictLocal(model, norm, buildRouteSig(session, text));
  // The commitment ban applies to EVERY learned tier, the local model
  // included: a false consent is never a routing convenience.
  if (!SAFE_EVENTS.has(pred.event)) return undefined;
  return { event: pred.event, confidence: pred.confidence };
}

/** A servable verdict, or undefined (abstain upward). */
export function localVerdict(
  model: LocalModel | undefined,
  floor: number,
  session: ChatSession,
  text: string,
): Classified | undefined {
  if (!model) return undefined;
  const decision = localDecision(model, session, text);
  if (!decision) return undefined;
  if (decision.confidence < floor) return undefined; // ABSTAIN — the point of the tier
  return {
    event: { type: decision.event as EventType },
    offensive: false,
    offenseLevel: 0,
    tier: 'local',
    latencyMs: 0,
    attempts: 0,
  };
}

/** The identity the tier decided on, for the shadow bookkeeping. */
export function localIdentity(session: ChatSession, text: string): { norm: string; sigKey: string } {
  return { norm: normalizedKey(text), sigKey: sigKey(buildRouteSig(session, text)) };
}
