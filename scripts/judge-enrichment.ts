#!/usr/bin/env tsx
/**
 * judge-enrichment — THE OFFLINE MISROUTE AUDIT (option C, 2026-09-22).
 *
 * The enrichment log holds every (client msg → bank reply) serve with its
 * routing key — but nothing records whether the reply FIT the message. A
 * wrong-key serve looks identical to a right-key serve. This script re-judges
 * the history in two layers:
 *
 *   1. DETERMINISTIC assertions (free, high-precision): availability asks
 *      served something else, price asks that got a non-price answer, fee
 *      asks after an explicit contact request, property-size offers under a
 *      fee.ask key, explicit corrections in the log itself.
 *   2. GEMINI judge (offline, zero runtime risk): for the remainder, a
 *      constrained yes/no/unsure verdict — "does this reply address THIS
 *      message, given the state?" — with a one-line reason.
 *
 * Output: data/judge/misroute-report.json + a printed per-key table ranked
 * by suspicion. REPORT ONLY — nothing is patched, nothing auto-files. This
 * is the measurement that tells us the REAL misroute rate per key.
 *
 * Usage:
 *   npx tsx scripts/judge-enrichment.ts --db data/tui.db            # deterministic only
 *   npx tsx scripts/judge-enrichment.ts --db data/tui.db --llm      # + Gemini layer
 */

import '../src/compat/node16';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { createLlmStrict } from '../src/llm/factory';
import { GeminiClient } from '../src/llm/geminiClient';
import { RotatingClient } from '../src/llm/rotatingClient';
import type { LlmClient } from '../src/llm/types';

/** Extra key pool: one GeminiClient per AQ.Ab8RN… line in a text file
 *  (rotation gives each key its own quota). */
function llmFromKeyFile(file: string): LlmClient {
  const keys = fs.readFileSync(file, 'utf8').split('\n')
    .map(l => l.trim()).filter(l => /^AQ\./.test(l));
  if (keys.length === 0) throw new Error(`no AQ.* keys found in ${file}`);
  const cfg = loadConfig();
  const pool = keys.map((k, i) => new GeminiClient(k, cfg.geminiModel, cfg.geminiModelClassify, undefined, `gemini:x${i + 1}`));
  console.log(`[judge] ${pool.length} key-file key(s) loaded from ${file}`);
  return pool.length > 1 ? new RotatingClient(pool) : pool[0]!;
}
import { detectAvailabilityAsk, detectPriceAsk, detectFeeWhy, detectFeeComplaint,
  detectNegotiate, detectFeePaymentAgreement, detectAgreement, detectVisitInterest,
  isPropertyOffer, detectWorkdaysQuestion } from '../src/llm/deterministic';
import { checkMisroute } from '../src/llm/misroute';

// ── Log access (mirrors EnrichmentStore but over an arbitrary DB path) ──────

interface LogRow {
  id: number;
  chatId: string;
  state: string;
  eventType: string;
  userMsg: string;
  replyText: string;
  bankKey: string | null;
  createdAt: number;
}

function loadLog(dbPath: string): LogRow[] {
  const db = new Db(dbPath);
  const rows = db.db.prepare(`
    SELECT id, chat_id AS chatId, state, event_type AS eventType,
           user_msg AS userMsg, reply_text AS replyText,
           bank_key AS bankKey, created_at AS createdAt
    FROM enrichment_queue ORDER BY chat_id, id
  `).all() as LogRow[];
  db.close();
  return rows;
}

// ── Layer 1: deterministic assertions ───────────────────────────────────────

export type Verdict = 'fit' | 'misroute' | 'unsure' | 'unchecked';

export interface Assertion {
  id: string;
  /** Returns true when this pair VIOLATES the assertion (a misroute). */
  violates: (row: LogRow) => boolean;
  why: string;
}

