#!/usr/bin/env tsx
/**
 * visit-plan-repair — narrow a RUNNING visit route to the flats the client
 * actually named, then finish it through the shipped chain.
 *
 * WHY THIS EXISTS (the [11:18] V16K11 capture): the client named EB 82 and 77,
 * the route was built from every card presented (84, 82, 77, 53), and four
 * owners were asked for a two-flat visit. The naming memory and the mid-route
 * narrowing fix that for NEW turns, but a plan already on file keeps the extra
 * stops, and once EVERY stop has an owner answer the chain has no verdict left
 * to advance it — it sits in `owner_checking` for ever. This is the operator
 * hand on that wheel: rebuild the stops to the named set (keeping the owners'
 * answers for a flat that stays), then run the production transition that a
 * final verdict would have run (solve the route + put it to the client).
 *
 * The solve and the copy are the PRODUCT's: `finishChain` is called, never
 * re-implemented, so a repaired route reads exactly like a normal one.
 *
 * Usage:
 *   npx tsx scripts/visit-plan-repair.ts --chat client-1@yvvho --ebs 82,77 [--db data/tui.db] [--dry]
 *
 * Safety:
 *   • refuses when a live stop has NOT answered yet (that stop needs an owner
 *     ask, which only the live app can carry);
 *   • `--dry` prints the before/after plan and the copy it WOULD send;
 *   • the channel is a recorder — this tool never talks to a phone.
 */
import '../src/compat/node16';

import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, ChatSession } from '../src/fsm/session';
import { InboundHandler } from '../src/handlers/inbound';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import type { LlmClient } from '../src/llm/types';

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const chatId = arg('chat');
const ebsArg = arg('ebs') ?? '';
const dbPath = arg('db') ?? 'data/tui.db';
const dry = args.includes('--dry');
const ebs = ebsArg.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
if (!chatId || ebs.length < 1) {
  console.error('usage: npx tsx scripts/visit-plan-repair.ts --chat <chatId> --ebs 82,77 [--db data/tui.db] [--dry]');
  process.exit(2);
}

/** No brain needed: the chain's copy is code-built, and no turn runs here. */
class NoLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('repair: no LLM'); }
}

function show(label: string, s: ChatSession): void {
  const plan = s.slots.visitPlan;
  console.log(`${label}: state=${s.state} propertyId=${s.slots.propertyId} visitEbs=${JSON.stringify(s.slots.visitEbs)}`);
  if (!plan) { console.log('  (no plan)'); return; }
  console.log(`  day=${new Date(plan.dayMs).toDateString()} targetHour=${plan.targetHour} term=${JSON.stringify(plan.term)}`);
  for (const st of plan.stops) console.log(`  stop ${JSON.stringify(st)}`);
  console.log(`  assignments=${JSON.stringify(plan.assignments)} dropped=${JSON.stringify(plan.dropped)}`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = new Db(dbPath);
  const sessions = new SessionStore(db);
  const session = sessions.get(chatId!);
  if (!session) { console.error(`no session for ${chatId} in ${dbPath}`); process.exit(1); }
  const plan = session.slots.visitPlan;
  if (!plan) { console.error(`${chatId} has no running visit plan — nothing to narrow`); process.exit(1); }

  show('BEFORE', session);

  // 1. THE NAMED SET IS THE ROUTE: rebuild the stops, keeping every recorded
  //    owner answer for a flat that stays. A flat that leaves is named in the
  //    report — its owner was asked and must be told the viewing is off.
  const known = new Map(plan.stops.map(s => [s.eb, s]));
  const unknown = ebs.filter(eb => !known.has(eb));
  if (unknown.length > 0) {
    console.error(`flats never asked in this plan: ${unknown.join(', ')} — a repair only narrows, it never adds`);
    process.exit(1);
  }
  const left = plan.stops.filter(s => !ebs.includes(s.eb));
  const unanswered = ebs.map(eb => known.get(eb)!).filter(s => s.status === 'asked' || s.status === 'pending');
  if (unanswered.length > 0) {
    console.error(`still awaiting the owner: ${unanswered.map(s => s.eb).join(', ')} — the live app must collect that answer, not this tool`);
    process.exit(1);
  }
  plan.stops = ebs.map(eb => known.get(eb)!);
  plan.assignments = undefined;   // the solved route is stale the moment the set changes
  plan.dropped = undefined;
  session.slots.visitEbs = ebs;   // the memory the deictic plurals read
  // The chat-level ask memory belongs to the stop that left (EB 53's 20:00) —
  // leaving it would have the owner pane answer about a flat that is no longer
  // in the visit.
  if (left.length > 0) {
    session.slots.ownerAskTime = undefined;
    session.slots.ownerCounterTime = undefined;
  }
  console.log(`narrowed to ${ebs.join(', ')}; left the route: ${left.map(s => `${s.eb}(${s.status}${s.hours ? ` ${s.hours.join('/')}:00` : ''})`).join(', ') || '—'}`);

  // 2. FINISH IT THE PRODUCT'S WAY: the transition a last verdict would run.
  const sent: string[] = [];
  const channels = new ChannelRegistry();
  channels.register({ name: 'viber', send: async (_c: string, text: string) => { sent.push(text); } });
  const appointments = new AppointmentStore(db);
  const properties = new PropertyService(cfg.propertyDataUrl);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new NoLlm(), cfg, properties),
    responder: new Responder(new NoLlm(), cfg),
    properties, appointments,
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });

  if (dry) {
    // A DRY RUN WRITES NOTHING — not even the narrowed set: the plan on file
    // must stay exactly as it was until the operator means it.
    show('AFTER (dry — nothing persisted)', session);
    console.log('dry run: nothing persisted, nothing sent');
    return;
  }

  // `finishChain` is the chain's own async tail (`advanceChain`'s last step):
  // solving and serving by hand would be a second implementation of the route.
  await (handler as unknown as { finishChain(s: ChatSession): Promise<void> }).finishChain(session);

  show('AFTER', sessions.get(chatId!)!);
  if (sent.length === 0) console.log('WARNING: nothing was sent to the client — check the plan state above');
  for (const t of sent) console.log(`\n── client would receive ──\n${t}`);
}

void main();
