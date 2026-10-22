// The response-bank picker: repeat-avoiding variant selection for the
// LLM-free / code-built paths. The bank (src/data/responses.ts) is GENERATED
// by `npm run responses:generate`; this module is the hand-written runtime
// half. Variants are DECORATIVE — the funnel logic stays code-built and
// deterministic, this only varies wording.
//
// Repeat avoidance is derived from the session history (recent assistant
// texts), never stored per-chat: a variant whose normalized text already
// appeared recently is skipped, so Lina never parrots the same sentence in a
// row. When every variant of a key was recently used, the picker falls back to
// the full pool rather than returning nothing.

import { RESPONSE_BANK } from './responses';
import { locPrep } from './properties';
import type { State } from '../fsm/machine';
import type { BankStore } from '../store/bank';

/** The learned bank layer (SQLite), injected at boot. May be undefined in
 *  scripts/tests that run without the store — the seed bank still works. */
let learned: BankStore | undefined;
export function setLearnedBank(b: BankStore | undefined): void { learned = b; }
export function getLearnedBank(): BankStore | undefined { return learned; }

/** Normalized comparison form — same rules as the generator's dedupe. */
export function normalizeVariant(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[.,!?;:„“"'()—–-]/g, '').trim();
}

const IMOT_VOCAB_RE = /(?:^|[^\p{L}])имот(?:от|ите|и)?(?![\p{L}])/iu;

function fillVars(text: string, vars?: Record<string, string>): string {
  if (!vars) return text;
  let out = text;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
  // NA/VO agreement: the bank templates hardcode "во {location}" — but Водно
  // is a mountain and takes "на" ("на Водно"). Normalize at fill time so every
  // variant (seed AND learned) speaks correct Macedonian without editing each.
  const loc = vars['location'];
  if (loc && locPrep(loc) === 'на') {
    out = out
      .split(`во ${loc}`).join(`на ${loc}`)
      .split(`во ${loc.toLowerCase()}`).join(`на ${loc}`)
      .split(`vo ${loc}`).join(`на ${loc}`);
  }
  return out;
}

export interface PickOpts {
  /** Assistant texts already sent (from session history) — picked variants avoid these. */
  recent?: string[];
  /** Placeholder values, e.g. { location: 'Центар' } fills "{location}". */
  vars?: Record<string, string>;
}

/**
 * HAND-WRITTEN SEEDS for keys whose wording is a policy, not a paraphrase.
 *
 * The generated bank (responseBank.ts's RESPONSE_BANK) is decorative copy —
 * safe to vary. A persona answer is not: every variant must keep Lina in the
 * first person, never expose a machine identity, and never state an age. A
 * model must not author those, so the seeds live here and the learned layer
 * still appends to them (the read path is identical).
 */
/** Seeds of the cheap-price remark lane — exported so tests can assert the
 *  served text came from here (the learned layer may add variants later). */
export const PRICE_EVAL_CHEAP_SEEDS: string[] = [
  'Да, навистина е поволна цена за она што го нуди — ретко се среќава толку добра комбинација. Дали сакате да ја погледнете во живо?',
  'Се согласувам, цената е одлична за оваа локација. Дали да Ви организирам посета?',
  'Токму затоа и Ви ја предложив — односот цена и квалитет е многу добар. Дали продолжуваме со разгледување?',
];

/** Seeds of the EXPENSIVE-price remark lane — the negative half of the valence
 *  axis, wired in P5.2 under the arbiter's evidence boundary. Policy seeds,
 *  hand-written: acknowledge the objection, state that the price is
 *  owner-determined and within the market, invite the live viewing. NEVER an
 *  amount, NEVER a discount promise, NEVER fee disclosure (the same guard
 *  class as the cheap seeds above). */
export const PRICE_EVAL_EXPENSIVE_SEEDS: string[] = [
  'Разбирам — цената изгледа висока. Таа е одредена од самиот сопственик и за оваа локација е во рамките на пазарот. Сакате да ја видите во живо за сами да ја оцените?',
  'Знам дека цената не е мала — за оваа локација и квадратура е во рамки на пазарот. Да организирам посета, на лице место најлесно се проценува вредноста?',
  'Цената ја става самиот сопственик — јас не преговарам во чат. Но ако Ви се допаѓа самата недвижност, да Ви закажам посета да ја оцените во живо?',
];

/** PUBLIC for tests/review: the hand-written policy seeds (the generated
 *  bank RESPONSE_BANK is the decorative layer; these are the guarded ones). */
export const FIXED_SEEDS: Record<string, string[]> = {
  'personal.name': [
    'Јас сум Лина, од агенцијата Метрополис. Како можам да Ви помогнам?',
    'Лина — на Ваша услуга во Метрополис. Со што да почнеме?',
    'Лина сум. Слободно кажете ми што Ве интересира.',
  ],
  'personal.age': [
    'Годините не ги кажувам — но со задоволство ќе Ви помогнам да најдете добра недвижност.',
    'Тоа е мала тајна! Поважно е она што можам да го сторам за Вас.',
    'Не откривам години, но тука сум за сѐ што Ве интересира за недвижноста.',
  ],
  'personal.compliment': [
    'Ви благодарам, тоа е многу љубезно! Со задоволство продолжувам да Ви помагам.',
    'Мило ми е што Ви се допаѓа разговорот — Ви благодарам!',
    'Ви благодарам! Кажете, како да продолжам да Ви помогнам.',
  ],
  // CHEAP-PRICE REMARK — a client saying the quoted price is good is a remark,
  // not funnel traffic: acknowledge the value, never re-disclose the fee, never
  // invent availability. Hand-written policy-ish seeds (no generator).
  'remark.price.cheap': PRICE_EVAL_CHEAP_SEEDS,
  // EXPENSIVE-PRICE REMARK (wired P5.2): the negative valence half — see the
  // seeds above for the policy guard (no amounts, no discounts, no fee talk).
  'remark.price.expensive': PRICE_EVAL_EXPENSIVE_SEEDS,
  // MONEY WITHOUT A TARGET (hard invariant 3): money vocabulary whose object is
  // unresolved (no fee referent, no property noun, nothing bound). The serve is
  // the ONE safe script — a clarification — never a protocol/ladder line.
  // Hand-written (no generator): the wording must stay question-shaped and
  // amount-free, and name BOTH candidate objects so the client's answer
  // resolves the target deterministically.
  'ask.money.clarify': [
    'За да Ви одговорам точно — дали го прашувате за цената на конкретна недвижност или за надоместокот за разгледување?',
    'Сакам да Ви дадам точен одговор само еднаш: го прашувате за цената на недвижноста или за цената на посета?',
    'Само да разјасниме едно — интерес Ви е цената на некоја недвижност или надоместокот за разгледување?',
  ],
  // Owner-confirmed policy: an agency agent accompanies the client at a viewing.
  // Learned, reviewed variants may join this seed without touching the frozen
  // fee disclosure key or its funnel behavior.
  'learn.agent-accompanies-viewing': [
    'Да, агент на Метрополис ќе Ве придружува при разгледувањето на избраната недвижност. Кога ќе одлучите, ќе продолжиме со организирање на посетата — дали Ви одговара?',
  ],
  // SMALLER-BY-RATE (the [00:12] Kisela Voda burst): the intro names the
  // anchor's €/м² as the reference ({rate}); the empty line keeps the funnel
  // alive with the register step. Learned variants may join both keys.
  'smaller.perM2.intro': [
    'Разбирам — помал стан при иста цена за м² значи и помала вкупна сума. Со {rate} евра за м² како референца, еве помал стан со таа или пониска ставка:',
    'Станот од {rate} евра за м² е најблиска како ставка — еве помал стан со иста или пониска цена за м²:',
  ],
  'smaller.perM2.empty': [
    'Помал стан од тој профил со цена за м² до {rate} евра немам во моментов. Можам да ги запишам Вашите критериуми и да Ве известам штом се појави соодветна опција — дали да Ве запишам?',
  ],
  // GOLEM complaint (no rate anchor): the intro owns the too-big confession,
  // the empty line the register pivot.
  'golem.smaller.intro': [
    'Разбирам, станот Ви се чини голем. Помал стан носи и помала вкупна сума — еве најблиските помали:',
    'Помал стан значи помала квадратура — еве ги помали станови што ги имам во понуда:',
  ],
  'golem.smaller.empty': [
    'Помал стан од {size} немам во моментов{where}. Можам да ги запишам Вашите критериуми и да Ве известам штом се појави соодветна опција — дали да Ве запишам?',
  ],
};

/** Pick a variant for a bank key, or undefined when the key has no variants yet.
 *  Layered: seed (responses.ts) + learned (SQLite bank_variants). Learned
 *  variants are LIVE without rebuild; the seed layer is the boot fallback if
 *  the DB is corrupted. Repeat avoidance spans BOTH layers. */
export function pickVariant(key: string, opts: PickOpts = {}): string | undefined {
  const seed = RESPONSE_BANK[key] ?? FIXED_SEEDS[key] ?? [];
  // Owner rule (2026-10-19): "имот" means land/a plot in this agency's usage —
  // every general property answer says "недвижност". Learned rows that predate
  // the rule must not keep serving the old vocabulary until the next relearn
  // pass; the seed bank is rewritten and the generator vetoes it at write time.
  const learnedVars = (learned ? learned.variants(key) : []).filter(v => !IMOT_VOCAB_RE.test(v));
  // Layer is tracked per variant, not per key: the point of the metric is
  // "did the closed loop grow this answer?", and a key can serve BOTH layers.
  const variants = [
    ...seed.map(text => ({ text, layer: 'seed' as const })),
    ...learnedVars.map(text => ({ text, layer: 'learned' as const })),
  ];
  // P0 meters: every serve is a hit, every empty lookup a miss — this is the
  // single funnel all bank-backed replies pass through, so the per-key
  // serve-rate here IS the production coverage signal. learned_serves says how
  // much of that coverage the loop grew (see learnedRate).
  if (variants.length === 0) { learned?.metric(key, false); return undefined; }
  const recent = new Set((opts.recent ?? []).map(normalizeVariant));
  const fresh = variants.filter(v => !recent.has(normalizeVariant(v.text)));
  const pool = fresh.length > 0 ? fresh : variants;
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  learned?.metric(key, true, chosen.layer);
  return fillVars(chosen.text, opts.vars);
}

/**
 * RETRIEVAL: match a free-form client message against the learned examples
 * table and serve a variant for the matched key — the card catalog of the
 * bank. Offline (SQLite read), sub-ms. Returns undefined when nothing
 * matches or the matched key has no variants in either layer; callers then
 * escalate to the LLM. Records a hit/miss metric when a store is attached.
 */
export function retrieveVariant(userMsg: string, opts: PickOpts = {}): string | undefined {
  if (!learned) return undefined;
  const hit = learned.retrieve(userMsg);
  if (!hit) return undefined;
  // pickVariant records the hit/miss metric — no double-count here.
  return pickVariant(hit.key, opts);
}

/** Record a bank MISS for a key the runtime needed but could not serve. */
export function recordBankMiss(key: string): void {
  learned?.metric(key, false);
}

/**
 * LLM-down / guard-blocked fallback line. Most states will get a
 * 'fallback.<state>' bank key in later generation batches; today only
 * owner_checking has one (the patience line). A missing key returns undefined
 * and the caller uses its code-built FALLBACKS line unchanged.
 */
export function fallbackVariant(state: State, recent: string[] = []): string | undefined {
  const key = state === 'owner_checking' ? 'patience.line' : `fallback.${state}`;
  return pickVariant(key, { recent });
}

/**
 * The deterministic empty-result line, bank-backed: the location form fills
 * {location}, the plain form is used when no area was named. Returns undefined
 * when the bank has no variants, so the caller keeps its code-built line.
 */
export function noMatchLine(location: string | undefined, recent: string[] = []): string | undefined {
  return location
    ? pickVariant('no.match.location', { recent, vars: { location } })
    : pickVariant('no.match.plain', { recent });
}

/**
 * The TYPE-AWARE empty-result intro: when a small-category search (garsonjera)
 * has no EXACT hits in the area but bigger units exist, Lina says so honestly
 * and offers the closest options — one sentence, then the cards. The prefix
 * + opener combo ("нема… Еве ги најблиските" followed by "Врз основа на…")
 * read as two contradictory speakers; this replaces both when present.
 * The 19:34 bug also fabricated "стан со една спална" — a criterion the
 * client never gave (garsonjera is a TYPE, not a спални count).
 */
export function relaxedCategoryLine(
  garsonjera: boolean | undefined,
  requestedBeds: number | undefined,
  location: string | undefined,
  recent: string[] = [],
): string | undefined {
  if (!garsonjera) return undefined;
  const where = location ? ` ${locPrep(location)}` : '';
  return pickVariant('presentation.relaxed.category', { recent })
    ?? `Во моментов немам слободна гарсоњера${where}, но имам мало станче во Ваша цена — ако Ви се допаѓа, може веднаш да организираме посета.`;
}

/**
 * The exhausted-area line, bank-backed: the selected area(s) are drained and
 * Lina asks whether to look elsewhere (or register the criteria). The location
 * form fills {location}; the plain form is used when no area was fixed.
 * Returns undefined when the bank has no variants, so the caller keeps its
 * code-built line.
 */
export function exhaustedLine(location: string | undefined, recent: string[] = []): string | undefined {
  return location
    ? pickVariant('exhausted.location', { recent, vars: { location } })
    : pickVariant('exhausted.plain', { recent });
}