export const ASSERTIONS: Assertion[] = [
  {
    id: 'availability-ask-not-availability',
    why: 'client asks if the property is available; key is not availability.ack',
    violates: r => detectAvailabilityAsk(r.userMsg) && r.bankKey !== null && r.bankKey !== 'availability.ack',
  },
  {
    id: 'price-ask-not-price',
    why: 'client asks the price; key is not price.ask/freshness/fee-why',
    violates: r => detectPriceAsk(r.userMsg) && r.bankKey !== null
      && !['price.ask', 'price.freshness', 'fee.why', 'fee-counter'].includes(r.bankKey),
  },
  {
    id: 'property-offer-under-fee-ask',
    why: 'property-sized counter-offer served by a fee.ask key (08:20/10:54 class)',
    violates: r => (r.bankKey ?? '').startsWith('fee.ask.') && isPropertyOffer(r.userMsg),
  },
  {
    id: 'contact-request-under-unrelated-key',
    why: 'client asks to contact the owner; served an info/fee key instead of the contact protocol',
    violates: r => /stapi|stapete|kontaktiraj|контактирај|zakazi|закажи|dogovori|договари|договори/i.test(r.userMsg)
      && r.bankKey !== null
      && !['availability.ack', 'fee.ask.buy', 'fee.ask.rent'].includes(r.bankKey),
  },
  {
    id: 'why-question-under-info-key',
    why: 'client asks for property details/what it is; served an unrelated single-facet key',
    violates: r => /kazi mi (nesto )?(za|za nego|sto zn)/i.test(r.userMsg) && r.bankKey === 'location.confirm',
  },
  // ── Owner-relay assertions (20:24/20:26 class) — OWNER_RELAY / OWNER_ASK
  // rows carry a synthetic userMsg and a `owner.relay:*` / `owner.ask` key.
  // The relay is WRONG when it contradicts the verdict it relays.
  {
    id: 'owner-relay-dropped-alternative',
    why: 'verdict carried an alternative day/time but the relay never mentions it (the 20:24 dropped Saturday)',
    violates: r => {
      if (!(r.bankKey ?? '').startsWith('owner.relay:counter')) return false;
      const m = r.userMsg.match(/\[owner:\d+\] counter(?:\+wholeday)? @ (.+)/);
      // The logged time tag is mkTimePhrase'd; the relays embed the same
      // canonical form — a missing mention means the offer was dropped.
      return !!m && !!m[1] && !r.replyText.includes(m[1]);
    },
  },
  {
    id: 'owner-relay-wholeday-as-fixed-term',
    why: 'verdict flagged whole-day but the relay presents a FIXED term for acceptance instead of asking the client for the clock',
    violates: r => /\[owner:\d+\] counter\+wholeday/.test(r.userMsg)
      && /дали овој термин|дали термин|дали се согласувате на овој термин/iu.test(r.replyText),
  },
  {
    id: 'owner-relay-english-day',
    why: 'an English day name surfaced in the client-facing Macedonian relay (the "(Friday 18:00)" bug)',
    violates: r => (r.bankKey ?? '').startsWith('owner.relay:')
      && /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/.test(r.replyText),
  },
  {
    id: 'owner-ask-question-as-term',
    why: 'a working-hours QUESTION was forwarded to the owner as the proposed visit term (20:26 "VO NEDELA RABOTITE ?")',
    violates: r => r.bankKey === 'owner.ask' && detectWorkdaysQuestion(r.userMsg),
  },
];

/** Layer 1b — SEQUENCE MISMATCH (free): replay the LIVE intake logic
 *  (checkMisroute) over consecutive serve rows of each chat. Row N+1's
 *  userMsg is the client's next observed message after serve N — exactly the
 *  evidence the runtime intake uses. Non-logged intermediate messages may
 *  hide some signals, but anything flagged here is the same class the
 *  production intake now auto-files. */
