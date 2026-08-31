/**
 * Macedonian Grammar-Based Pattern Matching
 *
 * Instead of hand-enumerating every word order (which always lags real speech),
 * this module defines **word classes** (arrays of synonyms) and builds a single
 * regex from **slot permutations** — the same approach as phrases.ts but for
 * the intent detectors (availability, visit interest, seen property).
 *
 * Key Macedonian grammar facts exploited here:
 *
 *   1. CLITIC PLACEMENT — clitic pronouns (го, ја) attach to the verb but
 *      can appear BEFORE (proclitic: "го имате") or AFTER (enclitic:
 *      "имате го").  With ли the clitic floats: "имате ли го".
 *
 *   2. TIME-ADVERB MOBILITY — time words (уште, сеуште, веќе) are movable:
 *      "уште го имате" / "го уште имате" / "го имате уште".
 *
 *   3. ли PLACEMENT — the question particle ли can sit after the verb
 *      ("имате ли"), after the time adverb ("уште ли"), or after the
 *      clitic ("го ли").
 *
 *   4. дали OPTIONAL — the explicit question marker дали/dali is optional
 *      in casual speech: "дали уште го имате?" vs "уште го имате?".
 *
 *   5. PERSON FLEXIBILITY — 1st ("имам"), 2nd ("имаш/имате"), 3rd ("има")
 *      person forms are all valid in colloquial questions.
 *
 * Usage:
 *   import { buildAvailabilitySlots, buildVisitSlots, buildSeenSlots } from './grammar';
 *   const re = buildAvailabilitySlots();
 *   re.test('дали уште го имате?');      // true
 *   re.test('го уште имате?');            // true (reversed clitic)
 *   re.test('имате ли го уште?');         // true (reversed + ли)
 *   re.test('уште ли го имате?');         // true (time + ли)
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a non-capturing alternation: (?:a|b|c) */
function or(words: string[]): string {
  return '(?:' + words.join('|') + ')';
}

/** Optional non-capturing group: (?:…)? */
function opt(group: string): string {
  return '(?:' + group + ')?';
}

/** Required whitespace separator */
const WS = '\\s+';
/** Optional whitespace (may include punctuation like ?) */
const GAP = '[^.!?\\n]{0,40}';

// ── Word Classes ──────────────────────────────────────────────────────────────
// Each class groups synonyms that can appear in the same grammatical slot.
// Latin entries are for direct Latin input; the caller also wraps the final
// regex in matchesBoth() so normalizeMc covers Latin→Cyrillic too.

// ── Availability ──────────────────────────────────────────────────────────────

/** Time adverbs — "still" / "already" */
const AVAIL_TIME = ['уште', 'сеуште', 'веќе'];
const AVAIL_TIME_L = ['uste', 'seuste', 'veke'];

/** Clitic pronouns — "it" (masc/fem) */
const AVAIL_CLITIC = ['го', 'ја'];
const AVAIL_CLITIC_L = ['go', 'ja'];

/** Question marker — "whether" / "if" */
const AVAIL_Q = ['дали'];
const AVAIL_Q_L = ['dali'];

/** Question particle — fronted to第二个slot after time adverb or verb */
const AVAIL_LI = ['ли'];
const AVAIL_LI_L = ['li'];

/** Possession verb — "you have" / "has" (2nd sg, 2nd pl, 3rd) */
const AVAIL_HAVE = ['имате', 'имаш', 'има'];
const AVAIL_HAVE_L = ['imate', 'imas', 'ima'];

/** Availability adjectives — after "е" copula */
const AVAIL_ADJ = [
  'достапен', 'достапна', 'достапно',
  'остапен', 'остапна',
  'слободен', 'слободна', 'слободно',
  'продаден', 'продадена',
  'издаден', 'издадена',
  'на продажба', 'на prodazba',
];
const AVAIL_ADJ_L = [
  'dostapen', 'dostapna', 'dostapno',
  'ostapen', 'ostapna',
  'sloboden', 'slobodna', 'slobodno',
  'prodaden', 'prodadena',
  'izdaden', 'izdadena',
];

// ── Visit Interest ────────────────────────────────────────────────────────────

