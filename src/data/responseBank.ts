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
  // BARE BUDGET-UP (the [25:2x] queue): "DAJ NESTO POSKAPO TOGAS" — the
  // upward mirror of the cheaper intros. Direction wording only: the batch
  // itself is strictly pricier than the anchor, so no amount is named.
  'pricier.search.intro': [
    // «Се разбира», never the Serbian calque «Разбира се» (the [00:26]
    // capture read it as broken Macedonian). The idiom is impersonal.
    'Се разбира — еве нешто поскапо со истите карактеристики, почнувајќи од најскапите што ги имам:',
    'Тогаш еве повисок селекционен опсег — исти критериуми, поголем буџет:',
  ],
  // CHEAPER CHOICE (the [14:46] rule): pool A (cheaper + same characteristics
  // + same naselba) is empty — Lina ASKS which fallback the client wants
  // instead of serving mismatched types. The two serve intros and the apology
  // prefix ride the same seed convention; learned variants may join later.
  'price.shy.choice': [
    'Во таа населба нема поевтини станови со истите карактеристики. Дали да Ви покажам помали станови во истата населба, или станови со истите карактеристики во соседните населби?',
  ],
  'cheaper.choice.area': [
    'Разбирам — еве ги поевтините помали станови во таа населба:',
  ],
  'cheaper.choice.elsewhere': [
    'Еве станови со истите карактеристики во соседните населби:',
  ],
  // CRITERIA-DONE CHOICE (the [20:33] capture): the criteria-fitting pool is
  // exhausted and the client asks for more ("drugo") — Lina SAYS the matching
  // options are done and offers the two standard pivots; nothing serves
  // before the answer (never silently over-budget/off-type/off-area rows).
  'batch.done.choice': [
    'Ги разгледав Вашите критериуми — предлозите што Ви ги покажав се сè што имам соодветно во моментов. Дали да Ви покажам нешто поскапо во истиот реон, или станови со истата цена во други населби?',
    'Понудените опции се сè што одговара на Вашите критериуми за сега. Дали да побарам нешто поскапо во истиот реон, или со истата цена во други населби?',
  ],
  // The "same price, different neighborhoods" answer of the criteria-done
  // choice — the batch intro. One sentence, then the cards.
  'batch.done.elsewhere': [
    'Немам повеќе соодветни во овој реон — еве станови со Вашата цена во соседните населби:',
    'Во истиот реон нема повеќе — еве што има со истата цена во соседните населби:',
  ],
  'correction.apology': [
    'Извинете за недоразбирањето — карактеристиките на предлог-списокот не беа вашите. Еве станови со истите карактеристики, а поевтини:',
    'Извинете за мешаницата — такви типови немаше да Ви покажувам тука. Еве станови со истите карактеристики, а поевтини:',
  ],
  // THE AVAILABILITY ACK (the [23:41] capture) — the owner answered the FIRST
  // half of the compound ask («DOSTAPNA E DA»): the flat is available, the term
  // is still open. Two keys, because the two meanings differ: a term is on the
  // table (ask whether it suits) or nobody named one (ask for it).
  //
  // OWNER-facing, so the pool MUST rotate: the owner is ONE human who re-reads
  // the same pane on every viewing — a single fixed sentence makes the third
  // appointment read like a script to the one person whose trust this line
  // exists to earn. Hand-written (not generated): the wording is protocol, and
  // every variant must keep «недвижноста» (feminine — the generic noun agrees
  // for стан, куќа and плац alike) and end on the open question.
  // {prop} fills as « (Евидентен број 54)» — or "" when the flat is unknown;
  // {term} fills with the RENDERED term (renderVisitTerm), never the raw words.
  'owner.availability.ack.term': [
    'Одлично, значи недвижноста{prop} е достапна. Дали Ви одговара посета во {term}, или имате друг предлог?',
    'Добро, недвижноста{prop} е слободна. Дали посета во {term} Ви одговара, или би предложиле друг термин?',
    'Разбрав — недвижноста{prop} е достапна. Останува само терминот: дали {term} е во ред, или имате друг предлог?',
    'Благодарам, значи недвижноста{prop} е достапна. Дали {term} Ви одговара за посетата, или да бараме друг термин?',
  ],
  // No term on the table at all (an «ok» with nothing to accept): confirm what
  // he said and ask HIM for the term — never a fabricated clock.
  'owner.availability.ack.noterm': [
    'Одлично, значи недвижноста{prop} е достапна. Кој термин Ви одговара за посета?',
    'Добро, недвижноста{prop} е слободна. Кој ден и во колку часот Ви одговараат за посета?',
    'Разбрав, недвижноста{prop} е достапна. Кога би Ви одговарало да ја видите?',
    'Благодарам — недвижноста{prop} е достапна. Предложете ми термин: кој ден Ви одговара?',
  ],
};

/** THE SEED LAYER of a key — the generated bank, else the hand-written policy
 *  seeds. ONE expression for pickVariant, the contract sweep and the tests: a
 *  data-level check that read only RESPONSE_BANK would silently pass a policy
 *  pool whose seeds live in FIXED_SEEDS. */
