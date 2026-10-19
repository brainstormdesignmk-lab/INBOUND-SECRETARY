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

/** Object nouns — "ad" / "apartment" / "property" (including definite forms).
 *  "гарсоњера" is here too: the client recalls the STUDIO he saw ("imavte edna
 *  garsonjera kaj crnogorska ambasada", the [11:29] capture) — without it the
 *  whole reference fell through and Lina re-asked for the neighborhood. */
const SEEN_OBJ = ['оглас', 'огласот', 'стан', 'станот', 'имот', 'имотот', 'гарсоњера', 'гарсоњерата', 'гарсонера'];
const SEEN_OBJ_L = ['oglas', 'oglasot', 'stan', 'stanot', 'imot', 'imotot', 'garsonjera', 'garsonjerata', 'garconjera'];

/** Past-tense "the agency HAD it" — the client remembers a listing he saw with
 *  us: "imavte edna garsonjera kaj crnogorska ambasada" (the [11:29] capture),
 *  "bese edna garsonjera kaj ambasada". These verbs also form QUESTIONS
 *  ("imavte li garsonjera?", "imavte garsonjera vo centar?"), which are SEARCH
 *  asks — so the slot built from them REQUIRES the determiner: "edna
 *  garsonjera" names a specific unit, a bare "garsonjera" names a category. */
const SEEN_HAD = ['имавте', 'имаше', 'имав', 'имаа', 'беше'];
const SEEN_HAD_L = ['imavte', 'imase', 'imav', 'imaa', 'bese'];

/** Online source — "on the internet" */
const SEEN_ONLINE = ['на интерннет', 'на интернет'];
const SEEN_ONLINE_L = ['na internet'];

/** The place the client saw the ad — "кај вас", "на вашата страна", "на сајтот".
 *  The [13:27] opener was "GLEDAV EDEN STAN KAJ VAS": the client names OUR
 *  site (not "the internet") as where the property was seen — same funnel. */
const SEEN_SITE = ['кај вас', 'на вашата страна', 'на вашиот сајт', 'на сајтот', 'на вашата веб страна', 'на веб страната'];
const SEEN_SITE_L = ['kaj vas', 'na vashata strana', 'na vasiot sajt', 'na sajtot', 'na vashata veb strana', 'na veb stranata'];

/** Determiners/fillers a client slips between the verb and the noun: the
 *  [13:27] "GLEDAV **EDEN** STAN KAJ VAS" (also "vidov nekoj stan", "го гледав
 *  овој стан"). Max TWO, so a sentence-wide "... гледав ... стан" can never
 *  claim the slot. */
const SEEN_FILL = ['еден', 'една', 'едно', 'некој', 'некоја', 'некое', 'тој', 'таа', 'тоа', 'овој', 'оваа', 'ова'];
const SEEN_FILL_L = ['eden', 'edna', 'edno', 'nekoj', 'nekoja', 'nekoe', 'toj', 'taa', 'toa', 'ovoj', 'ovaa', 'ova'];

