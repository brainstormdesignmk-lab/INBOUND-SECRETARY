/**
 * transcriptReplay — the library behind `scripts/transcript-replay.ts` and the
 * capture fixtures in tests/fixtures/transcripts/.
 *
 * A capture is only worth arguing about once it is REPLAYABLE: this runs the
 * real InboundHandler, VisitScheduler and deterministic detectors in an
 * in-memory DB, feeds a transcript line by line, and records what each party
 * actually received. Same code path as production, no live chat.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession } from '../src/fsm/session';
import type { State } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { LlmClient } from '../src/llm/types';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { EventStore } from '../src/store/events';
import { OwnerStore } from '../src/store/owners';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LandmarkService } from '../src/geo/landmarks';
import { VisitScheduler } from '../src/visits/scheduler';

export const FEED_URL = 'https://qkgioqotxjxffiaufgwd.supabase.co/functions/v1/public-properties?format=json';

/** Deterministic mode: no model, so a replay of a detection bug is exact. */
export class NoLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('replay: deterministic mode (pass --llm to use the model)'); }
}

class ReplayProps extends PropertyService {
  constructor(private rows: Property[]) { super(FEED_URL); }
  async getAll() { return this.rows; }
  async getByEb(eb: number) { return this.rows.find(r => r.eb === eb); }
  async locations() { return [...new Set(this.rows.map(r => (r.location ?? '').trim()).filter(Boolean))]; }
  get healthy(): boolean { return true; }
}

export type TranscriptLine =
  | { kind: 'say'; at: string; text: string }
  | { kind: 'directive'; name: string; arg: string };

/**
 * One client line per turn; blank lines and `#` comments are ignored; a leading
 * `[HH:MM]` or `HH:MM` is kept as that turn's clock.
 *
 *   [21:56] КЛИЕНТ: CETVRTOK POPLADNE MOZAM POSLE 6
 *
 * Directives apply before the next client line:
 *   !state visit_scheduling        · !eb 62
 *   !arranged 47 сабота во 12:00   · !owner [eb] <name> <phone>
 *   !clock 2026-10-23T21:56        · !rewind 90   (minutes — simulates TTL expiry)
 *   !feed sjo-pair                 rows from tests/fixtures/feeds/<name>.json
 *                                  (a capture that quotes a card needs the card)
 *
 * `# EXPECT` lines state the verdict a fixture promises (the list is in
 * checkExpectations below):
 *   # EXPECT no-silence                every client turn got an answer
 *   # EXPECT last-mentions термин      the last reply says this
 *   # EXPECT last-not-mentions термин  the last reply must not say this
 *   # EXPECT cancel <eb>               cancelled exactly that Евидентен број
 *   # EXPECT no-cancel                 nothing was cancelled
 *   # EXPECT ask-which                 the which-visit question was asked
 *   # EXPECT final-state <state>
 */
export function parseTranscript(text: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const directive = line.match(/^\s*!(\w+)\s*(.*)$/);
    if (directive) { out.push({ kind: 'directive', name: directive[1], arg: directive[2].trim() }); continue; }
    const stamped = line.match(/^\s*\[?(\d{1,2}:\d{2})\]?\s*(.*)$/);
    const at = stamped ? stamped[1] : '--:--';
    const text = (stamped ? stamped[2] : line).replace(/^\s*(?:КЛИЕНТ|CLIENT|Клиент)\s*:\s*/i, '').trim();
    if (text) out.push({ kind: 'say', at, text });
  }
  return out;
}