function sequenceMismatches(rows: LogRow[]): Array<{ afterId: number; key: string | null; userMsg: string; reason: string }> {
  const out: Array<{ afterId: number; key: string | null; userMsg: string; reason: string }> = [];
  const byChat = new Map<string, LogRow[]>();
  for (const r of rows) {
    const list = byChat.get(r.chatId) ?? [];
    list.push(r);
    byChat.set(r.chatId, list);
  }
  for (const list of byChat.values()) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      const cur = list[i]!;
      const v = checkMisroute(cur.userMsg, {
        userMsg: prev.userMsg, bankKey: prev.bankKey, replyText: prev.replyText, createdAt: prev.createdAt,
      });
      if (v.kind === 'correction') {
        out.push({ afterId: prev.id, key: prev.bankKey, userMsg: cur.userMsg, reason: `client-said-wrong-answer` });
      } else if (v.kind === 'mismatch') {
        out.push({ afterId: prev.id, key: prev.bankKey, userMsg: cur.userMsg, reason: v.reason });
      }
    }
  }
  return out;
}

// ── Layer 2: Gemini judge ───────────────────────────────────────────────────

function judgePrompt(row: LogRow): string {
  return [
    'You audit a real-estate chatbot. Judge whether the REPLY addresses the MESSAGE the client sent.',
    'The client writes Macedonian/Latin-mixed text. The reply is Lina, the agent.',
    'Judge FIT, not style: does the reply respond to what the client actually asked or said, given the conversation state?',
    'Rules:',
    '- "yes" = the reply addresses the message (even if wording is imperfect).',
    '- "no"  = the reply answers a DIFFERENT question or ignores the message (a routing mistake).',
    '- "unsure" = you cannot decide without more context.',
    'Output exactly one line: VERDICT|one-short-reason  (verdict ∈ yes|no|unsure).',
    '',
    `STATE: ${row.state}`,
    `MESSAGE: ${row.userMsg.replace(/\n/g, ' | ')}`,
    `REPLY: ${row.replyText.replace(/\n/g, ' | ').slice(0, 400)}`,
  ].join('\n');
}

async function judgeWithLlm(llm: ReturnType<typeof createLlmStrict>, rows: LogRow[]): Promise<Map<number, { verdict: Verdict; reason: string }>> {
  const out = new Map<number, { verdict: Verdict; reason: string }>();
  for (const row of rows) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await llm.complete({
          role: 'generate',
          messages: [
            { role: 'system', content: 'You are a strict QA auditor. Output exactly one line in the format VERDICT|reason.' },
            { role: 'user', content: judgePrompt(row) },
          ],
          temperature: 0.2,
          maxTokens: 120,
        });
        const m = /\b(yes|no|unsure)\b/i.exec(r);
        if (!m) continue;
        // Map the judge's vocabulary onto the audit vocabulary: "no" (reply
        // answers a different question) IS a misroute finding.
        const said = m[1].toLowerCase();
        const verdict: Verdict = said === 'no' ? 'misroute' : said === 'yes' ? 'fit' : 'unsure';
        const reason = r.split('|').slice(1).join('|').trim().slice(0, 140) || '(no reason)';
        out.set(row.id, { verdict, reason });
        break;
      } catch { /* rotate/retry — the strict pool rotates keys internally */ }
    }
    if (!out.has(row.id)) out.set(row.id, { verdict: 'unchecked', reason: 'judge call failed (quota exhausted?)' });
  }
  return out;
}

// ── Main ────────────────────────────────────────────────────────────────────

interface Judgement {
  id: number;
  chatId: string;
  state: string;
  userMsg: string;
  bankKey: string | null;
  verdict: Verdict;
  source: 'assertion' | 'gemini' | 'deterministic-fit';
  why: string;
}