export function seedVariants(key: string): string[] {
  return RESPONSE_BANK[key] ?? FIXED_SEEDS[key] ?? [];
}

/**
 * ROTATING POOL CONTRACTS — the one MEANING every variant of a pool must
 * carry, expressed as a regex root. The pools rotate (learned variants are
 * added live, the seed layer is committed wholesale), so tests must assert
 * the CONTRACT and not one variant's exact wording: a string assertion breaks
 * whenever a different variant of the same meaning is served.
 *
 * Adding a variant to one of these pools? Its meaning must still satisfy the
 * contract — `matchesPoolContract` checks a SERVED text, and a data-level
 * test in tests/responseBank.test.ts checks every variant in the file.
 *
 * Documented pools:
 *  - owner.relay:counter.bare — the owner CANNOT the proposed term and gave
 *    NO alternative. Every variant relays the refusal honestly AND asks for
 *    ANOTHER term («кое друго време», «коj друг термин», «во друг термин»):
 *    never a fabricated term the client could accept, never a bare apology.
 *    The {time} in the templates is the REFUSED term, display-normalized by
 *    the caller (Cyrillic, e.g. "Утре во 4" — never the client's raw Latin).
 *  - vague.time / vague.time.owner — a day or vague window was given but no
 *    exact hour. Every variant re-asks the EXACT HOUR («во колку часот»):
 *    client-facing and owner-facing wordings are separate keys with the same
 *    contract.
 *  - address.exact — the location-reveal protocol. Every variant names the
 *    truthfulness window in one of its documented forms: «два часа пред»,
 *    «денот на посетата», «денот на закажаното гледање», «на самиот ден» or
 *    «непосредно пред» — a random roll that serves a phrase outside the
 *    family must still answer the client's meeting-spot question honestly.
 *  - owner.availability.ack.term / owner.availability.ack.noterm — the
 *    OWNER earned the first half of the compound ask («достапна е»); every
 *    variant confirms the AVAILABILITY (достапна/слободна), keeps the TERM as
 *    the open question and ends on it. The term form additionally asks whether
 *    the term SUITS him and invites another proposal — a variant that accepts
 *    the term on his behalf would close a deal he never agreed to (the [23:41]
 *    bug), so «одговара»/«во ред» + «друг предлог»/«друг термин» are required.
 *    The no-term form asks WHICH term (кој/кога) and nothing else.
 *  - discovery.waiver.ack — the client waived a size requirement
 *    («небитно»). Every variant ACKNOWLEDGES the waived criterion by naming
 *    it («големината …», «квадратура …») before the cards — a variant that
 *    acks nothing acknowledges nothing (the [21:40] flake served «Одлично,
 *    така има најмногу избор» in place of any size acknowledgement).
 */
export const POOL_CONTRACTS: Record<string, RegExp> = {
  'owner.availability.ack.term':
    /^(?=[\s\S]*(?:достапн|слободн))(?=[\s\S]*(?:одговара|во\s+ред))(?=[\s\S]*друг\s+(?:предлог|термин))(?=[\s\S]*\?\s*$)/iu,
  // The no-term form must ASK FOR THE TERM — by name («кој термин»), by day
  // («кој ден»), by clock («во колку часот») or by the wh-word («кога»). One
  // of them is the question; a variant with none of them confirms and stops.
  'owner.availability.ack.noterm':
    /^(?=[\s\S]*(?:достапн|слободн))(?=[\s\S]*(?:термин|кога|кој\s+ден|колку\s+часот))(?=[\s\S]*\?\s*$)/iu,
  'discovery.waiver.ack': /големин[аата]|квадратур/iu,
  // THE EMPTY-SEARCH PAIRS. Both forms say the SAME two things — nothing fits
  // the criteria HERE — and then offer a way out (keep the criteria for later,
  // or look in another part of town). The place form is the one that names the
  // landmark the client used; the district form names the area. A learned
  // variant that drops the offer reads as a dead end, and one that promises
  // stock is worse, so both are checked on every serve.
  'exhausted.location': /^(?=[\s\S]*(?:исцрпивме|исцрпени|исцрпани|немаме|нема повеќе|прикажавме|прегледавме|погледнавме|изгледавме|искористивме|искористени|поминавме|покажавме|изложивме|изложени|разгледавме))(?=[\s\S]*(?:друга населба|друг дел од градот|друга локаци|други населби|некаде на друго место))(?=[\s\S]*(?:забележам|запишам|зачувам|сочувам|евидентирам|регистрирам|контактирам|известам|бележам))/iu,
  'exhausted.place': /^(?=[\s\S]*(?:исцрпивме|исцрпени|исцрпани|немаме|нема повеќе|прикажавме|прикажан\p{L}*|прегледавме|погледнавме|изгледавме|искористивме|искористени|поминавме|покажавме|изложивме|изложени|разгледавме))(?=[\s\S]*(?:друга населба|друг дел од градот|друга локаци|други населби|некаде на друго место))(?=[\s\S]*(?:забележам|запишам|зачувам|сочувам|евидентирам|регистрирам|контактирам|известам|бележам))/iu,
  'no.match.location': /^(?=[\s\S]*(?:немам|нема|не располагам|ги немам|не содржи))(?=[\s\S]*(?:друг\p{L}*[^.!?]{0,20}(?:локаци|населб|делови од градот)|пошироко))/iu,
  'no.match.place': /^(?=[\s\S]*(?:немам|нема|не располагам|ги немам|не содржи))(?=[\s\S]*(?:друг\p{L}*[^.!?]{0,20}(?:локаци|населб|делови од градот)|пошироко))/iu,
  'owner.relay:counter.bare': /друг/iu,
  'vague.time': /колку/iu,
  'vague.time.owner': /колку/iu,
  'address.exact':
    / два часа пред |(?<![A-Za-z\u0400-\u04FF])ден(?:о)?(?:т)?\s*на\s*(?:посет|закажаното\s*гледање)|(?<![A-Za-z\u0400-\u04FF])на\s*самиот\s*ден|(?<![A-Za-z\u0400-\u04FF])непосредно\s*пред/iu,
};

