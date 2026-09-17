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

/** Build a non-capturing alternation: (?:a|b|c)
 *  Every word class is boundary-guarded with Unicode lookarounds. JS \b is
 *  ASCII-only (never binds around Cyrillic), and unguarded classes match
 *  SUBSTRINGS inside longer words: "lokaciJA IMA" → ja+ima (clitic+have →
 *  the 22:05 "DOBRA LOKACIJA IMA" availability ack), "ima LI ft" → li inside
 *  "lift". A clitic/pronoun/verb is a whole word — matching its letters
 *  inside another word is always wrong. */
function or(words: string[]): string {
  return '(?<![\\p{L}\\p{N}])(?:' + words.join('|') + ')(?![\\p{L}\\p{N}])';
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
const VISIT_CMD = ['закажи', 'договори', 'организирај', 'организирајте'];
const VISIT_CMD_L = ['zakazi', 'dogovori', 'organiziraj', 'organizirajte'];
// NOTE: bare "организира" is deliberately NOT a command — it is 3rd person
// ("агенцијата организира превоз", "Метрополис организира посета") and its
// tail slot `(?:\s+посета)?` is OPTIONAL, so a bare 3rd-person verb would
// claim every such sentence as visit interest. Only the imperative
// (организирај/организирајте) is a command; "организира посета" as a request
// is covered by the dedicated imperative+object tail in the patterns list.

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

// ── Size Waived (bedrooms don't matter) ──────────────────────────────────────
// Client says size/rooms don't matter — used to skip bedrooms question.
// Patterns: “goleminata ne mi e bitna“, “не ми се битни спални“,
//           “било колку соби“, “не важно“, “size doesn't matter“
const SIZE_WAIVED_NEG = ['не', 'ne'];
// Object nouns — “големината“ / “димензиите“ / “квадратурата“
const SIZE_WAIVED_OBJ = ['големината', 'димензиите', 'квадратурата', 'површината', 'собите', 'спалните'];
const SIZE_WAIVED_OBJ_L = ['goleminata', 'dimenziite', 'kvadraturata', 'povrsinata', 'sobite', 'spalnite'];
const SIZE_WAIVED_SUBJ = ['ми', 'ни'];
const SIZE_WAIVED_SUBJ_L = ['mi', 'ni'];
const SIZE_WAIVED_BE = ['е'];
const SIZE_WAIVED_BE_L = ['e'];
const SIZE_WAIVED_ADJ = ['битна', 'битно', 'важна', 'важно', 'битен'];
const SIZE_WAIVED_ADJ_L = ['bitna', 'bitno', 'vazhna', 'vazhno', 'biten'];
// “bilo kolku / bilo kakvi“ — any number
const SIZE_WAIVED_ANY = ['било колку', 'било какви', 'било каков', 'било колку соби', 'било колку спални'];
const SIZE_WAIVED_ANY_L = ['bilo kolku', 'bilo kakvi', 'bilo kakov', 'bilo kolku sobi', 'bilo kolku spalni'];
// “nebitni se spalnite“ — the NEGATED ADJECTIVE as ONE token (ne+bitni fused),
// with the DEFINITE noun form (spalnite). The 13:53 transcript: the bedrooms
// ask repeated because the slot list only knew “ne mi se bitni spalni“.
const SIZE_WAIVED_NEADJ = ['небитни', 'небитно', 'небитна', 'небитен', 'неважни', 'неважно', 'неважна'];
const SIZE_WAIVED_NEADJ_L = ['nebitni', 'nebitno', 'nebitna', 'nebiten', 'nevazhni', 'nevazno', 'nevazna', 'nevazni'];
const SIZE_WAIVED_NOUN_DEF = ['спалните', 'собите'];
const SIZE_WAIVED_NOUN_DEF_L = ['spalnite', 'sobite'];
// English size doesn't matter
const SIZE_WAIVED_EN = ["size doesn't matter", "size does not matter", "any size", "no preference"];

// ── Price Priority (cheapest first) ──────────────────────────────────────────
// Client says cheapest is priority — used to sort by price.
// Patterns: “што поевтино“, “нajeftino“, “најниска цена“,
//           “поевтино“, “онаму каде е поевтино“
const PRICE_PRI_ADJ = ['поевтино', 'поевтина', 'поевтин', 'поефтино', 'поефтина', 'поефтин', 'пониско', 'ниско', 'ниска'];
// Latin real-world misspellings of “поевтино” seen in chat: the ф→т slip
// (poeftino) and the ф→к slip (poektino — the 21:39 transcript). "poftino"
// (dropped vowel) rounds out the family. These MUST match in every
// cheaper-ask detector or the closed funnel swallows the intent.
const PRICE_PRI_ADJ_L = ['poevtino', 'poevtina', 'poevtin', 'poeftino', 'poeftina', 'poeftin', 'poektino', 'poektina', 'poektin', 'poftino', 'poftina', 'poftin', 'pojeftino', 'pojeftina', 'pojeftin', 'ponisko', 'nisko', 'niska'];
const PRICE_PRI_SUP = ['најевтино', 'најевтина', 'најевтин', 'нajeftino', 'најниско', 'нajевтин'];
const PRICE_PRI_SUP_L = ['najeftino', 'najeftina', 'najeftin', 'najnisko', 'najevtin'];
const PRICE_PRI_PHRASE = ['што поевтино', 'колку поевтино', 'што пониско', 'колку пониско'];
const PRICE_PRI_PHRASE_L = ['sto poeftino', 'kolku poeftino', 'sto ponisko', 'kolku ponisko'];
// Bare cheaper-word — “daj nesto poeftino vo toj reon” (the 21:39 transcript).
// A standalone cheaper-word with NO verb slot around it is still a cheaper
// search: “дај нешто поевтино” has nothing after the adjective for the ADJ+verb
// slot to bind. Only unambiguous price words — “ниско/ниска” are excluded
// because bare “ниска градба” (low-rise) is about construction, not price.
// Misspelling family (real chat traffic): ф→т (poeftino), ф→к (poektino —
// the 21:39 transcript), dropped vowel (poftino), й-insertion (pojeftino).
const PRICE_PRI_BARE = ['поевтино', 'поевтина', 'поефтино', 'поефтина', 'најевтино', 'најевтина', 'појефтино', 'појефтина'];
const PRICE_PRI_BARE_L = ['poevtino', 'poevtina', 'poeftino', 'poeftina', 'poektino', 'poektina', 'poftino', 'poftina', 'pojeftino', 'pojeftina', 'najeftino', 'najeftina'];
// “najevtino shto ima“ / “the cheapest you have“
const PRICE_PRI_EN = ['cheapest', 'most affordable', 'lowest price', 'cheapest you have'];

// ── Flexible Location (near centre / anywhere) ────────────────────────────────
// Client says location is flexible — used to widen search.
// Patterns: “било каде“, “блиску до центар“, “околу центар“
const FLEX_LOC_ANY = ['било каде', 'секаде', 'каде било'];
const FLEX_LOC_ANY_L = ['bilo kade', 'sekade', 'kade bilo'];
const FLEX_LOC_NEAR = ['блиску до', 'околу', 'во близина на', 'кај'];
const FLEX_LOC_NEAR_L = ['blisku do', 'okolu', 'vo blizina na', 'kaj'];

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
    s(`(${Q})?${WS}${T}(?:${WS}${C})?${WS}${H}`),
    // Slot: Q? CLITIC TIME? HAVE
    s(`(${Q})?${WS}${C}(?:${WS}${T})?${WS}${H}`),
    // Slot: (Q|TIME|CLITIC) HAVE CLITIC? TIME? — bare HAVE is too loose
    // ("imas" matches inside "STO IMAS VO KARPOS"); require at least Q, TIME,
    // or CLITIC so the slot only fires for genuine availability questions.
    s(`(?:${Q}|${T}|${C})${WS}${H}(?:${WS}${C})?(?:${WS}${T})?`),
    // Slot: Q? TIME LI CLITIC? HAVE
    s(`(${Q})?${WS}${T}${WS}${LI}(?:${WS}${C})?${WS}${H}`),
    // Slot: Q? HAVE LI CLITIC? TIME?
    s(`(${Q})?${WS}${H}${WS}${LI}(?:${WS}${C})?(?:${WS}${T})?`),
    // Slot: Q? CLITIC LI TIME? HAVE
    s(`(${Q})?${WS}${C}${WS}${LI}(?:${WS}${T})?${WS}${H}`),

    // ── Adjective copula patterns (достапен е) ─────────────────────────────
    // Slot: Q? TIME CLITIC? COPULA ADJ — "дали уште е достапен?"
    s(`(${Q})?${WS}${T}(?:${WS}${C})?${WS}${COPULA}${WS}${A}`),
    // Slot: Q? ADJ COPULA TIME? — "дали достапен е уште?"
    s(`(${Q})?${WS}${A}${WS}${COPULA}(?:${WS}${T})?`),
    // Slot: Q? COPULA ADJ — "дали е достапен?" (simple copula+adj)
    s(`(${Q})?${WS}${COPULA}${WS}${A}`),
    // Slot: TIME LI COPULA ADJ — "сеуште ли е достапен?"
    s(`${T}${WS}${LI}${WS}${COPULA}${WS}${A}`),
    // Slot: COPULA LI ADJ — "е ли слободен?" (fronted copula)
    s(`${COPULA}${WS}${LI}${WS}${A}`),
    // Slot: HAVE CLITIC TIME — "имате го уште?" (enclitic + time)
    s(`${H}${WS}${C}${WS}${T}`),

    // ── Original hand-written patterns (kept for backward compat) ───────────
    // Every tail below carries the Unicode boundary guard: a bare word stem
    // matching INSIDE another word is the lokaciJA-class bug. Verified cases:
    //   "постапен ли е" ⊃ остапен, "препродава ли е" ⊃ продава,
    //   "dali ima postojan parking" ⊃ postoi (a FEATURE question, not availability).
    // "го имате уште" / "ја имате уште" (direct from old regex)
    s(`(?<![\\p{L}\\p{N}])(?:го|ја)${WS}имате${WS}(?:ли${WS})?(?:уште|сеуште)(?![\\p{L}\\p{N}])`),
    s(`(?<![\\p{L}\\p{N}])(?:go|ja)${WS}imate${WS}(?:li${WS})?(?:uste|seuste)(?![\\p{L}\\p{N}])`),
    // "dali ... dostapen" / "dali ... prodaden" (Latin catch-all) — the keyword
    // list is boundary-guarded on BOTH sides: unguarded, "postoi" fires inside
    // "postojan" ("dali ima postojan parking?" read as an availability ask).
    `daa?[il][il]${GAP}(?<![\\p{L}\\p{N}])(?:dostapen|dostapna|dostapno|ostapen|ostapna|sloboden|slobodna|slobodno|prodaden|prodadena|izdaden|izdadena|na prodazba|postoi|go imate uste|ja imate uste|za prodavanje|za prodazba|na prodazba|se prodava|prodavate|prodava li)(?![\\p{L}\\p{N}])`,
    // "остапен ли е" / "остапна ли е" (contracted forms) — "остапен" is a
    // substring of "постапен" (procedural speech!) — left guard required.
    '(?<![\\p{L}\\p{N}])(?:остапен\\s+ли\\s+е|остапна\\s+ли\\s+е|ostapen\\s+li\\s+e|ostapna\\s+li\\s+e)(?![\\p{L}\\p{N}])',
    // "на продажба ли е" / "се продава ли" — "продава" is a substring of
    // "препродава" — left guard required.
    '(?<![\\p{L}\\p{N}])(?:на\\s+продажба\\s+ли\\s+е|се\\s+продава\\s+ли|продава\\s+ли\\s+е|на\\s+prodazba\\s+li\\s+e|se\\s+prodava\\s+li|prodava\\s+li\\s+e|za\\s+prodazba\\s+li\\s+e)(?![\\p{L}\\p{N}])',
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
    // Slot: WANT GAP? посета — "сакам посета" — guarded: "посета" is a prefix
    // of "посетители" ("сакам да нема многу посетители" ≠ visit interest).
    s(`${WANT}${GAP}(?<![\\p{L}\\p{N}])(?:посета|poseta)(?![\\p{L}\\p{N}])`),
    // "организира(ј|јте)? посета" — imperative/object REQUIRED for the bare
    // verb: "агенцијата организира превоз" (3rd person, object elsewhere)
    // must never read as visit interest.
    '(?<![\\p{L}\\p{N}])(?:организира(?:ј|јте|te)(?:\\s+посета)?|организира(?:\\s+посета)|organiziraj(?:te)?(?:\\s+poseta)?|organizira(?:\\s+poseta))(?![\\p{L}\\p{N}])',
    // "закаж(и|е)(те)? посета" — guarded: "zakaz" is a stem of "zakazan/
    // zakazuvam" ("terminot e zakazan" is a statement, not a request).
    '(?<![\\p{L}\\p{N}])(?:закаж(?:и|е)(?:те)?(?:\\s+посета)?|zakaz(?:e|i)(?:te)?(?:\\s+poseta)?)(?![\\p{L}\\p{N}])',
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
    // Original: тој конкретен стан / конкретниот стан — guarded: "тој" is a
    // suffix of "сетој/оној"-class words.
    '(?<![\\p{L}\\p{N}])(?:тој\\s+конкретен\\s+стан|конкретниот\\s+стан)',
    // Original: кој стан беше / која е таа/ова — guarded: "кој" is a suffix of
    // "секој" ("секој стан беше добро описан" ≠ seen-property).
    '(?<![\\p{L}\\p{N}])(?:кој\\s+стан\\s+беше|која\\s+(?:е|беше)\\s+(?:таа|ова))',
    // Original: може да ми кажете кој / кој е тој стан
    '(?<![\\p{L}\\p{N}])(?:може\\s+да\\s+ми\\s+кажете\\s+кој|кој\\s+е\\s+тој\\s+стан)',
    // Latin: toj konkreten stan / konkretniot stan / koj stan bese — same
    // guards ("svoj konkreten stan", "sekoj stan bese" must not fire).
    '(?<![\\p{L}\\p{N}])(?:toj\\s+konkreten\\s+stan|konkretniot\\s+stan|koj\\s+stan\\s+bese)',
    '(?<![\\p{L}\\p{N}])(?:koja\\s+(?:e|bese)\\s+(?:taa|ova)|moze\\s+da\\s+mi\\s+kazete\\s+koj|koj\\s+e\\s+toj\\s+stan)',
  ];

  return new RegExp('(?:' + patterns.join('|') + ')', 'iu');
}