/** Time question word — "when" */
const VISIT_WHEN = ['кога'];
const VISIT_WHEN_L = ['koga'];

/** Modal — "can" / "could" */
const VISIT_MODAL = ['може', 'би можело', 'би можела', 'можело', 'можела'];
const VISIT_MODAL_L = ['moze', 'bi mozelo', 'bi mozela', 'mozelo', 'mozela'];

/** Desire — "I want" / "I would like" */
const VISIT_WANT = ['сакам', 'би сакал', 'би сакала', 'посакувам'];
const VISIT_WANT_L = ['sakam', 'bi sakoal', 'bi sakoala', 'posakuvam'];

/** Seeing verb — "see" / "view" / "visit" (1st person, impersonal, gerund) */
const VISIT_SEE = ['погледн', 'видам', 'види', 'погледање', 'разгледам', 'посета'];
const VISIT_SEE_L = ['pogledn', 'vidam', 'vidi', 'pogledanje', 'razgledam', 'poseta'];

/** Command verb — "schedule" / "arrange" */
const VISIT_CMD = ['закажи', 'договори', 'организира'];
const VISIT_CMD_L = ['zakazi', 'dogovori', 'organiziraj'];

// ── Seen Property ─────────────────────────────────────────────────────────────

/** Past-tense "saw" — 1st person */
const SEEN_SAW = ['гледав', 'видов', 'видев'];
const SEEN_SAW_L = ['gledav', 'vidov', 'videv'];

/** Object nouns — "ad" / "apartment" / "property" (including definite forms) */
const SEEN_OBJ = ['оглас', 'огласот', 'стан', 'станот', 'имот', 'имотот'];
const SEEN_OBJ_L = ['oglas', 'oglasot', 'stan', 'stanot', 'imot', 'imotot'];

/** Online source — "on the internet" */
const SEEN_ONLINE = ['на интерннет', 'на интернет'];
const SEEN_ONLINE_L = ['na internet'];

// ══════════════════════════════════════════════════════════════════════════════
//  SLOT-BUILDERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build a slot-based regex for AVAILABILITY questions.
 *
 * Grammar slots (flexible order):
 *   Q?  TIME  CLITIC?  HAVE           — "дали уште го имате?"
 *   Q?  CLITIC  TIME?  HAVE           — "го уште имате?"
 *   Q?  HAVE  CLITIC?  TIME?          — "имате го уште?"
 *   Q?  TIME  LI  CLITIC?  HAVE       — "уште ли го имате?"
 *   Q?  HAVE  LI  CLITIC?  TIME?      — "имате ли го уште?"
 *   Q?  CLITIC  LI  TIME?  HAVE       — "го ли уште имате?"
 *   Q?  TIME  CLITIC?  (е|е ли)  ADJ  — "дали уште е достапен?"
 *   Q?  ADJ  (е|е ли)  TIME?          — "достапен е ли уште?"
 *   …plus the original hand-written patterns (go imate uste, daa?[il]…, etc.)
 */