/** `# EXPECT <what>` lines of a fixture — the assertions it carries. */
export function parseExpectations(text: string): string[] {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => /^#\s*EXPECT\b/i.test(l))
    .map(l => l.replace(/^#\s*EXPECT\s*/i, '').trim());
}

export interface TurnRecord {
  at: string;
  text: string;
  /** Everything the client received this turn, in order. */
  clientMsgs: string[];
  /** Everything the owner was told, with the Евидентен број it carried. */
  ownerMsgs: Array<{ eb: number; text: string }>;
  operatorLogs: string[];
  state: string;
}

export interface ReplayResult {
  turns: TurnRecord[];
  seeds: string[];
  finalState: State;
  /** EB of a visit cancellation that actually went out (the scheduler's log). */
  cancelledEb?: number;
  askedWhichVisit: boolean;
}

export interface ReplayOptions {
  /** Feed rows. Omit to run without a feed — the visit lanes still work. */
  properties?: Property[];
  llm?: LlmClient;
  /** The wall clock the FIRST turn runs at; later turns follow their stamps. */
  now?: Date;
  chatId?: string;
}

export async function runTranscript(lines: TranscriptLine[], opts: ReplayOptions = {}): Promise<ReplayResult> {
  const cfg = loadConfig();
  const llm = opts.llm ?? new NoLlm();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const appointments = new AppointmentStore(db);
  const events = new EventStore(db);
  const owners = new OwnerStore(db);
  // Mutable so a `!feed` directive can hand a later turn the cards the capture
  // was looking at — the resolver reads rows, so a missing row is a missing bug.
  const feed: Property[] = [...(opts.properties ?? [])];
  const props = new ReplayProps(feed);
  const chatId = opts.chatId ?? 'replay';

  // Messages are buffered per turn: the scheduler AND the handler both reach the
  // client, and a capture is about the SUM of what the phone received.
  let clientMsgs: string[] = [];
  let ownerMsgs: Array<{ eb: number; text: string }> = [];
  let operatorLogs: string[] = [];
  const channels = new ChannelRegistry();
  channels.register({ name: 'replay', send: async (_c: string, text: string) => { clientMsgs.push(text); } });

  let clock = opts.now ?? new Date();
  const sched = new VisitScheduler({
    db, events, owners, properties: props,
    notifyClient: async (_c: string, text: string) => { clientMsgs.push(text); },
    notifyOwner: async (_c: string, eb: number, text: string) => { ownerMsgs.push({ eb, text }); },
    notifyOperator: async (text: string) => { operatorLogs.push(text); },
    now: () => clock,
  });

  const handler = new InboundHandler({
    cfg, db, sessions, classifier: new Classifier(llm, cfg, props), responder: new Responder(llm, cfg),
    properties: props, appointments, escalations: new EscalationStore(db), meta: new MetaStore(db),
    channels, landmarks: new LandmarkService(db, { osm: false }), visits: sched,
  });

  const session = freshSession('replay', chatId);
  sessions.set(session);

  const seeds: string[] = [];
  const turns: TurnRecord[] = [];
  let pendingEb: number | undefined;
  let cancelledEb: number | undefined;
  let askedWhichVisit = false;
  // Directives must edit the STORE's current session: the handler loads its own
  // copy per turn, so writing a stale local object would clobber the state the
  // previous turn persisted (that is how a terminated chat got resurrected mid
  // replay).
  const current = () => sessions.get(chatId) ?? session;

  for (const line of lines) {
    if (line.kind === 'directive') {
      const arg = line.arg;
      switch (line.name) {
        case 'state': {
          const s = current();
          s.state = arg as State;
          sessions.set(s);
          seeds.push(`state ${arg}`);
          break;
        }
        case 'eb': {
          pendingEb = Number(arg);
          const s = current();
          s.slots.propertyId = pendingEb;
          s.slots.interestedPropertyId = pendingEb;
          sessions.set(s);
          seeds.push(`property in play EB ${pendingEb}`);
          break;
        }
        case 'arranged': {
          const m = arg.match(/^(\d+)\s*(.*)$/);
          if (!m) throw new Error(`!arranged needs "<eb> <time>" — got «${arg}»`);
          const eb = Number(m[1]);
          const id = appointments.insert({
            chatId, clientName: session.slots.name ?? 'Клиент',
            clientPhone: session.slots.phone ?? '070000000', propertyId: eb,
            service: session.slots.service === 'rent' ? 'rent' : 'buy',
            viewingFee: session.slots.service === 'rent' ? '300' : '500',
            time: m[2] || null, agentPhone: null,
          });
          appointments.markFinalized(id, m[2] || '');
          seeds.push(`arranged visit for EB ${eb} — «${m[2]}»`);
          break;
        }
        case 'owner': {
          const m = arg.match(/^(?:(\d+)\s+)?(\S+)\s+(\S+)$/);
          const eb = m?.[1] !== undefined ? Number(m[1]) : pendingEb;
          if (!m || eb === undefined) throw new Error('!owner needs "<name> <phone>", or "<eb> <name> <phone>"');
          owners.upsert({ eb, name: m[2], phone: m[3], status: 'available' });
          seeds.push(`owner ${m[2]} ${m[3]} for EB ${eb}`);
          break;
        }
        case 'feed': {
          const file = path.join(__dirname, '..', 'tests', 'fixtures', 'feeds', `${arg}.json`);
          const rows = JSON.parse(readFileSync(file, 'utf8')) as Property[];
          feed.push(...rows);
          seeds.push(`feed ${arg}: ${rows.length} rows`);
          break;
        }
        case 'clock':
          clock = new Date(arg);
          break;
        case 'rewind': {
          // Time passes between turns (a client writing back the next day), but
          // the process clock never moves in a replay: move the SESSION's own
          // timestamps into the past instead, which is what the TTL reads.
          const minutes = Number(arg);
          const s = current();
          s.lastInboundAt -= minutes * 60_000;
          s.lastOutboundAt -= minutes * 60_000;
          sessions.set(s);
          seeds.push(`session aged ${minutes} min (TTL check)`);
          break;
        }
        default:
          seeds.push(`unknown directive !${line.name} (ignored)`);
      }
      continue;
    }

    const stamp = line.at.match(/^(\d{1,2}):(\d{2})$/);
    if (stamp) {
      const d = new Date(clock);
      d.setHours(Number(stamp[1]), Number(stamp[2]), 0, 0);
      clock = d;
    }
    clientMsgs = [];
    ownerMsgs = [];
    operatorLogs = [];
    await handler.handle('replay', chatId, line.text);
    const cancelLog = operatorLogs.find(l => /CANCELLED by/.test(l));
    const ebHit = cancelLog?.match(/ЕБ (\d+)\]/);
    if (ebHit) cancelledEb = Number(ebHit[1]);
    if (clientMsgs.some(m => /За која посета/.test(m))) askedWhichVisit = true;
    turns.push({
      at: line.at, text: line.text,
      clientMsgs: [...clientMsgs], ownerMsgs: [...ownerMsgs], operatorLogs: [...operatorLogs],
      state: sessions.get(chatId)!.state,
    });
  }

  const finalState = sessions.get(chatId)!.state;
  db.close();
  return { turns, seeds, finalState, cancelledEb, askedWhichVisit };
}

/** `# EXPECT` lines → pass/fail, so a fixture can be its own regression test. */
export function checkExpectations(result: ReplayResult, expectations: string[]): string[] {
  const failures: string[] = [];
  const cancelledTurns = result.turns.filter(t => t.operatorLogs.some(l => /CANCELLED by/.test(l)));
  const lastClient = result.turns.length > 0
    ? result.turns[result.turns.length - 1]!.clientMsgs.join('\n')
    : '';
  for (const exp of expectations) {
    const noCancel = exp.match(/^no-cancel$/i);
    const cancel = exp.match(/^cancel\s+(\d+)$/i);
    const askWhich = exp.match(/^ask-which$/i);
    const state = exp.match(/^final-state\s+(\w+)$/i);
    // NO-SILENCE: a released chat that only resets is a chat that ignored the
    // client — every turn they wrote must have reached a phone.
    const noSilence = exp.match(/^no-silence$/i);
    const mentions = exp.match(/^last-mentions\s+(.+)$/i);
    const notMentions = exp.match(/^last-not-mentions\s+(.+)$/i);
    if (noCancel) {
      if (cancelledTurns.length > 0) failures.push('no-cancel: a cancellation went out');
    } else if (cancel) {
      const eb = Number(cancel[1]);
      if (result.cancelledEb !== eb) failures.push(`cancel ${eb}: cancelled EB is ${result.cancelledEb ?? '(none)'}`);
      if (cancelledTurns.length !== 1) failures.push(`cancel ${eb}: ${cancelledTurns.length} cancellations, expected exactly 1`);
    } else if (askWhich) {
      if (!result.askedWhichVisit) failures.push('ask-which: the which-visit question was never sent');
    } else if (state) {
      if (result.finalState !== state[1]) failures.push(`final-state ${state[1]}: ended in ${result.finalState}`);
    } else if (noSilence) {
      const silent = result.turns.filter(t => t.clientMsgs.length === 0);
      if (silent.length > 0) {
        failures.push(`no-silence: ${silent.length} turn(s) got nothing — ${silent.map(t => `«${t.text}»`).join(', ')}`);
      }
    } else if (mentions) {
      if (!lastClient.includes(mentions[1]!)) failures.push(`last-mentions «${mentions[1]}»: last reply was «${lastClient}»`);
    } else if (notMentions) {
      if (lastClient.includes(notMentions[1]!)) failures.push(`last-not-mentions «${notMentions[1]}»: last reply was «${lastClient}»`);
    } else {
      failures.push(`unknown expectation «${exp}»`);
    }
  }
  return failures;
}