// ══════════════════════════════════════════════════════════════════════════════
//  DISCOVERY PREFERENCE BUILDERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build a slot-based regex for SIZE WAIVED patterns.
 * Client says size/bedrooms don't matter.
 *
 * Grammar slots:
 *   OBJ  NEG  SUBJ  BE  ADJ       — “големината не ми е битна“
 *   NEG  SUBJ  BE  ADJ             — “не ми е битно“
 *   ANY                             — “било колку соби“
 *   EN                              — “size doesn't matter“
 *   NEG  important                  — “не ми се битни спални“
 */
export function buildSizeWaivedSlots(): RegExp {
  const NEG = or([...SIZE_WAIVED_NEG, ...SIZE_WAIVED_NEG]);
  const SUBJ = or([...SIZE_WAIVED_SUBJ, ...SIZE_WAIVED_SUBJ_L]);
  const BE = or([...SIZE_WAIVED_BE, ...SIZE_WAIVED_BE_L]);
  const ADJ = or([...SIZE_WAIVED_ADJ, ...SIZE_WAIVED_ADJ_L]);
  const ANY = or([...SIZE_WAIVED_ANY, ...SIZE_WAIVED_ANY_L]);
  const EN = or([...SIZE_WAIVED_EN]);
  // NEADJ = fused negated adjective (небитни/nebitni…), NOUNDEF = definite noun
  // (спалните/spalnite, собите/sobite) — the 13:53 “nebitni se spalnite“ forms.
  const NEADJ = or([...SIZE_WAIVED_NEADJ, ...SIZE_WAIVED_NEADJ_L]);
  const NOUNDEF = or([...SIZE_WAIVED_NOUN_DEF, ...SIZE_WAIVED_NOUN_DEF_L]);
  const s = (base: string) => base;

  const patterns = [
    // Slot: OBJ NEG SUBJ BE ADJ — “големината не ми е битна“
    s(`${or([...SIZE_WAIVED_OBJ, ...SIZE_WAIVED_OBJ_L])}${WS}${NEG}${WS}${SUBJ}${WS}${BE}${WS}${ADJ}`),
    // Slot: NEG SUBJ BE ADJ — “не ми е битно“
    s(`${NEG}${WS}${SUBJ}${WS}${BE}${WS}${ADJ}`),
    // Slot: ANY — “било колку соби“
    s(ANY),
    // Slot: EN — “size doesn't matter“
    s(EN),
    // Slot: NEADJ BE (SUBJ)? — “nebitni se spalnite“ / “небитни се спалните“
    // / bare “nebitni se“ / “nebitno e“ — order-free: the noun may sit before
    // or after, so both (NEADJ BE NOUNDEF?) and (NOUNDEF BE NEADJ) match.
    s(`${NEADJ}${WS}(?:се|se|е|e)(?:${WS}${NOUNDEF})?`),
    s(`${NOUNDEF}${WS}(?:се|се|se)${WS}${NEADJ}`),
    // NOUN-first with clitics anywhere: “spalnite nebitni se“,
    // “spalnite mi se nebitni“, “spalnite se nebitni“ — up to two clitic
    // tokens (subject/beat-verb) between the noun and the fused negative.
    s(`${NOUNDEF}${WS}(?:(?:${SUBJ}|се|se|е|e|и|i)${WS}){0,2}${NEADJ}(?:${WS}(?:се|se))?`),
    // “не ми се битни спални“ / “не ми се важни соби“
    s(`${NEG}${WS}${SUBJ}${WS}(?:се|се|се)${WS}(?:битни|важни|битни|важни|bitni|vazhni)${WS}(?:спални|соби|sobni|spalni)`),
    // “не ми требаат спални“ / “не ми требаат соби“
    s(`${NEG}${WS}${SUBJ}${WS}(?:требаат|треба|trebaat|treba)${WS}(?:спални|соби|spalni|sobni)`),
    // “goleminata ne mi e bitna“ (Latin)
    s(`goleminata${WS}ne${WS}mi${WS}e${WS}bitna`),
  ];

  return new RegExp('(?:' + patterns.join('|') + ')', 'iu');
}