export function buildAvailabilitySlots(): RegExp {
  const Q  = or([...AVAIL_Q, ...AVAIL_Q_L]);
  const T  = or([...AVAIL_TIME, ...AVAIL_TIME_L]);
  const C  = or([...AVAIL_CLITIC, ...AVAIL_CLITIC_L]);
  const LI = or([...AVAIL_LI, ...AVAIL_LI_L]);
  const H  = or([...AVAIL_HAVE, ...AVAIL_HAVE_L]);
  const A  = or([...AVAIL_ADJ, ...AVAIL_ADJ_L]);
  const COPULA = '(?:е|е\\s+ли|e|e\\s+li)';

  const s = (base: string) => base; // passthrough — no template literal \s issue

  const patterns = [
    // ── Possession patterns (go/imate family) ──────────────────────────────
    // Slot: Q? TIME CLITIC? HAVE
    s(`${Q}?${WS}${T}(?:${WS}${C})?${WS}${H}`),
    // Slot: Q? CLITIC TIME? HAVE
    s(`${Q}?${WS}${C}(?:${WS}${T})?${WS}${H}`),
    // Slot: (Q|TIME|CLITIC) HAVE CLITIC? TIME? — bare HAVE is too loose
    // ("imas" matches inside "STO IMAS VO KARPOS"); require at least Q, TIME,
    // or CLITIC so the slot only fires for genuine availability questions.
    s(`(?:${Q}|${T}|${C})${WS}${H}(?:${WS}${C})?(?:${WS}${T})?`),
    // Slot: Q? TIME LI CLITIC? HAVE
    s(`${Q}?${WS}${T}${WS}${LI}(?:${WS}${C})?${WS}${H}`),
    // Slot: Q? HAVE LI CLITIC? TIME?
    s(`${Q}?${WS}${H}${WS}${LI}(?:${WS}${C})?(?:${WS}${T})?`),
    // Slot: Q? CLITIC LI TIME? HAVE
    s(`${Q}?${WS}${C}${WS}${LI}(?:${WS}${T})?${WS}${H}`),

    // ── Adjective copula patterns (достапен е) ─────────────────────────────
    // Slot: Q? TIME CLITIC? COPULA ADJ — "дали уште е достапен?"
    s(`${Q}?${WS}${T}(?:${WS}${C})?${WS}${COPULA}${WS}${A}`),
    // Slot: Q? ADJ COPULA TIME? — "дали достапен е уште?"
    s(`${Q}?${WS}${A}${WS}${COPULA}(?:${WS}${T})?`),
    // Slot: Q? COPULA ADJ — "дали е достапен?" (simple copula+adj)
    s(`${Q}?${WS}${COPULA}${WS}${A}`),
    // Slot: TIME LI COPULA ADJ — "сеуште ли е достапен?"
    s(`${T}${WS}${LI}${WS}${COPULA}${WS}${A}`),
    // Slot: COPULA LI ADJ — "е ли слободен?" (fronted copula)
    s(`${COPULA}${WS}${LI}${WS}${A}`),
    // Slot: HAVE CLITIC TIME — "имате го уште?" (enclitic + time)
    s(`${H}${WS}${C}${WS}${T}`),

    // ── Original hand-written patterns (kept for backward compat) ───────────
    // "го имате уште" / "ја имате уште" (direct from old regex)
    s(`(?:го|ја)${WS}имате${WS}(?:ли${WS})?(?:уште|сеуште)`),
    s(`(?:go|ja)${WS}imate${WS}(?:li${WS})?(?:uste|seuste)`),
    // "dali ... dostapen" / "dali ... prodaden" (Latin catch-all)
    `daa?[il][il]${GAP}(?:dostapen|dostapna|dostapno|ostapen|ostapna|sloboden|slobodna|slobodno|prodaden|prodadena|izdaden|izdadena|na prodazba|postoi|go imate uste|ja imate uste|za prodavanje|za prodazba|na prodazba|se prodava|prodavate|prodava li)`,
    // "остапен ли е" / "остапна ли е" (contracted forms)
    'остапен\\s+ли\\s+е|остапна\\s+ли\\s+е|ostapen\\s+li\\s+e|ostapna\\s+li\\s+e',
    // "на продажба ли е" / "се продава ли"
    'на\\s+продажба\\s+ли\\s+е|се\\s+продава\\s+ли|продава\\s+ли\\s+е|на\\s+prodazba\\s+li\\s+e|se\\s+prodava\\s+li|prodava\\s+li\\s+e|za\\s+prodazba\\s+li\\s+e',
  ];

  return new RegExp('(?:' + patterns.join('|') + ')', 'iu');
}

/**
 * Build a slot-based regex for VISIT INTEREST patterns.
 *
 * Grammar slots:
 *   WHEN  MODAL  GAP?  SEE           — "кога може да се види?"
 *   WANT  GAP?  SEE                  — "сакам да го видам"
 *   SEE   WHEN?  MODAL?              — "да видам кога може?"
 *   CMD   (ли)?  (посета)?           — "закажи ми посета"
 *   WANT  GAP?  посета               — "сакам посета"
 *   дали  GAP?  достапен            — (overlap with availability, kept for compat)
 */