/** Does a SERVED text satisfy the contract of its pool key? Unknown keys
 *  (or empty text) have nothing to assert — returns true. */
export function matchesPoolContract(key: string, text: string | undefined): boolean {
  const re = POOL_CONTRACTS[key];
  if (!re || !text) return true;
  return re.test(text);
}

/** Data-level check: which variants of a pool violate its contract? Empty for
 *  a healthy pool (or keys with no contract). Seed layer only — learned
 *  variants are runtime data, and the served-text check above covers them. */
export function poolContractViolations(key: string): string[] {
  const re = POOL_CONTRACTS[key];
  if (!re) return [];
  // BOTH seed layers: a documented contract must cover the hand-written policy
  // pools too — those are the frozen ones an operator cannot reword by accident.
  return seedVariants(key).filter(v => !re.test(v));
}

/** Pick a variant for a bank key, or undefined when the key has no variants yet.
 *  Layered: seed (responses.ts) + learned (SQLite bank_variants). Learned
 *  variants are LIVE without rebuild; the seed layer is the boot fallback if
 *  the DB is corrupted. Repeat avoidance spans BOTH layers. */
export function pickVariant(key: string, opts: PickOpts = {}): string | undefined {
  const seed = seedVariants(key);
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
  // COMPARE THE FILLED TEXT, NOT THE TEMPLATE. `recent` holds what was SERVED
  // («недвижноста (Евидентен број 54) е достапна», «Во Центар…»), while the
  // template still carries {prop}/{term}/{location} — so comparing templates
  // matched nothing and repeat avoidance was silently DEAD for every pool with
  // a placeholder. The owner pane served the same availability ack twice in a
  // row because of it. fillVars is pure (and idempotent for the „на Водно“
  // rewrite), so filling the candidates costs nothing.
  const served = variants.map(v => ({ ...v, text: fillVars(v.text, opts.vars) }));
  // THE CONTRACT IS ENFORCED AT SERVE TIME, not just in the tests: a documented
  // pool's variants rotate and LEARNED rows join them live, so a variant that
  // drops the pool's one meaning (e.g. the availability ack's open term
  // question) must never reach the screen. A pool whose every variant violates
  // its contract is a data bug, not a reason to serve nothing — fall back to
  // the whole pool and let the audits report it.
  const contract = POOL_CONTRACTS[key];
  const onContract = contract ? served.filter(v => contract.test(v.text)) : served;
  const candidates = onContract.length > 0 ? onContract : served;
  const fresh = candidates.filter(v => !recent.has(normalizeVariant(v.text)));
  const pool = fresh.length > 0 ? fresh : candidates;
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  learned?.metric(key, true, chosen.layer);
  return chosen.text;
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
 *
 * The PLACE form exists for the same reason the drained line has one: a search
 * anchored on a place («кај Бисер», «околу Диамонд Мол») derives a district, and
 * «Во Центар немам ништо…» answers about geography the client never named. The
 * place outranks the district whenever the search is anchored on one.
 */
export function noMatchLine(
  location: string | undefined,
  recent: string[] = [],
  place?: string,
): string | undefined {
  if (place) {
    const named = pickVariant('no.match.place', { recent, vars: { place } });
    if (named) return named;
  }
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
 *
 * A PLACE THE CLIENT NAMED OUTRANKS THE DISTRICT (the [21:46] capture): after a
 * search moved onto «Дајмонд Мол», the drained line said «Во Центар веќе ги
 * погледнавме сите недвижности» — a district he never asked about, while the
 * mall was the thing he had just named. The place form fills {place} and is
 * preferred whenever the search is anchored on a real place.
 */
export function exhaustedLine(
  location: string | undefined,
  recent: string[] = [],
  place?: string,
): string | undefined {
  if (place) {
    const named = pickVariant('exhausted.place', { recent, vars: { place } });
    if (named) return named;
  }
  return location
    ? pickVariant('exhausted.location', { recent, vars: { location } })
    : pickVariant('exhausted.plain', { recent });
}