/**
 * Build a slot-based regex for PRICE PRIORITY patterns.
 * Client says cheapest is the priority.
 *
 * Grammar slots:
 *   PHRASE                           — “што поевтино“
 *   BARE                             — “daj nesto poeftino vo toj reon“
 *   SUP                              — “нajeftino“
 *   ADJ  (that's/you have)           — “поевтино е“
 *   EN                              — “cheapest“
 */
export function buildPricePrioritySlots(): RegExp {
  const ADJ = or([...PRICE_PRI_ADJ, ...PRICE_PRI_ADJ_L]);
  const SUP = or([...PRICE_PRI_SUP, ...PRICE_PRI_SUP_L]);
  const PHRASE = or([...PRICE_PRI_PHRASE, ...PRICE_PRI_PHRASE_L]);
  const BARE = or([...PRICE_PRI_BARE, ...PRICE_PRI_BARE_L]);
  const EN = or([...PRICE_PRI_EN]);
  const s = (base: string) => base;

  const patterns = [
    // Slot: PHRASE — “што поевтино“ / “колку пониско“
    s(PHRASE),
    // Slot: BARE — “daj nesto poeKtino vo toj reon” (the 21:39 transcript):
    // a cheaper-word with nothing to bind to — still a cheaper search.
    s(BARE),
    // Slot: SUP — “нajeftino“ / “најевтино“ / “најниско“
    s(SUP),
    // Slot: ADJ (be | you have | there is) — “поевтино е“ / “поевтино имате“
    s(`${ADJ}${WS}(?:е|имате|има|e|imas|ima)(?![\\p{L}\\p{N}])`),
    // “najevtino shto ima“ / “najnisko shto ima“
    s(`${SUP}${WS}(?:што|колку|shto|kolku)${WS}(?:има|има|ima|ima)`),
    // Slot: EN — “cheapest“ / “most affordable“
    s(EN),
    // “cheaper is better“ / “cheap is good“
    s(`${ADJ}${WS}(?:е|е|е|е)${WS}(?:добро|подобро|добар|подобар|dobra|podbro|dobar|podbor)`),
    // “ниска цена“ / “low price“
    s(`(?:ниска|ниско|niska|nisko)${WS}(?:цена|цena|cena|price)`),
    // “the lower the better“ / “што пониско тоа подобро“
    s(`(?:што|колку|shto|kolku)${WS}${ADJ}${WS}(?:тоа|полош|подобро|toa|podobro)${WS}(?:е|е|е|е)`),
  ];

  return new RegExp('(?:' + patterns.join('|') + ')', 'iu');
}