export function buildVisitSlots(): RegExp {
  const WHEN = or([...VISIT_WHEN, ...VISIT_WHEN_L]);
  const MODAL = or([...VISIT_MODAL, ...VISIT_MODAL_L]);
  const WANT = or([...VISIT_WANT, ...VISIT_WANT_L]);
  const SEE  = or([...VISIT_SEE, ...VISIT_SEE_L]);
  const CMD  = or([...VISIT_CMD, ...VISIT_CMD_L]);
  // CMD with word-boundary guards: "договори" must not be a prefix of
  // "договориме" / "договор за" etc. — same assertion as the original regex.
  const CMDB = '(?<![\\p{L}\\p{N}])' + CMD + '(?![\\p{L}\\p{N}])';
  const GAPVISIT = '[^.!?\\n]{0,25}';

  const s = (base: string) => base;

  const patterns = [
    // Slot: WHEN MODAL GAP? SEE — "кога може да се види?"
    s(`${WHEN}${WS}${MODAL}${GAPVISIT}${SEE}`),
    // Slot: WANT GAP? SEE — "сакам да го видам"
    s(`${WANT}${GAP}${SEE}`),
    // Slot: SEE WHEN? MODAL? — "да видам кога може?"
    s(`${SEE}(?:${WS}${WHEN})?(?:${WS}${MODAL})?`),
    // Slot: CMD LI? посета? — "закажи ми посета"
    s(`${CMDB}(?:\\s+(?:ј|јте|te|и|е))?(?:${WS}(?:посета|poseta))?`),
    // Slot: WANT GAP? посета — "сакам посета"
    s(`${WANT}${GAP}(?:посета|poseta)`),
    // "организира(ј|јте)? посета"
    'организира(?:ј|јте)?(?:\\s+посета)?|organiziraj(?:te)?(?:\\s+poseta)?',
    // "закаж(и|е)(те)? посета"
    'закаж(?:и|е)(?:те)?(?:\\s+посета)?|zakaz(?:e|i)(?:te)?(?:\\s+poseta)?',
    // "договори ми ја/го"
    '(?<![\\p{L}\\p{N}])(?:договори|dogovori)(?![\\p{L}\\p{N}])(?:\\s+ми(?:\\s+(?:ја|го))?)?',
    // "закажи ми"
    '(?<![\\p{L}\\p{N}])(?:закажи|zakazi)(?![\\p{L}\\p{N}])(?:\\s+ми)?',
    // "ја посакувам посета"
    s('ја' + WS + 'посакувам' + WS + 'посета|ja' + WS + 'posakuvam' + WS + 'poseta'),
  ];

  return new RegExp('(?:' + patterns.join('|') + ')', 'iu');
}

/**
 * Build a slot-based regex for SEEN PROPERTY patterns.
 *
 * Grammar slots:
 *   CLITIC  SAW                    — "го гледав" (object-first, proclitic)
 *   SAW  OBJ                      — "гледав оглас" (verb-first)
 *   OBJ  SAW                      — "оглас гледав" (object-first, no clitic)
 *   OBJ  CLITIC  SAW              — "огласот го гледав" (full reversal)
 *   SAW  GAP?  online             — "гледав на интернет"
 *   OBJ  CLITIC  SAW  GAP?  online — "огласот го гледав на интернет"
 */