async function main(): Promise<void> {
  const dbArg = process.argv.includes('--db') ? process.argv[process.argv.indexOf('--db') + 1]! : 'data/tui.db';
  const useLlm = process.argv.includes('--llm');
  const keysArg = process.argv.includes('--keys') ? process.argv[process.argv.indexOf('--keys') + 1] : undefined;
  const rows = loadLog(dbArg);
  console.log(`[judge] ${rows.length} logged pairs from ${dbArg}`);
  const outDir = 'data/judge';
  const outFile = path.join(outDir, 'misroute-report.json');

  const judgements: Judgement[] = [];
  const unsureRows: LogRow[] = [];

  // Layer 1b first — sequence-level evidence from the live mismatch logic.
  const seq = sequenceMismatches(rows);
  if (seq.length > 0) console.log(`[judge] sequence layer: ${seq.length} historical mismatch(es)`);
  const seqIds = new Set(seq.map(s => s.afterId));

  for (const row of rows) {
    // Owner-exchange intake rows are AUDIT-ONLY: their verdicts are the
    // ground truth the owner-assertions check against, not client traffic —
    // skip the generic/LLM layers (the owner assertions below still run).
    const isOwnerRow = r => (r.bankKey ?? '').startsWith('owner.relay:') || r.bankKey === 'owner.ask';
    if (isOwnerRow(row) && !ASSERTIONS.some(a => a.id.startsWith('owner-') && (() => { try { return a.violates(row); } catch { return false; } })())) {
      judgements.push({ id: row.id, chatId: row.chatId, state: row.state, userMsg: row.userMsg,
        bankKey: row.bankKey, verdict: 'fit', source: 'assertion', why: 'owner-relay exchange consistent with its verdict' });
      continue;
    }
    // Deterministic FIT evidence first — an availability ask served by
    // availability.ack with the availability wording is a textbook fit.
    const hit = ASSERTIONS.find(a => {
      try { return a.violates(row); } catch { return false; }
    });
    if (hit) {
      judgements.push({ id: row.id, chatId: row.chatId, state: row.state, userMsg: row.userMsg,
        bankKey: row.bankKey, verdict: 'misroute', source: 'assertion', why: hit.why });
      continue;
    }
    if (!useLlm) {
      judgements.push({ id: row.id, chatId: row.chatId, state: row.state, userMsg: row.userMsg,
        bankKey: row.bankKey, verdict: 'unchecked', source: 'deterministic-fit', why: 'no deterministic violation (not judged without --llm)' });
      continue;
    }
    unsureRows.push(row);
  }

  if (useLlm && unsureRows.length > 0) {
    // Verdict cache: a previously judged row (same id, same content, verdict
    // decided) is reused — nightly re-runs only pay for NEW serves.
    const cache = new Map<number, { verdict: Verdict; reason: string }>();
    try {
      const prev = JSON.parse(fs.readFileSync(outFile, 'utf8')) as { judgements?: Judgement[] };
      for (const j of prev.judgements ?? []) {
        if (j.source !== 'gemini') continue;
        // Accept both the current vocabulary and the legacy judge words
        // (yes/no were briefly saved unmapped — the 2026-09-22 first run).
        const v = j.verdict as string;
        const mapped: Verdict | null = v === 'fit' || v === 'yes' ? 'fit'
          : v === 'misroute' || v === 'no' ? 'misroute'
          : v === 'unsure' ? 'unsure' : null;
        if (mapped) cache.set(j.id, { verdict: mapped, reason: j.why });
      }
    } catch { /* first run */ }
    const toJudge = unsureRows.filter(r => !cache.has(r.id));
    const cachedCount = unsureRows.length - toJudge.length;
    console.log(`[judge] ${unsureRows.length} pairs → Gemini layer (${cachedCount} cached, ${toJudge.length} fresh)`);
    const llm = keysArg ? llmFromKeyFile(keysArg) : createLlmStrict(loadConfig());
    const verdicts = await judgeWithLlm(llm, toJudge);
    for (const row of unsureRows) {
      const v = verdicts.get(row.id) ?? cache.get(row.id);
      if (!v) continue; // fresh judge failed and nothing cached — leave unchecked
      judgements.push({ id: row.id, chatId: row.chatId, state: row.state, userMsg: row.userMsg,
        bankKey: row.bankKey, verdict: v.verdict, source: 'gemini', why: v.reason });
    }
  }

  // ── Report ────────────────────────────────────────────────────────────
  // Examined = assertion-fired + Gemini-judged (fit/misroute/unsure).
  // `unchecked` rows had no deterministic violation and no usable judge
  // verdict (quota exhaustion) — NOT evidence of fit, excluded from the
  // rate and from "clean keys". `unsure` counts as examined-but-inconclusive:
  // it lowers confidence but is never counted as fit OR misroute.
  const examined = judgements.filter(j => j.verdict !== 'unchecked');
  const decided = examined.filter(j => j.verdict !== 'unsure');
  const total = decided.length;
  const misrouted = examined.filter(j => j.verdict === 'misroute');
  const unsure = examined.length - total;
  const unchecked = judgements.length - examined.length;
  const rate = total ? (100 * misrouted.length / total).toFixed(1) : '0.0';

  const byKey = new Map<string, { served: number; mis: number }>();
  for (const j of decided) {
    const k = j.bankKey ?? '(null)';
    const e = byKey.get(k) ?? { served: 0, mis: 0 };
    e.served++;
    if (j.verdict === 'misroute') e.mis++;
    byKey.set(k, e);
  }

  console.log(`\n═══ MISROUTE REPORT — ${misrouted.length}/${total} decided pairs misrouted (${rate}%), ${unsure} unsure, ${unchecked} unchecked (quota) ═══\n`);
  console.log('per-key (ranked by misroute count):');
  for (const [k, { served, mis }] of [...byKey.entries()].sort((a, b) => b[1].mis - a[1].mis || b[1].served - a[1].served)) {
    if (mis === 0) continue;
    console.log(`  ${k.padEnd(22)} ${String(mis).padStart(3)}/${String(served).padEnd(3)} (${(100 * mis / served).toFixed(0)}%)`);
  }
  console.log('\nclean keys:', [...byKey.entries()].filter(([, v]) => v.mis === 0).map(([k]) => k).join(', ') || '(none)');

  console.log('\n— misrouted pairs —');
  for (const j of misrouted) {
    console.log(`  #${j.id} [${j.source}] ${j.bankKey ?? '(null)'} ← "${j.userMsg.replace(/\n/g, ' ').slice(0, 52)}" — ${j.why}`);
  }
  if (seq.length > 0) {
    console.log('\n— sequence-layer mismatches (the live intake auto-files these) —');
    for (const s of seq) {
      console.log(`  after #${s.afterId} [${s.key ?? '(null)'}] ← "${s.userMsg.replace(/\n/g, ' ').slice(0, 52)}" — ${s.reason}`);
    }
  }
  // Gemini "no" verdicts that the deterministic layer missed — the novel
  // misroute classes only the judge can see (neighborhood asks, remark
  // handling, fee-question routing).
  const judgeOnly = misrouted.filter(j => j.source === 'gemini');
  if (judgeOnly.length > 0) {
    console.log(`\n— judge-only misroutes (invisible to the deterministic layer) —`);
    for (const j of judgeOnly) {
      console.log(`  #${j.id} ${j.bankKey ?? '(null)'} ← "${j.userMsg.replace(/\n/g, ' ').slice(0, 52)}" — ${j.why}`);
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: Date.now(), db: dbArg, total, misrouted: misrouted.length, judgements, sequenceMismatches: seq }, null, 2));
  console.log(`\n[judge] report → ${outFile}${unchecked ? ` (${unchecked} rows left unchecked — judge quota exhausted)` : ''}`);
}

// Run only when executed directly (tests import the ASSERTIONS table).
if (process.argv[1]?.endsWith('judge-enrichment.ts')) {
  main().catch(e => { console.error('[judge] FATAL', e); process.exit(1); });
}