// ── Widen Search (expand to other neighborhoods) ─────────────────────────────
// Client tells Lina to widen the search — usually right after the exhausted
// ask ("…или да го прошириме пребарувањето во друга населба?"). Two families:
//   1. IMPERATIVE — "прошири ја потрагата", "prosiri ja potragata", bare "прошири"
//   2. AREA QUESTION — "а во други населби нешто со тие карактеристики?",
//      "imash nesto vo druga naselba?", bare "drugi naselbi?"
// Grammar facts used:
//   - Macedonian imperatives drop the object freely ("прошири" alone is a full
//     command), but AMBIGUOUS verbs (види/провери/погледни) need an object or
//     an area — bare "види" is "look!", not "widen".
//   - Object clitics (ја/го) are optional and mobile: "прошири ја потрагата" /
//     "прошири потрагата". "ми" (dative) floats too: "прошири ми ја потрагата".
//   - Latin script mirrors Cyrillic (matchesBoth covers the conversion).

/** Unambiguous widen verbs — the bare form already means "expand the search". */
const WIDEN_VERB_STRONG = ['прошири', 'прошириме', 'проширувај', 'проширетe', 'проширети', 'скенирај'];
const WIDEN_VERB_STRONG_L = ['prosiri', 'prosirete', 'prosirime', 'prosiruvaj', 'skeniraj'];