// ── Size Waived (bedrooms don't matter) ──────────────────────────────────────
// Client says size/rooms don't matter — used to skip bedrooms question.
// Patterns: “goleminata ne mi e bitna“, “не ми се битни спални“,
//           “било колку соби“, “не важно“, “size doesn't matter“
const SIZE_WAIVED_NEG = ['не', 'ne'];
// Sweep-2026-09-23 gaps: care-verbs that negate size as a criterion
// ("ne me zanimaat spalnite", "ne go ogranicuvam brojot na spalni") and the
// care-object forms ("za spalnite mi e seedno", "ne bitno" without the BE).
const SIZE_WAIVED_CAREOBJ_L = ['me zanimaat', 'me interesiraat', 'me interesira', 'go ogranicuvam', 'ja odreduvam'];
const SIZE_WAIVED_CAREOBJ = ['ме занимаат', 'ме интересираат', 'ме интересира', 'го ограничувам', 'ја одредувам'];
const SIZE_WAIVED_SEEDNO_L = ['seedno mi e', 'sveeno mi e', 'seeno mi e', 'sejedno', 'isti mi se', 'isto mi e', 'ednakvo mi e'];
const SIZE_WAIVED_SEEDNO = ['сèедно ми е', 'сеедно ми е', 'седно ми е', 'свеено ми е', 'сеједно', 'исти ми се', 'исто ми е', 'еднакво ми е'];
// Anaphoric tail — "сеедно ми е ЗА ТОА": the indifference points back at the
// size ask ("за тоа" = about THAT question). ENUMERATED pronoun phrases, never
// a free wildcard: a price tail ("сеедно ми е за цената") must keep extracting
// as a budget criterion, never become a size waiver.
const SIZE_WAIVED_TOPIC_PRONOUN_L = ['za toa', 'za toa prashanje', 'za toj prashalnik'];
const SIZE_WAIVED_TOPIC_PRONOUN = ['за тоа', 'за тоа прашање', 'за тој прашалник'];
const SIZE_WAIVED_TOLKU_L = ['tolku', 'vaka', 'kako sto ke bide', 'kakvo sto ke bide'];
// Replay-2 residual shapes (the sweep's second pass): indifference verbs
// ("me zamara"), relevance adjectives ("presudno", "vazno"), dismissals
// ("nema veze", "ne pravam problem").
const SIZE_WAIVED_MIND_L = ['me zamara', 'me zajma', 'me mara'];
const SIZE_WAIVED_MIND = ['ме замара', 'ме зажма', 'ме мара'];
const SIZE_WAIVED_DISMISS_L = ['nema veze', 'ne pravam problem', 'ne pravam problema'];
const SIZE_WAIVED_DISMISS = ['нема везе', 'не правам проблем', 'не правам проблема', 'не праам проблем'];
// DISMISS-NOT: bare “nema veze, drug pat“ is a visit-time defer (the 12:07
// family) — the dismissal is only a size-waiver when the SIZE TOPIC is named
// ("nema veze spalnite"). Anaphoric “za toa“ stays unroutable on purpose.
const SIZE_WAIVED_DISMISS_ZA = ['za', 'за'];
const SIZE_WAIVED_TOLKU = ['толку', 'вака', 'како што ќе биде', 'какво што ќе биде'];
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
// BARE fused-negation: “NEBITNO“, “НЕБИТНО“, “nebitni“, “неважно“ — one word,
// no verb, no noun. The 21:40 transcript: the client answered the bedrooms
// ask with the single word “NEBITNO“ and the grammar (which demanded a verb:
// “nebitno e“) swallowed it, looping the funnel. Word-boundary anchored in
// the slot so “nebitno“ inside a longer sentence still needs its slot (the
// old “nebitno e“ forms keep matching independently).
const SIZE_WAIVED_NEADJ_BARE = ['небитно', 'небитни', 'небитна', 'небитен', 'неважно', 'неважни', 'неважна'];
const SIZE_WAIVED_NEADJ_BARE_L = ['nebitno', 'nebitni', 'nebitna', 'nebiten', 'nevazno', 'nevazni', 'nevazna'];
const SIZE_WAIVED_ANY_L = ['bilo kolku', 'bilo kakvi', 'bilo kakov', 'bilo kolkav', 'bilo kolku sobi', 'bilo kolku spalni'];
// “nebitni se spalnite“ — the NEGATED ADJECTIVE as ONE token (ne+bitni fused),
// with the DEFINITE noun form (spalnite). The 13:53 transcript: the bedrooms
// ask repeated because the slot list only knew “ne mi se bitni spalni“.
const SIZE_WAIVED_NEADJ = ['небитни', 'небитно', 'небитна', 'небитен', 'неважни', 'неважно', 'неважна'];
const SIZE_WAIVED_NEADJ_L = ['nebitni', 'nebitno', 'nebitna', 'nebiten', 'nevazhni', 'nevazno', 'nevazna', 'nevazni'];
const SIZE_WAIVED_NOUN_DEF = ['спалните', 'собите'];
const SIZE_WAIVED_NOUN_DEF_L = ['spalnite', 'sobite'];
// Indefinite topic nouns for the “rekav nebitno za sobi“ class — bare waiver
// with the topic appended. Undefinite forms only: definite nouns already ride
// NOUNDEF slots.
const SIZE_WAIVED_NOUN_ANY = ['спални', 'соби', 'golemina', 'големина', 'spalni', 'sobi'];
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
  const SITE = or([...SEEN_SITE, ...SEEN_SITE_L]);
  const FILL = or([...SEEN_FILL, ...SEEN_FILL_L]);
  const HAD = or([...SEEN_HAD, ...SEEN_HAD_L]);
  const GAPSEEN = '[^.!?\\n]{0,30}';

  const s = (base: string) => base;

  const patterns = [
    // Slot: CLITIC SAW — "го гледав"
    s(`${CL}${WS}${SAW}`),
    // Slot: SAW OBJ — "гледав оглас"
    s(`${SAW}${WS}${OBJ}`),
    // Slot: SAW FILL? OBJ — "гледав еден стан", "GLEDAV EDEN STAN", "vidov
    // nekoj oglas" (the [13:27] capture: the determiner broke every slot)
    s(`${SAW}${WS}(?:${FILL}${WS}){0,2}${OBJ}`),
    // Slot: HAD FILL OBJ — "imavte edna garsonjera kaj crnogorska ambasada",
    // "имавте една гарсоњера кај амбасадата" (the [11:29] capture): the client
    // recalls a listing he saw WITH US, which is the same funnel as "gledav
    // eden stan". The determiner is required (see SEEN_HAD) so a search ask
    // ("imavte li garsonjera?", "imavte garsonjera vo centar?") stays a
    // search.
    s(`${HAD}${WS}${FILL}${WS}${OBJ}`),
    // Slot: OBJ SAW — "оглас гледав" (reversed, no clitic)
    s(`${OBJ}${WS}${SAW}`),
    // Slot: OBJ CLITIC SAW — "огласот го гледав" (full reversal)
    s(`${OBJ}${WS}${CL}${WS}${SAW}`),
    // Slot: SAW GAP? online — "гледав на интернет"
    s(`${SAW}${GAPSEEN}${ONL}`),
    // Slot: OBJ CLITIC SAW GAP? online — "огласот го гледав на интернет"
    s(`${OBJ}${WS}${CL}${WS}${SAW}${GAPSEEN}${ONL}`),
    // Slot: SAW GAP? SITE — "гледав кај вас", "gledav na vashata strana"
    s(`${SAW}${GAPSEEN}${SITE}`),
    // Slot: CLITIC SAW GAP? SITE — "го гледав на вашиот сајт"
    s(`${CL}${WS}${SAW}${GAPSEEN}${SITE}`),
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
  const ADJ = or([...SIZE_WAIVED_ADJ, ...SIZE_WAIVED_ADJ_L, 'vazna', 'vazno']);
  const ANY = or([...SIZE_WAIVED_ANY, ...SIZE_WAIVED_ANY_L]);
  const EN = or([...SIZE_WAIVED_EN]);
  // NEADJ = fused negated adjective (небитни/nebitni…), NOUNDEF = definite noun
  // (спалните/spalnite, собите/sobite) — the 13:53 “nebitni se spalnite“ forms.
  const NEADJ = or([...SIZE_WAIVED_NEADJ, ...SIZE_WAIVED_NEADJ_L]);
  const NOUNDEF = or([...SIZE_WAIVED_NOUN_DEF, ...SIZE_WAIVED_NOUN_DEF_L]);
  // BARE = the fused negation ALONE (21:40 “NEBITNO“) — word-boundary anchored,
  // never a substring (so “nebitno“ inside other slots still needs its slot).
  const BARE = `(?:${or([...SIZE_WAIVED_NEADJ_BARE, ...SIZE_WAIVED_NEADJ_BARE_L])})`;
  // BAREFUZZ = bare form + at most ONE trailing char ("небитноо", "nebitnoo") —
  // the one-keypad-typo class. Built from the RAW lists (or()'s trailing
  // lookahead would reject the fuzz char); the ENDISH anchor provides the
  // word boundary instead, so no substring fire is possible. The alternation
  // is wrapped BEFORE appending .? — unwrapped, the fuzz suffix binds only
  // to the last list item (regex-precedence trap).
  const BAREFUZZ = `(?:(?:${[...SIZE_WAIVED_NEADJ_BARE, ...SIZE_WAIVED_NEADJ_BARE_L].join('|')}).{0,2})`;
  // NOUNDEF_ANY — topic nouns for the bare-with-topic class.
  const NOUNDEF_ANY = `(?:${SIZE_WAIVED_NOUN_ANY.join('|')})`;
  // TOPIC — any size topic noun, definite or indefinite, with a 0–2 char fuzz
  // tail ("spalnii", "spalniti"). The fuzz lives INSIDE the group: unwrapped,
  // a following `?` binds to the fuzz quantifier instead of the whole topic
  // (regex-precedence trap — same class as the BAREFUZZ bug) and silently
  // makes the topic mandatory.
  const TOPIC = `(?:(?:${NOUNDEF}|${NOUNDEF_ANY}).{0,2})`;
  // CONNS — optional connector words (za/kolku + typos), zero to two, each
  // with optional trailing space, before the topic noun: "za sobite",
  // "kolku spalnii", "za kolku sobi", or none ("spalnite"). One closed
  // group instead of chained per-connector optionals — the chained form
  // made "kolku" mandatory inside ZA-only paths (the "za sobite" break).
  const CONNS = `(?:${WS}(?:(?:za|за|kolku|kolkju|колку|колкju)(?:${WS}|$)){0,2})?`;
  // ENDISH — the message may end here: optional whitespace, optional
  // punctuation, end. Covers "tolku" / "tolku." / "bide ?"; "tolku imam" has
  // a word after the space, so the anchor never matches.
  const ENDISH = `(?:${'\\s*'}[.,!?]*${'\\s*'}$)`;
  const s = (base: string) => base;

  const patterns = [
    // Slot: OBJ NEG SUBJ BE ADJ — “големината не ми е битна“
    s(`${or([...SIZE_WAIVED_OBJ, ...SIZE_WAIVED_OBJ_L])}${WS}${NEG}${WS}${SUBJ}${WS}${BE}${WS}${ADJ}`),
    // Slot: NEG SUBJ BE ADJ — “не ми е битно“
    s(`${NEG}${WS}${SUBJ}${WS}${BE}${WS}${ADJ}`),
    // Slot: NEG BE ADJ — “ne e bitno kolkju spalni“ — no subject clitic. The
    // 21:40 transcript form (“NE E BITNO KOLKU SPALNI“): colloquial speech
    // drops “ми/ни“, the old slot demanded it and the funnel looped.
    s(`${NEG}${WS}${BE}${WS}${ADJ}`),
    // Short form + dangling quantifier — “ne bitno kolkju“: the quantifier
    // ends the message ("not important how-many").
    s(`(?:^|${WS})${NEG}${WS}${ADJ}${WS}(?:kolku|kolkju|колку|колкju)${ENDISH}`),
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
    // BARE fused negation — “NEBITNO“ / “НЕБИТНО“ alone answers the ask.
    // ENDISH-anchored: “nebitno za golemina, edna spalna“ carries a CONCESSION
    // (a real criterion follows) — that is an answer, not a waiver.
    s(`(?:^|${WS})${BARE}${ENDISH}`),
    // BAREFUZZ — one-typo bare ("небитноо", "nebitnoo"), end-anchored.
    s(`(?:^|${WS})${BAREFUZZ}${ENDISH}`),
    // BARE short form — “ne bitno“ (space-split, no BE verb), optionally with
    // the definite noun; must END the message (a trailing “ali…“ is a
    // concession that names the real criterion).
    s(`(?:^|${WS})${NEG}${WS}${ADJ}(?:${WS}${NOUNDEF})?${ENDISH}`),
    // Care-verb negation — “ne ME ZANIMAAT spalnite“ / “ne go ogranicuvam brojot“:
    // the client names the size noun and negates caring about it.
    s(`(?:^|${WS})${NEG}${WS}(?:${or(SIZE_WAIVED_CAREOBJ_L)}|${or(SIZE_WAIVED_CAREOBJ)})`),
    // “сеедно ми е (за спалните)“ / “сите по големина ми одговараат“:
    // indifference-by-synonym, no negation word at all. Optional tail: the
    // topic/quantifier ("seeno mi e kolku spalnii") — size nouns and “kolku“
    // only, so price tails can never ride it.
    s(`(?:^|${WS})(?:${or(SIZE_WAIVED_SEEDNO_L)}|${or(SIZE_WAIVED_SEEDNO)})${CONNS}${TOPIC}?${ENDISH}`),
    // SEEDNO + anaphoric pronoun — "сеедно ми е за тоа": same indifference, the
    // tail is the enumerated pronoun class above (not TOPIC, which only holds
    // size nouns, and not a free wildcard, which would eat price criteria).
    s(`(?:^|${WS})(?:${or(SIZE_WAIVED_SEEDNO_L)}|${or(SIZE_WAIVED_SEEDNO)})${CONNS}(?:${or(SIZE_WAIVED_TOPIC_PRONOUN_L)}|${or(SIZE_WAIVED_TOPIC_PRONOUN)})${ENDISH}`),
    s(`(?:^|${WS})сите${WS}по${WS}големина(?:${WS}|$)`),
    // “kako sto ke bide“ / “tolku“ / “vaka“ — shrug forms that answer the ask.
    // The shrug must BE the message (ENDISH): “tolku imam“ is the 10:54
    // budget statement, never a waiver.
    s(`(?:^|${WS})(?:${or(SIZE_WAIVED_TOLKU_L)}|${or(SIZE_WAIVED_TOLKU)})${ENDISH}`),
    // NOUN-first copula form — “собите не се битни“ / “spalnite ne se bitni“:
    // the 13:53 family's reversed word order (negation between noun and
    // fused negative) that the NEADJ slots (which require BE=se/e between
    // the pair) structurally miss. The trailing adjective may be FUSED
    // ("небитни") or PLAIN ("битни" — negation carried by the leading "не").
    // No ^|WS anchor: “како што дојде, собите не се битни“ follows a comma,
    // and or() already bounds the noun.
    s(`${NOUNDEF}${WS}${NEG}${WS}(?:се|se|е|e)${WS}(?:${NEADJ}|${or(['битни', 'важни', 'bitni', 'vazhni'])})`),
    // “rekav nebitnoоо za sobi“ — BARE with a fuzz tail AND a trailing topic
    // noun: indifference stated in the past tense, topic appended. The ENDISH
    // BARE slots above miss it (topic noun after the fused negation). Topic
    // must be present so bare-“nebitno“ semantics stay protected.
    s(`(?:^|${WS})${BAREFUZZ}${CONNS}${TOPIC}?${ENDISH}`),
    // “me zamara brojot na sobi“ / “ne me zamara kolku spalni“ — the
    // indifference-verb family (sweep replay 2).
    s(`(?:^|${WS})(?:${NEG}${WS})?${or(SIZE_WAIVED_MIND_L)}|${or(SIZE_WAIVED_MIND)}(?:${WS}|$)`),
    // “ne e presudno kolku spalni ima“ — relevance adjectives beyond
    // bitno/vazno (sweep replay 2).
    s(`(?:^|${WS})${NEG}${WS}(?:се|se|е|e)${WS}presudno(?:${WS}|$)`),
    // “nema veze spalnite“ / “nema veze kolku spalni ima“ (10:27) / “ne pravam
    // problem za sobite“ — dismissals that answer the bedrooms ask. The size
    // topic is REQUIRED (bare “nema veze“ is the visit-time defer's turf —
    // see DISMISS-NOT); an optional quantifier (“kolku“) and trailing verb
    // (“ima“) ride between, matching the real client word orders.
    s(`(?:^|${WS})(?:${or(SIZE_WAIVED_DISMISS_L)}|${or(SIZE_WAIVED_DISMISS)})${CONNS}${TOPIC}(?:${WS}(?:ima|imaa|има|имаа|treba|треба)(?:${WS}(?:stanot|куќата|kukata))?|${WS}(?:stanot|куќата|kukata))?${ENDISH}`),
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

/** Other-area phrases — "different neighborhood(s) / part of town / elsewhere".
 *  TYPO FORMS ([12:45] transcript: "MOZE I VO DRUGI NSELBI" — the dropped-a
 *  slip must widen exactly like "NASELBI"; also the reversed-a Cyrillic slip
 *  and the Latin ѕ/j-slip variants). Typos are pinned EXPLICITLY — they are
 *  single edits but the slot regex matches exact area phrases, not fuzzy ones. */
const WIDEN_AREA = ['другите населби', 'други населби', 'друга населба', 'друга локација', 'други локации', 'друг дел од градот', 'друг дел', 'друго место', 'други реони', 'друг реон', 'останатите населби', 'останати населби', 'останатите реони', 'останати реони', 'другаде', 'друга страна', 'други нселби', 'друга нселба', 'другите нселби', 'останати нселби', 'други насулби', 'друга наслеба'];
const WIDEN_AREA_L = ['drugite naselbi', 'drugi naselbi', 'druga naselba', 'druga lokacija', 'drugi lokacii', 'drug del od gradot', 'drug del', 'drugo mesto', 'drugi reoni', 'drug reon', 'ostanatite naselbi', 'ostanati naselbi', 'ostanatite reoni', 'ostanati reoni', 'drugade', 'druga strana', 'drugi nselbi', 'druga nselba', 'drugite nselbi', 'ostanati nselbi', 'drugi naselva', 'druga nselva', 'drugi naseljbi'];

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
    // ── The site/determiner family (the [13:27] capture) ──
    'GLEDAV EDEN STAN KAJ VAS',
    'gledav eden stan kaj vas',
    'видов еден стан на вашата страна',
    'vidov nekoj stan na vasiot sajt',
    'го гледав станот на сајтот',
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
    // ── Sweep-2026-09-23 gap shapes (data/hardening/size-waived.json) ──
    'небитноо',
    'ne bitno',
    'не ме занимаат спалните',
    'ne go ogranicuvam brojot na spalni',
    'seedno mi e za spalniti',
    'сèедно ми е',
    'сите по големина ми одговараат',
    'kako sto ke bide',
    'bilo kolkav',
    'не е важно, колку има така',
    'пак ќе кажам не ме занимаат спалните',
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

// ═════════════════════════════════════════════════════════════════════
// FEE-NEGOTIATION word classes — grammar-based recognition of the
// "why do you charge / nobody charges" family. Macedonian word order is
// free, so every family member is a SLOT PAIR (anchor + claim) matched in
// BOTH orders, exactly like the availability/visit classes above.
// ═════════════════════════════════════════════════════════════════════

/** Universal quantifier — никoj / никому / никогаш (+ Latin, + о/о-typos). */
export const FEE_NEG_UNIVERSAL_L = '(?:ником|никому|никој|никоj|никои|никогаш|никогаш\w*|nikoj|nikomu|nikogas\\w*|nikogash\\w*)';

/** NEVER-adverb + negated charge verb — "не наплаќа" / "никогаш не зема". */
export const FEE_NEG_CHARGE_L = '(?:не\\s+(?:напла[ќк]\\w*|наплат\\w*|зема\\w*|zem\\w*|naplakj?\\w*|naplat\\w*|plakjat?\\w*|pravi\\w*|прават?|pravat)|никогаш\\s+не\\s+\\p{L}+|ne\\s+(?:naplakj?\\w*|naplat\\w*|zem\\w*|plakjat?\\w*|pravi|pravat)|nikogas\\s+ne\\s+\\p{L}+|nikogash\\s+ne\\s+\\p{L}+|(?:земат[еи]|земате|zemate)[^.!?\\n]{0,30}(?:пар[аие]|par[aei]|посет\\p{L}*|poset\\p{L}*)|(?:пар[аие]|par[aei])[^.!?\\n]{0,30}(?:земат[еи]|zemate))';

/** Claim verbs for the universal frame — "прави/does" and "зема/takes". */
export const FEE_NEG_DO_L = '(?:прави|прават|pravi|pravat|зема|земат|zemate?|zemat|напла[ќк]\\w*|наплат\\w*|naplakj?\\w*|naplat\\w*|плат\\p{L}*|плаќ\\p{L}*|plat\\p{L}*|plakj\\p{L}*)';

/** 2nd-person charge verb — "вие работите таквата работа" → земате/правите. */
export const FEE_2P_CHARGE_L = '(?:работите|работите\\s+такв?а?та?а?|rabotite|земат[еи]|земате|zemate|правите|pravite|напла[ќк]ате|наплатувате|naplakjate|naplakate|naplatuvate|платите|плаќате|platite|plakjate)';

/** Practice noun — "ваква практика / таква работа / taka rabotite". */
export const FEE_PRACTICE_L = '(?:такв?ата?а?|такв[аои]\\p{L}*|така|taka|taku|takv\\w*|вакв[аои]\\p{L}*|vakv\\w*|работата|работа\\p{L}*|rabotata|rabota\\w*|практика\\p{L}*|praktika\\w*|систем\\p{L}*|sistem\\w*)';

/** Viewing nouns WITHOUT \p{L} wildcards — safe for gap windows. */
export const FEE_VIEWING_NOUN_L = '(?:посета|посетата|poseta|posetata|разглед\\w*|razgled\\w*|гледањ\\w*|gledanj\\w*|преглед\\w*|pregled\\w*|влезница\\w*|vleznica\\w*|визита|vizita|надомест\\w*|nadomest\\w*|nadomestok|такса\\w*|taksa\\w*|пари|pari)';

/** "+ viewing noun" claim head for the universal frame (no-gap direct pairs). */
export const FEE_VIEWING_CLAIM_L = '(?:\\s+(?:за|za)\\s+' + FEE_VIEWING_NOUN_L + '|\\s+' + FEE_VIEWING_NOUN_L + ')';

/** TOTAL-COST arithmetic noun — станови/имоти × viewing fee. Cyrillic stems
 *  use \p{L}* (JS \w is ASCII-only — 'стана' must extend 'стан'). */
export const FEE_MULTI_NOUN_L = '(?:стан\\p{L}*|stan\\w*|имот\\p{L}*|imot\\w*|ку[ао]ј\\p{L}*|kukj\\w*|посет\\p{L}*|poset\\w*|разглед\\p{L}*|razgled\\w*|гледањ\\p{L}*|gledanj\\w*)';

/** Currency/unit allowed GLUED to the amount — "5000DEN" (the [02:16] capture),
 *  "300ден", "5eur", "250 мкд". */
export const FEE_CURRENCY_L = '(?:ден\\p{L}*|денар\\p{L}*|den(?:ar)?\\w*|евр\\p{L}*|евра|evr\\w*|eur|мкд|mkd)';

/** A fee-sized amount: ≤4 digits with an OPTIONAL glued or spaced currency.
 *  5-digit sums (property prices: 185000) can never match; "5000DEN" is ONE
 *  token, so the right boundary is checked after the currency, not the digits. */
export const FEE_AMOUNT_L = '(?<![\\p{L}\\p{N}])\\d{1,4}(?:\\s?' + FEE_CURRENCY_L + ')?(?![\\p{L}\\p{N}])';

/** A verb of visiting/browsing — the client counting the viewings he would do
 *  ("ако посетам 10 стана", "ako gledam 10 stanovi", "разгледам 5"). */
export const FEE_VISIT_VERB_L = '(?:посет\\p{L}*|poset\\w*|разглед\\p{L}*|razgled\\w*|обикол\\p{L}*|obikol\\w*|гледа\\p{L}*|gleda\\w*|вид\\p{L}*|vid\\w*)';

/** Total-sum head in front of the amount — "тоа се / значи / вкупно / заедно". */
export const FEE_TOTAL_HEAD_L = '(?:тоа\\s+се|toa\\s+se|значи|znaci|znachi|вкупно|vkupno|заедно|zaedno|сè|сите|site|сума\\p{L}*|suma\\w*)';

/** "for nothing" anchor — the client's own money with nothing to show for it:
 *  "на гладно" (the [02:16] burst), "за ништо". Sits where FEE_POCKET_L sits
 *  in arm A: both pin the client's own spend, never a budget or a price. */
export const FEE_NOTHING_L = '(?:на\\s+гладно|na\\s+gladno|за\\s+ништо|za\\s+nishto|za\\s+niso|бадава|badava)';

/** Grammar-built fee-negotiation patterns (see module docs). BOTH word orders
 *  per family; all scripts; typoes tolerated. Callers gate on state — these
 *  patterns describe fee talk, not property talk. */
export function buildFeeWhySlots(): RegExp {
  // [universal][gap][claim] | [claim][gap][universal]
  return new RegExp(
    _b(FEE_NEG_UNIVERSAL_L) + '[^.!?\\n]{0,40}' + '(?:' + FEE_NEG_CHARGE_L + '|' + FEE_NEG_DO_L + ')'
    + '|' + '(?:' + FEE_NEG_CHARGE_L + '|' + FEE_NEG_DO_L + ')' + '[^.!?\\n]{0,40}' + _b(FEE_NEG_UNIVERSAL_L),
    'iu');
}

/** Boundary guard shared with or() above (JS \b is ASCII-only). */
function _b(src: string): string {
  return '(?<![\\p{L}\\p{N}])(?:' + src + ')(?![\\p{L}\\p{N}])';
}
/** "(вие) така работите” — 2nd-person practice statement: the client asserts
 *  Lina's agency charges for visits as POLICY (a fee-why frame, never a
 *  search/interest). Charge/practice anchors within a 60-char clause. */
export function buildFeePracticeSlots(): RegExp {
  return new RegExp(
    _b(FEE_2P_CHARGE_L) + '[^.!?\\n]{0,60}' + _b(FEE_PRACTICE_L)
    + '|' + _b(FEE_PRACTICE_L) + '[^.!?\\n]{0,60}' + _b(FEE_2P_CHARGE_L),
    'iu');
}

/** Multiplication total-cost arithmetic about the VISIT FEE: "10 стана × 500
 *  = 5000 од мој џеб". STRICT arithmetic shapes only — the loose noun+amount
 *  arm false-positivized BUDGETS ("стан … до 250 евра" ate the whole funnel,
 *  the [12:4x] regression):
 *    A) noun … amount(≤4 digits) … the client's own-spend anchor
 *       ("…се 5000 од мој џеб", "…5000 на гладно" — џеб/на гладно pin the
 *       client's own money, which a budget or a property price never does);
 *    B) COUNT + noun + по/× + amount (+optional currency): "10 стана по 500
 *       денари", "10 stanovi x 500";
 *    C) the MULTI-VISIT total (the [02:16] live burst "PA AKO POSETAM 10
 *       STANA TOA SE 5000DEN NA GLADNO?"): a visit verb + COUNT + noun, with
 *       the sum either introduced by a total head ("тоа се / значи / вкупно")
 *       or following the count directly — the client is multiplying the FEE by
 *       the number of viewings he plans, not naming a budget;
 *    D) COUNT + noun + total head + amount, same arithmetic without the verb
 *       ("10 посети, тоа се 3000 ден").
 *  Budgets ("стан до 250 евра") carry no anchor, no visit verb and no total
 *  head — they can never match. 5+ digit numbers (property prices 185.000) are
 *  out by \d{1,4}+boundary, and a currency may ride GLUED to the amount
 *  ("5000DEN" — the live capture's spelling, one token, no space). */
export function buildFeeTotalCostSlots(): RegExp {
  const COUNT = '(?<![\\p{L}\\p{N}])\\d{1,3}';
  const TOTAL = '(?:' + FEE_TOTAL_HEAD_L + ')\\s*';
  return new RegExp(
    // A: own-spend anchored sum
    _b(FEE_MULTI_NOUN_L) + '[^.!?\\n]{0,60}' + FEE_AMOUNT_L + '[^.!?\\n]{0,20}'
      + '(?:' + _b(FEE_POCKET_L) + '|' + _b(FEE_NOTHING_L) + ')'
    // B: explicit multiplication (COUNT + noun + по/× + amount)
    + '|' + COUNT + '\\s*' + _b(FEE_MULTI_NOUN_L) + '[^.!?\\n]{0,10}(?:по|po|×|[хx]|\\*)\\s*' + FEE_AMOUNT_L
    // C: multi-visit total — visit verb + HOW MANY + noun (+ total head) + sum
    + '|' + _b(FEE_VISIT_VERB_L) + '[^.!?\\n]{0,40}' + COUNT + '\\s*' + _b(FEE_MULTI_NOUN_L)
      + '[^.!?\\n]{0,40}(?:' + TOTAL + ')?' + FEE_AMOUNT_L
    // D: the same arithmetic without the verb — COUNT + noun + total head + sum
    + '|' + COUNT + '\\s*' + _b(FEE_MULTI_NOUN_L) + '[^.!?\\n]{0,40}' + TOTAL + FEE_AMOUNT_L,
    'iu');
}

/** Ownership/pocket marker — "од мој џеб / od moj djeb" (the client's own
 *  spend) — the bare-amount anchor of the total-cost family. Bare-stem form:
 *  the 'од мој' lead rides in the gap window. Cyrillic \p{L}* (JS \w ASCII). */
export const FEE_POCKET_L = '(?:џеб\\p{L}*|dj?z?eb\\w*)';

/** RULES/POLICY noun — the client dismisses the fee as "just your policy":
 *  "тоа се Вашите правила", "вашата политика е таква", "agency rules". */
export const FEE_RULES_NOUN_L = '(?:правил\\p{L}*|pravil\\w*|политик\\p{L}*|politik\\w*|протокол\\p{L}*|protokol\\w*|деловник\\p{L}*|delovnik\\w*)';

/** Possessive/agency anchor beside the rules noun — Ваш/агенција/Метрополис. */
export const FEE_RULES_OWNER_L = '(?:ваш\\p{L}*|vash\\w*|агенци\\p{L}*|agenci\\w*|метрополис|metropolis|вие|vie)';

/** Client-side POLICY ASSERTION: rules/policy noun + owner anchor, either
 *  order — "тоа се Вашите правила", "vashata politika e takva". The answer
 *  is the agency-rules rationale (the rules bind clients and agents alike),
 *  never a search and never the fee re-disclosure. */
export function buildFeeRulesSlots(): RegExp {
  return new RegExp(
    _b(FEE_RULES_NOUN_L) + '[^.!?\\n]{0,40}' + _b(FEE_RULES_OWNER_L)
    + '|' + _b(FEE_RULES_OWNER_L) + '[^.!?\\n]{0,40}' + _b(FEE_RULES_NOUN_L),
    'iu');
}

export function sampleFeeWhyPhrases(): string[] {
  return [
    // ── Universal frame (никoj … не …) ──
    'никoj не зема пари за посета',
    'nikoj ne zema pari za poseta',
    'НИКОЈ НЕ НАПЛАЌА ЗА ПОСЕТА',
    'никому не му требаат пари за посета',
    'никогаш не сум платил за посета',
    'nikogas ne plativ za poseta',
    'никoj не го прави тоа',
    // ── 2nd-person practice frame ──
    'само вие работите така',
    'samo vie rabotite taka',
    'вие земате пари за посета',
    'vie rabotite taka',
    'САМО ВИЕ РАБОТИТЕ ТАКА',
    // ── Rules/policy frame ──
    'тоа се Вашите правила',
    'toa se vashite pravila',
    'вашата политика е таква',
    'TOA E VASHA POLITIKA',
    // ── Multiplication total-cost frame ──
    'ако гледам 10 стана тоа се 5000 од мој џеб за разгледување',
    'ako gledam 10 stana toa se 5000 od moj djeb za razgleduvanje',
    '10 станови × 500 денари е многу',
    // ── NEGATIVES — must NOT match ──
    'барам стан во Карпош',
    'зинтересиран сум за стан',
    'каков е станот?',
  ];
}

export function sampleByePhrases(): string[] {
  return [
    // ── Pure exits ──
    'cao',
    'чао',
    'ne fala ti cao',
    'не фала ти чао',
    'fala cao',
    'до гледање',
    'prijatno',
    'се гледаме',
    'NE FALA TI CAO',
    // ── NEGATIVES — must NOT match ──
    'cao, baram stan',
    'fala, koga moze poseta?',
    'ne fala, sakam poniska cena',
  ];
}

export function sampleSoftRefusalPhrases(): string[] {
  return [
    // ── Bare declines ──
    'ne sakam',
    'не сакам',
    'ne fala',
    'не фала',
    'ne, blagodaram',
    'nitu toa',
    'NE SAKAM',
    // ── NEGATIVES — must NOT match ──
    'ne sakam da platam',
    'ne sakam stan',
    'ne sakam, ama kolku e kirijata?',
  ];
}

// ═════════════════════════════════════════════════════════════════════
// GOODBYE word classes — the pure conversation-exit family.
//
// The [13:2x] V16K11 ending: "ne fala ti / cao" rode the dynamic fallback,
// whose system prompt FORCE-ENDS every answer with a forward question — so
// Lina thanked the client and asked "Можам ли да Ви помогнам со уште нешто
// за крај?" AFTER he said goodbye. The exit needs NO brain: a short warm
// farewell ending "Се најдобро!" and nothing else.
// ═════════════════════════════════════════════════════════════════════

/** Farewell verbs/tokens — чао/приватно/до гледање/се гледаме + благодарам
 *  variants. Latin entries are word STEMS (\w*). */
export const BYE_TOKEN_L = '(?:ч[аa]о|чао\\s*чао|cao|ciao|приватно|privatno|до\\s+гледање|do\\s+gledanje|до\\s+gledanje|гледање\\s+до|se\\s+gledame|се\\s+гледаме|пријатно|prijatno|doviduvanje|довидување|добро\\s+поминување|se\\s+najdobro|се\\s+најдобро)';

/** Decline-with-thanks tokens — фала/благодарам/фала ти + fillers. */
export const BYE_THANKS_L = '(?:фал[ауи]\\w*|fala\\w*|благодарам|blagodaram|hvala|се\\s+фал|se\\s+fal)';

/** Fillers tolerated inside a pure exit burst (не ми треба ништо, пријатно…).
 *  Latin words are STEMS — “ti” rides in “fala ti”, “sakam” in “ne sakam”. */
export const BYE_FILLER_L = '(?:не|ne|ниту|nitu|ми|mi|треба\\p{L}*|treba\\w*|ништо\\p{L}*|nisto\\w*|повеќе\\p{L}*|povek[j]?e\\w*|фала\\p{L}*|fala\\w*|благодарам|blagodaram|се|se|сега|sega|за|za|сè|тиво|tivo|поздрав\\p{L}*|pozdrav\\w*|pozz\\w*|ти|ti|си|si|мој\\p{L}*|moj\\w*|тоа|toa|това|tova|\\s|[!.,?:;)\"\'(\u00A0-])';

/** Pure-exit burst: bye tokens (+ thanks + fillers) ONLY — a criteria word,
 *  a digits run or a question mark disqualifies. ^…$ anchored. */
export function buildByeSlots(): RegExp {
  return new RegExp(
    '^(?:' + BYE_TOKEN_L + '|' + BYE_THANKS_L + '|' + BYE_FILLER_L + ')+$',
    'iu');
}

/** Soft refusal: a BARE decline ("не сакам", "не фала", "не, благодарам") —
 *  the [13:2x] capture: "ne sakam" alone rode the dynamic fallback into a
 *  generic re-offer. Boundary-guarded, anchored, fillers tolerated; a
 *  PAYMENT/FEE object, a criteria word or a question disqualify (those are
 *  fee/refusal/search traffic with their own lanes). */
export function buildSoftRefusalSlots(): RegExp {
  return new RegExp(
    '^(?:не|ne|no|ниту|nitu)(?![\\p{L}\\p{N}])(?:' + BYE_FILLER_L + ')*'
    + '(?:сакам\\p{L}*|sakam\\w*|фала\\p{L}*|fala\\w*|благодарам|blagodaram|ниту\\p{L}*|nitu\\w*|тоа|toa)?$',
    'iu');
}

// ═════════════════════════════════════════════════════════════════════
// EXIT-CHECK triggers — the client WANTS to end the conversation but has
// never been asked the one final question: does any offered option have a
// chance? The V16K11 capture: "Se predomisliv / ke si piseme drugoat / moram
// da prekina" rode the dynamic fallback straight into a farewell — the funnel
// closed WITHOUT the last-chance check and the session died cold.
//
// The family is QUESTION-shaped or FIRST-PERSON-wanting; an OFFER/choice
// statement ("predomisliv sum, sakam go prviot") must keep its own lanes —
// hence the negated OFFER/choice frame veto below.
// ═════════════════════════════════════════════════════════════════════

/** Change-of-mind about CONTINUING (never about a specific property):
 *  predomisliv/se predomisliv, predomisluvam… both scripts. */
export const EXIT_PREDOMISLIV_L = '(?:предомисл(?:ив|ен|ена|увам|ам)|predomisli[vw]|se\\s+predomisluvam)';

/** Future-contact / stop-for-now: „ќе си пишеме“ (drugo Pat), ќе се чуваме…
 *  Latin: "ke si piseme", "ke se cuvame", "ke se cueme" (client spelling).
 *  The V16K11 miss: the client forms are stem + optional infix + optional Е +
 *  ending — "piseme" = pis·e·me (uv-infix dropped), "cueme" = cu·e·me (va
 *  dropped) — so BOTH infixes and the connecting Е are optional; the ending
 *  carries the shape. The пис/цу roots are the normalizeMc image of the
 *  Latin spellings (s→с, c→ц — no ш/ч without the digraph). */
export const EXIT_CONTACT_LATER_L = '(?:ке\\s+си\\s+(?:пиш|пис)(?:ув)?а?е?(?:ме|т)|ке\\s+се\\s+(?:чу|цу)в?а?е?(?:ме|т)|ke\\s+si\\s+pis(?:uva?)?e?(?:me|at)|ke\\s+se\\s+ch?uv?a?e?(?:me|at))';

/** End/stop/pause the conversation: морам да прекинам/паузирам, морам да
 *  тргнам, треба да заминам, stop. "prekina" covers the client spelling
 *  (prekina/prekinam/prekinuvam share the prek- stem). */
export const EXIT_END_L = '(?:морам\\s+да\\s+прекин(?:ам|ем|и|ина)|морам\\s+да\\s+тргнам|морам\\s+да\\s+паузирам|треба\\s+да\\s+заминам|треба\\s+да\\s+тргнам|prekin(?:a|am|e|uva[mw]?|i)\\b|pauziram\\b|stop\\b)';

/** OFFER/choice frame veto — "predomisliv sum, gi sakam drugite" is property
 *  traffic, not an exit. Word-boundary-guarded against the \p{L} class. */
export const EXIT_OFFER_VETO_L = '(?:понуд|ponud|опци|opcii?|стан\\w*|stan\\w*|куќ\\w*|kukj?\\w*|имот\\w*|imot\\w*|евра|evra|денари|denari|кириј|kirij|first|prvi|vtor|втор)';

export function buildExitCheckSlots(): RegExp {
  const atom = '(' + EXIT_PREDOMISLIV_L + '|' + EXIT_CONTACT_LATER_L + '|' + EXIT_END_L + ')';
  // A pure burst may carry soft fillers; anything else must sit within the
  // same 40-char window as the trigger ("se predomisliv, ke si piseme").
  return new RegExp(
    '(?:^' + atom + '(?:[^?\\n]{0,40}$)'
    + '|^.{0,40}' + atom + '[^?\\n]{0,40}$'
    + '|^' + atom + '$'
    + ')',
    'iu');
}

// ══════════════════════════════════════════════════════════════════════════════
//  FLEXIBLE LOCATION — "anywhere" / "any neighbourhood"
// ══════════════════════════════════════════════════════════════════════════════
// The discovery funnel asks "во кој дел од градот / во која населба?" and the
// client releases the criterion. Enumerating the sentences people actually
// typed always lags: the [23:47] capture answered "NEBITNO KADE" and the
// [23:48] one "BILO KOJA" (the noun ELIDED) — both were unread, so the funnel
// asked the same question twice. This is a GRAMMAR, not a phrase list:
//
//   ADV                          секаде / било каде / каде и да е / во секој дел
//   BILO + WH (+ PLACE_NOUN)     било која [населба]
//   WH + BILO (+ PLACE_NOUN)     која било [населба]
//   WH + И ДА Е (+ PLACE_NOUN)   која и да е [населба]
//   PRED (+ PLACE_NOUN)          не ми е битно / нема врска / сеедно + каде
//   PRED alone                   NEBITNO / SEEDNO / свеедно
//
// The PLACE_NOUN slot includes the wh-adverbs (каде/кај/где) because
// "не ми е битно каде" and "во која населба" are the same answer shape.
const ANY_LOC_ADV = [
  'било каде', 'било кај', 'било где', 'каде било', 'кај било', 'где било',
  'каде и да е', 'кај и да е', 'где и да е', 'каде да е', 'кај да е', 'где да е',
  'секаде', 'насекаде', 'по цел град', 'низ цел град', 'во целиот град',
  'по целиот град', 'низ целиот град', 'во секој дел', 'во секоја населба',
  'во секое место', 'секоја населба', 'секој дел', 'секое место',
];
const ANY_LOC_ADV_L = [
  'bilo kade', 'bilo kaj', 'bilo gde', 'kade bilo', 'kaj bilo', 'gde bilo',
  'kade i da e', 'kaj i da e', 'gde i da e', 'kade da e', 'kaj da e', 'gde da e',
  'sekade', 'nasekade', 'po cel grad', 'niz cel grad', 'vo celiot grad',
  'vo sekoj del', 'vo sekoja naselba', 'sekoja naselba', 'sekoj del',
  'anywhere', 'any area', 'wherever',
];
const ANY_LOC_NOUN = [
  'населба', 'населби', 'населбата', 'населбите', 'дел', 'делот', 'општина',
  'општината', 'локација', 'локацијата', 'место', 'местото', 'кварт', 'квартот',
  'маало', 'маалото', 'град', 'градот', 'каде', 'кај', 'где',
];
const ANY_LOC_NOUN_L = [
  'naselba', 'naselbi', 'naselbata', 'naselbite', 'del', 'delot', 'opstina',
  'opstinata', 'lokacija', 'lokacijata', 'mesto', 'mestoto', 'kvart', 'kvartot',
  'maalo', 'maaloto', 'grad', 'gradot', 'kade', 'kaj', 'gde',
];
// Wh-words across the dialects that actually reach the feed: Macedonian
// кој/која/кое/кои, the Serbian-influenced које/koje, and the eastern куд/kud
// ("куд год", "било куд").
const ANY_WH = ['кој', 'која', 'кое', 'кои', 'које', 'куд'];
const ANY_WH_L = ['koj', 'koja', 'koe', 'koi', 'koje', 'kud'];
/** "Dismissal" predicates — the criterion is released, not named. */
const ANY_PRED = [
  'не ми е битно', 'не ми е важно', 'не ми е гајле', 'не ми е грижа',
  'не е битно', 'не е важно', 'нема врска', 'сеедно', 'сеедно ми е',
  'свеедно', 'се е едно', 'се е еднакво', 'сеедно е', 'не сум ограничен',
  'не сме ограничени', 'не сум врзан', 'без ограничување', 'без ограничувања',
  'без преференца', 'без преференции', 'каде сакаш', 'каде сакате',
  // Dialect / Serbian-influenced spellings seen in Skopje chat traffic:
  'свеједно', 'свеједно ми е', 'није битно', 'није важно', 'како год',
  'где год', 'куд год', 'било куд', 'се једно', 'све едно',
];
const ANY_PRED_L = [
  'ne mi e bitno', 'ne mi e vazno', 'ne mi e gajle', 'ne mi e grizha',
  'ne e bitno', 'ne e vazno', 'nema vrska', 'seedno', 'seedno mi e',
  'sveedno', 'se e edno', 'se e ednakvo', 'ne sum ogranicen',
  'ne sme ograniceni', 'bez ogranicuvanje', 'bez preferenca',
  'kade sakas', 'kade sakate',
  'svejedno', 'svejedno mi e', 'nije bitno', 'nije vazno', 'kako god',
  'gde god', 'kud god', 'bilo kud', 'se jedno', 'sve edno',
];
/** The bare dismissal — a one-word ANSWER ("NEBITNO", "SEEDNO", "BILO KOJA"). */
const ANY_PRED_BARE = ['небитно', 'nebitno', 'сеедно', 'seedno', 'свеедно', 'sveedno', 'се едно', 'se edno',
  'свеједно', 'svejedno', 'се једно', 'sve jedno', 'све едно',
  // Phrase releases that need no place noun: "није битно", "како год",
  // "где год", "било где". They are the same ANSWER shape as NEBITNO.
  'није битно', 'nije bitno', 'није важно', 'nije vazno', 'како год', 'kako god',
  'где год', 'gde god', 'куд год', 'kud god', 'било где', 'bilo gde', 'нее битно', 'nee bitno'];
/**
 * The ONE-KEY TYPO class for the bare dismissal ("nebitnno", "seadno",
 * "sveednо" with a Cyrillic о). fuzzyHasToken allows edit distance 1 on a
 * single token, both scripts; the caller's criterion guard still applies, so a
 * typo of "nebitno" beside a size/price word keeps its own lane.
 */
export const ANYWHERE_TYPO_TOKENS = ['небитно', 'сеедно', 'свеедно', 'свеједно'];

/** Anything that NAMES where (the adverb / the wh+било + place noun / the
 *  predicate + place noun). Self-sufficient — no criterion guard needed. */
export function buildAnywhereSlots(): RegExp {
  const ADV = or([...ANY_LOC_ADV, ...ANY_LOC_ADV_L]);
  const WH = or([...ANY_WH, ...ANY_WH_L]);
  const NOUN = or([...ANY_LOC_NOUN, ...ANY_LOC_NOUN_L]);
  const BILO = or(['било', 'bilo']);
  const IDA = or(['и да е', 'i da e', 'да е', 'da e']);
  const PRED = or([...ANY_PRED, ...ANY_PRED_L]);
  // The predicate may GOVERN the place noun through a preposition:
  // "не сум ограничен НА населба", "nema vrska ZA gradot". Optional, because
  // "не ми е битно каде" has none — the wh-adverb is already in NOUN.
  const PREP = opt(`${or(['на', 'за', 'со', 'во', 'na', 'za', 'so', 'vo'])}${WS}`);
  // Blanket quantifiers + any place noun: "во секоја општина", "по цел град",
  // "низ целиот град", "во секое маало" — generated, so a noun we never listed
  // with a quantifier still lands.
  const EVERY = `${or(['во', 'по', 'низ', 'vo', 'po', 'niz'])}${WS}${or(['секој', 'секоја', 'секое', 'цел', 'целиот', 'целата', 'sekoj', 'sekoja', 'sekoe', 'cel', 'celiot', 'celata'])}${WS}${NOUN}`;
  return new RegExp(
    ADV
    + `|${EVERY}`
    + `|${BILO}${WS}${WH}${WS}${NOUN}`
    + `|${WH}${WS}${BILO}${WS}${NOUN}`
    + `|${WH}${WS}${IDA}${WS}${NOUN}`
    + `|${PRED}${WS}${PREP}${NOUN}`
    + `|${NOUN}${WS}${or(['не е битна', 'не е важна', 'ne e bitna', 'ne e vazna'])}`,
    'iu');
}

/** The bare dismissal, noun elided: "NEBITNO", "SEEDNO", "BILO KOJA",
 *  "KOJA BILO", "НЕ МИ Е БИТНО". The caller guards by the criterion the
 *  dismissal NAMES ("небитно колку соби" is a SIZE waive, "bilo koja kukja"
 *  is the TYPE) — this builder deliberately cannot tell them apart. */
export function buildAnywhereBareSlots(): RegExp {
  const WH = or([...ANY_WH, ...ANY_WH_L]);
  const BILO = or(['било', 'bilo']);
  const PRED = or([...ANY_PRED_BARE, 'не ми е битно', 'не ми е важно', 'не ми е гајле',
    'ne mi e bitno', 'ne mi e vazno', 'ne mi e gajle', 'нема врска', 'nema vrska',
    'се е еднакво', 'se e ednakvo',
    // blanket releases: "не сум ограничен", "без ограничување/преференца" —
    // a criterion noun in the same message (квадратура, цена…) still trips the
    // caller's guard, so "не сум ограничен на квадратура" stays a size waive.
    'не сум ограничен', 'ne sum ogranicen', 'не сме ограничени', 'ne sme ograniceni',
    'без ограничување', 'без ограничувања', 'bez ogranicuvanje',
    'без преференца', 'без преференции', 'bez preferenca']);
  return new RegExp(`${BILO}${WS}${WH}|${WH}${WS}${BILO}|${PRED}`, 'iu');
}

// ══════════════════════════════════════════════════════════════════════════════
//  PRACTICE DISAPPROVAL — the client rejects the FEE MODEL, not a property
// ══════════════════════════════════════════════════════════════════════════════
// [23:12] "NE MI SE DOPAGJA VAKOV PRINCIP NA RABOTA". Grammar: a DISLIKE verb
// plus a POLICY noun in the same clause, either order. A dislike of the
// PROPERTY ("ne mi se dopagja stanot") names no policy noun, and the POLICY
// ASSERTION ("тоа се вашите правила") is the fee.rules explanation — neither
// is resistance, so the noun slot is what separates them.
const PRACTICE_DISLIKE_VERB = [
  'не ми се допаѓа', 'не ми се допадна', 'не ми се свиѓа', 'не ми се свидна',
  'не ми одговара', 'не ми е ок', 'не ми чини', 'не ми се бендисува',
];
const PRACTICE_DISLIKE_VERB_L = [
  'ne mi se dopagja', 'ne mi se dopaga', 'ne mi se dopadna', 'ne mi se svigja',
  'ne mi se svigna', 'ne mi odgovara', 'ne mi e ok', 'ne mi cini', 'ne mi se bendisuva',
];
const PRACTICE_POLICY_NOUN = [
  'принцип', 'работа', 'пристап', 'политик', 'правил', 'услов', 'начин',
  'пракса', 'деловник', 'протокол',
];
const PRACTICE_POLICY_NOUN_L = [
  'princip', 'rabota', 'pristap', 'politik', 'pravil', 'uslov', 'nacin',
  'praksa', 'delovnik', 'protokol',
];

// ══════════════════════════════════════════════════════════════════════════════
//  FEE VALUE COMPLAINT — the predicate word class for "this fee is worthless"
// ══════════════════════════════════════════════════════════════════════════════
// detectFeeNag's family 4 (a VALUE complaint) reads THIS class, so a dialect a
// capture surfaces is one entry here and every caller inherits it — no new
// branch anywhere. Two shapes, and the difference is deliberate:
//
//   • STEMS — a family with productive inflection: бесмислица / бесмислено /
//     бесмислени, апсурд / апсурдно, срамота / срамно / срамотен, изнудување,
//     рекет / рекетари. The stem is safe because no other intent starts there.
//   • TOKENS — a form whose stem would swallow a DIFFERENT intent. "скупо" and
//     the dialect "купо" must not match "купив стан" (a 'куп' stem would), and
//     "скапи станови по 1.000 евра" is a PROPERTY-price complaint: only the
//     exact "скапо"/"скупо" token may fire the fee lane, and only when the
//     visit/fee object (or the fee-sized arm) anchors it.
//
// The Latin entries are not redundant: "scapo" (the common c-for-k typing)
// normalises to "сцапо", not "скапо", so the caller tests this class against
// the RAW text as well.
const FEE_VALUE_TOKEN = [
  'скапо', 'скупо', 'купо', 'скапичко', 'skapo', 'scapo', 'skupo', 'kupo', 'skapicko',
];
const FEE_VALUE_STEM = [
  'глупост', 'безобраз', 'превисок', // carried here from the original list
  'бесмисл', 'апсурд', 'нелогич', 'срамот', 'изнуд', 'рекет',
];
const FEE_VALUE_STEM_L = [
  'glupost', 'bezobraz', 'previsok',
  'besmislen', 'apsurd', 'nelogic', 'sramot', 'iznud', 'reket',
];
const FEE_VALUE_PHRASE = [
  'многу', 'премногу', 'не е во ред', 'не е нормално', 'не е фер', 'зарем не',
  'није у реду', 'није фер', 'нема логика', 'нема смисла', 'не вреди',
  'nema logika', 'nema smisla', 'ne vredi', 'nije u redu', 'nije fer',
];

/** True for a VALUE complaint about the fee (family 4 of detectFeeNag).
 *  Boundary-guarded tokens, inflected stems, both scripts. The caller decides
 *  whether a value word is about the FEE (visit/fee object or a fee-sized
 *  figure) — this builder deliberately cannot tell that apart. */
export function buildFeeValueComplaintSlots(): RegExp {
  const stems = [...FEE_VALUE_STEM, ...FEE_VALUE_STEM_L].map(w => `${w}\\p{L}*`);
  return new RegExp(or([...FEE_VALUE_TOKEN, ...FEE_VALUE_PHRASE, ...stems]), 'iu');
}

/** True for "I dislike the way you work / this principle / your approach". */
export function buildFeePracticeDislikeSlots(): RegExp {
  // STEM + any inflection, not the bare stem: or() boundary-guards every
  // alternative, so a bare 'политик' could never match "политика" (the trailing
  // 'а' fails the lookahead) and 'не ми е ок оваа политика' was missed.
  const inflected = (words: string[]) => words.map(w => `${w}\\p{L}*`);
  const V = or([...inflected(PRACTICE_DISLIKE_VERB), ...inflected(PRACTICE_DISLIKE_VERB_L)]);
  const N = or([...inflected(PRACTICE_POLICY_NOUN), ...inflected(PRACTICE_POLICY_NOUN_L)]);
  return new RegExp(
    `${V}[^.!?\\n]{0,60}${N}|${N}[^.!?\\n]{0,60}${V}`,
    'iu');
}