export function buildSeenSlots(): RegExp {
  const CL = or([...AVAIL_CLITIC, ...AVAIL_CLITIC_L]); // reuse го/go, ја/ja
  const SAW = or([...SEEN_SAW, ...SEEN_SAW_L]);
  const OBJ = or([...SEEN_OBJ, ...SEEN_OBJ_L]);
  const ONL = or([...SEEN_ONLINE, ...SEEN_ONLINE_L]);
  const GAPSEEN = '[^.!?\\n]{0,30}';

  const s = (base: string) => base;

  const patterns = [
    // Slot: CLITIC SAW — "го гледав"
    s(`${CL}${WS}${SAW}`),
    // Slot: SAW OBJ — "гледав оглас"
    s(`${SAW}${WS}${OBJ}`),
    // Slot: OBJ SAW — "оглас гледав" (reversed, no clitic)
    s(`${OBJ}${WS}${SAW}`),
    // Slot: OBJ CLITIC SAW — "огласот го гледав" (full reversal)
    s(`${OBJ}${WS}${CL}${WS}${SAW}`),
    // Slot: SAW GAP? online — "гледав на интернет"
    s(`${SAW}${GAPSEEN}${ONL}`),
    // Slot: OBJ CLITIC SAW GAP? online — "огласот го гледав на интернет"
    s(`${OBJ}${WS}${CL}${WS}${SAW}${GAPSEEN}${ONL}`),
    // Original: тој конкретен стан / конкретниот стан
    'тој\\s+конкретен\\s+стан|конкретниот\\s+стан',
    // Original: кој стан беше / која е таа/ова
    'кој\\s+стан\\s+беше|која\\s+(?:е|беше)\\s+(?:таа|ова)',
    // Original: може да ми кажете кој / кој е тој стан
    'може\\s+да\\s+ми\\s+кажете\\s+кој|кој\\s+е\\s+тој\\s+стан',
    // Latin: toj konkreten stan / konkretniot stan / koj stan bese
    'toj\\s+konkreten\\s+stan|konkretniot\\s+stan|koj\\s+stan\\s+bese',
    'koja\\s+(?:e|bese)\\s+(?:taa|ova)|moze\\s+da\\s+mi\\s+kazete\\s+koj|koj\\s+e\\s+toj\\s+stan',
  ];

  return new RegExp('(?:' + patterns.join('|') + ')', 'iu');
}

// ══════════════════════════════════════════════════════════════════════════════
//  SAMPLE PHRASES (for testing)
// ══════════════════════════════════════════════════════════════════════════════

export function sampleAvailabilityPhrases(): string[] {
  return [
    // ── Standard word order ──
    'дали уште го имате?',
    'dali uste go imate?',
    'дали е достапен?',
    'dali e dostapen?',
    'го имате ли уште?',
    'go imate li uste?',
    'сеуште ли е на продажба?',
    'е ли слободен?',
    // ── Reversed clitic ──
    'го уште имате?',
    'имате го уште?',
    'ja uste imate?',
    'imate ja uste?',
    // ── Time + ли ──
    'уште ли го имате?',
    'uste li go imate?',
    'сеуште ли е достапен?',
    'veke li go imate?',
    // ── Without дали ──
    'уште го имате?',
    'uste go imate?',
    'го имате уште?',
    'go imate uste?',
    // ── ALL CAPS (Viber typing) ──
    'ME INTERESIRA DALI USTE GO IMATE 79',
    'DALL USTE GO IMATE?',
    'ДАЛИ УШТЕ ГО ИМАТЕ?',
    'ГО УШТЕ ИМАТЕ?',
    // ── With number ──
    'дали е достапен 82?',
    'dali e dostapen 82?',
    'го имате уште 78?',
  ];
}

export function sampleVisitPhrases(): string[] {
  return [
    // ── Standard ──
    'кога може да се види?',
    'koga moze da se pogledne?',
    'сакам да го видам',
    'sakam da go vidam',
    'организирај посета',
    'organiziraj poseta',
    'закажи ми посета',
    'zakazi mi poseta',
    // ── Reversed / flex ──
    'да видам кога може?',
    'da vidam koga moze?',
    'посета кога може?',
    'poseta koga moze?',
    'кога би можело погледање?',
    'bi sakoal da posetam',
    'да се види кога може?',
    'jа посакувам посета',
    // ── Command forms ──
    'договори ми ја посетата',
    'dogovori mi ja posetata',
    'закажи',
    'zakazi',
  ];
}

export function sampleSeenPhrases(): string[] {
  return [
    // ── Standard ──
    'го гледав',
    'go gledav',
    'гледав оглас',
    'gledav oglas',
    'на интернет го гледав',
    'na internet go gledav',
    // ── Reversed ──
    'огласот го гледав',
    'oglasot go gledav',
    'станот видов',
    'stanot vidov',
    'ovoj stan gledav',
    'oglas gledav',
    // ── Edge cases ──
    'го видев тој конкретен стан',
    'кој стан беше?',
    'може да ми кажете кој',
  ];
}