/** Ambiguous verbs — widen ONLY with an explicit object or area phrase. */
const WIDEN_VERB_AMBIG = ['провери', 'проверете', 'погледни', 'погледнете', 'разгледај', 'разгледајте', 'пребарај', 'пребарајте', 'побарај', 'побарајте', 'пробај', 'пробајте', 'види', 'видете'];
const WIDEN_VERB_AMBIG_L = ['proveri', 'proverete', 'pogledni', 'poglednete', 'razgledaj', 'razgledajte', 'prebaraj', 'prebarajte', 'pobaraj', 'pobarajte', 'probaj', 'probajte', 'vidi', 'videte'];

/** Search-object nouns — what gets widened. */
const WIDEN_OBJ = ['потрагата', 'потрага', 'претрагата', 'претрага', 'пребарувањето', 'пребарување', 'барањата', 'барање', 'критериумот', 'критериуми', 'условите', 'услови', 'опциите', 'опции', 'кругот', 'круг', 'листата', 'листа'];
const WIDEN_OBJ_L = ['potragata', 'potraga', 'pretragata', 'pretraga', 'prebaruvanjeto', 'prebaruvanje', 'baranjata', 'baranje', 'kriteriumot', 'kriteriumi', 'uslovite', 'uslovi', 'opciite', 'opcii', 'krugot', 'krug', 'listata', 'lista'];

/** Other-area phrases — "different neighborhood(s) / part of town / elsewhere". */
const WIDEN_AREA = ['другите населби', 'други населби', 'друга населба', 'друга локација', 'други локации', 'друг дел од градот', 'друг дел', 'друго место', 'други реони', 'друг реон', 'останатите населби', 'останати населби', 'останатите реони', 'останати реони', 'другаде', 'друга страна'];
const WIDEN_AREA_L = ['drugite naselbi', 'drugi naselbi', 'druga naselba', 'druga lokacija', 'drugi lokacii', 'drug del od gradot', 'drug del', 'drugo mesto', 'drugi reoni', 'drug reon', 'ostanatite naselbi', 'ostanati naselbi', 'ostanatite reoni', 'ostanati reoni', 'drugade', 'druga strana'];

/** Question filler after the area — "нешто?", "што има?", "имаш ли?". */
const WIDEN_FILL = ['нешто', 'што', 'има', 'има ли', 'имаш', 'имаш ли', 'имате', 'имате ли', 'каде', 'какво', 'каква'];
const WIDEN_FILL_L = ['nesto', 'shto', 'sto', 'ima', 'ima li', 'imash', 'imash li', 'imate', 'imate li', 'kade', 'kakvo', 'kakva'];

/** English equivalents. */
const WIDEN_EN = ['expand the search', 'widen the search', 'search other neighborhoods', 'other neighborhoods', 'other areas', 'other districts', 'somewhere else', 'anywhere else', 'expand', 'widen'];

/**
 * Build a slot-based regex for WIDEN-THE-SEARCH patterns.
 *
 * Grammar slots:
 *   STRONG_VERB  MI? CLITIC? OBJ?      — "прошири (ми) (ја) (потрагата)"
 *   AMBIG_VERB   MI? CLITIC? OBJ       — "провери ја листата" (object REQUIRED)
 *   AMBIG_VERB   MI? CLITIC? PREP? AREA — "разгледај (во) други населби"
 *   (а|и)? PREP? AREA FILL?            — "а во други населби нешто?", "drugi naselbi?"
 *   FILL PREP AREA                     — "имаш нешто во друга населба?"
 *   EN                                 — "expand the search"
 */
export function buildWidenSlots(): RegExp {
  const VS  = or([...WIDEN_VERB_STRONG, ...WIDEN_VERB_STRONG_L]);
  const VA  = or([...WIDEN_VERB_AMBIG, ...WIDEN_VERB_AMBIG_L]);
  const OBJ = or([...WIDEN_OBJ, ...WIDEN_OBJ_L]);
  const AREA = or([...WIDEN_AREA, ...WIDEN_AREA_L].map(w => w.split(' ').join(WS)));
  const FILL = or([...WIDEN_FILL, ...WIDEN_FILL_L]);
  const EN  = or(WIDEN_EN.map(w => w.split(' ').join(WS)));
  const LB = '(?<![\\p{L}\\p{N}])';
  const RB = '(?![\\p{L}\\p{N}])';
  const OPT_MI = `(?:${WS}(?:ми|mi))?`;
  const OPT_CLITIC = `(?:${WS}(?:ја|го|ja|go))?`;
  const PREP = `(?:${WS}(?:во|vo|на|na))?`;

  const s = (base: string) => base;

  const patterns = [
    // Slot: STRONG_VERB MI? CLITIC? OBJ? — bare "прошири" is a full command
    s(`${LB}${VS}${RB}${OPT_MI}${OPT_CLITIC}(?:${WS}${OBJ})?${RB}`),
    // Slot: AMBIG_VERB MI? CLITIC? OBJ — object REQUIRED (bare "види" = "look!")
    s(`${LB}${VA}${RB}${OPT_MI}${OPT_CLITIC}${WS}${OBJ}${RB}`),
    // Slot: AMBIG_VERB MI? CLITIC? PREP? AREA — "провери во други населби"
    s(`${LB}${VA}${RB}${OPT_MI}${OPT_CLITIC}${PREP}${WS}${AREA}${RB}`),
    // Slot: (а|и)? PREP? AREA FILL? — "а во други населби нешто?", "drugi naselbi?"
    // NOTE: (?:\s+)? — NOT \s+? (lazy + still requires one space, which breaks
    // bare area starts like "drugi naselbi?").
    s(`(?:${LB}(?:а|и|a|i)${WS})?${LB}(?:во|vo|на|na)?(?:${WS})?${AREA}${RB}(?:${WS}${FILL})?`),
    // Slot: FILL PREP AREA — "имаш нешто во друга населба?"
    s(`${LB}${FILL}${WS}(?:во|vo|на|na)${WS}${AREA}${RB}`),
    // Slot: EN — "expand the search", "other neighborhoods?"
    s(`${LB}${EN}${RB}`),
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

export function sampleSizeWaivedPhrases(): string[] {
  return [
    // ── Standard Cyrillic ──
    'големината не ми е битна',
    'не ми е битно',
    'не ми е важно',
    'не ми се битни спални',
    'не ми требаат соби',
    'било колку соби',
    'било какви спални',
    // ── Latin ──
    'goleminata ne mi e bitna',
    'ne mi e bitno',
    'ne mi e vazhno',
    'bilo kolku sobi',
    'bilo kakvi spalni',
    // ── ALL CAPS ──
    'ГОЛЕМИНАТА НЕ МИ Е БИТНА',
    'НЕ МИ Е БИТНО',
    'БИЛО КОЛКУ СОБИ',
    // ── English ──
    "size doesn't matter",
    'any size',
    // ── Edge cases ──
    'не ми се важни собите',
    'не ми требаат спални',
    'goleminata ne mi e vazhno',
  ];
}

export function samplePricePriorityPhrases(): string[] {
  return [
    // ── Standard Cyrillic ──
    'што поевтино',
    'колку поевтино',
    'најевтино',
    'најниско',
    'поевтино е',
    'што пониско',
    // ── Latin ──
    'sto poeftino',
    'kolku poeftino',
    'najeftino',
    'najnisko',
    'ponisko e',
    // ── ALL CAPS ──
    'ШТО ПОЕВТИНО',
    'НАЈЕВТИНО',
    'НАЈНИСКО',
    // ── English ──
    'cheapest',
    'most affordable',
    // ── Full sentences ──
    'ниска цена',
    'што поевтино е',
    'нajевтино што има',
    'поевтино е подобро',
  ];
}

export function sampleWidenPhrases(): string[] {
  return [
    // ── Imperative (strong verbs, object optional) ──
    'прошири ја потрагата',
    'прошири',
    'прошириме потрагата',
    'prosiri ja potragata',
    'prosiri',
    'prosirete ja potragata',
    'скенирај други населби',
    'skeniraj drugi naselbi',
    // ── Ambiguous verb + object ──
    'провери ја листата',
    'погледни други населби',
    'razgledaj drugi naselbi',
    'prebaraj vo druga naselba',
    'провери друг дел од градот',
    // ── Area question (no verb at all) ──
    'а во други населби нешто со тие карактеристики?',
    'a vo drugi naselbi nesto so tie karakteristiki?',
    'drugi naselbi?',
    'imash nesto vo druga naselba?',
    'што има во друг реон?',
    'друг дел од градот',
    'во друго место нешто?',
    // ── English ──
    'expand the search',
    'widen the search',
    'other neighborhoods?',
    // ── ALL CAPS (Viber typing) ──
    'PROSIRI JA POTRAGATA',
    'A VO DRUGI NASELBI NESTO?',
    'DRUGI NASELBI?',
    // ── NEGATIVES — must NOT match ──
    'не барам стан',
    'друга населба ми е Карпош',
    'барам во Аеродром',
  ];
}

// ═════════════════════════════════════════════════════════════════════
// WHY word classes — grammar-based recognition of the "why?" family.
// Macedonian interrogative adverbs are closed-class: зошто/зашто/зосто
// (3 script/typo variants), plus the toleration additions (така/тоа) and
// closing punctuation. Every Macedonian "why" question starts with one of
// these tokens, so the word classes fully cover the family.
// ═════════════════════════════════════════════════════════════════════

/** WHY-question starters (Cyrillic + Latin transliteration variants). */
export const WHY_INTERROGATIVES = '(?:зошто|зашто|зосто|штозошто|zosto|zashto|zoshto|shto zosto)';

/** Optional toleration tail — filler that can follow the bare interrogative. */
export const WHY_TOLERATIONS = '(?:\\s+(?:така|тоа|toa|taka|пa|pa|па|вака|vaka))*';

/** Optional closing punctuation. */
export const WHY_PUNCT = '[?!.]*';

/** Grammar-built bare-why pattern: WHY_INTERROGATIVES + tolerations + punct.
 *  Anchor-free (^…$) so topic why-questions ("зошто наплаќате?") are NOT
 *  captured — they belong to their own detectors. */
export function buildWhySlots(): RegExp {
  return new RegExp(`^${WHY_INTERROGATIVES}${WHY_TOLERATIONS}\\s*${WHY_PUNCT}$`, 'iu');
}

export function sampleWhyPhrases(): string[] {
  return [
    // ── Bare interrogative ──
    'зошто?',
    'зошто',
    'зошто така?',
    'зошто тоа?',
    'зашто?',
    'ZOSTO?',
    'zosto',
    'ZASHTO?',
    'zashto taka?',
    // ── With toleration fillers ──
    'зошто па?',
    'зошто вака?',
    'зошто, па така?',
    // ── NEGATIVES — must NOT match (topic why-questions) ──
    'зошто наплаќате?',
    'зошто е цената 185.000?',
    'зошто треба да платам?',
    'зошто е Скопје главен град?',
  ];
}
