import { Service, State, Event } from '../fsm/machine';
import { locMatches, normalizeLocation } from '../data/properties';
import { OwnerVerdict } from '../backoffice/ownerAgent';
import { normalizeMc } from './normalize';
import { AVAILABILITY_LEXICON, toRegexAlt } from './morphology';
import { buildAvailabilitySlots, buildVisitSlots, buildSeenSlots } from './grammar';

/** Dual-chance regex test: the raw text first, then the normalized
 *  (Latin→Cyrillic) form. New Cyrillic-only regex branches automatically cover
 *  every Latin phrasing — no dual-script alternations needed anymore.
 *  Raw text keeps priority so place-name extraction stays in the client's
 *  original script (POI names are often Latin-scripted). */
function matchesBoth(re: RegExp, text: string): boolean {
  return re.test(text) || re.test(normalizeMc(text));
}

// LLM-independent intent/slot extraction. When every LLM is down (or the model
// says STAY), these deterministic rules still pull service, bedrooms and budget
// out of the client's text — location comes from the feed's neighborhoods
// (see PropertyService.matchLocation). This keeps the discovery->presentation
// path alive without any LLM.

export interface DetectedSlots {
  service?: Service;
  location?: string;   // filled by the caller (needs the feed's neighborhoods)
  bedrooms?: number;
  sqm?: number;        // commercial spaces: size instead of bedrooms
  business?: boolean;  // деловен простор / канцеларија / локал
  house?: boolean;     // куќа — a residential request that is NOT a стан
  budget?: string;     // canonical digits, e.g. "80000"
  anywhere?: boolean;  // "било каде" — no location preference (satisfies location)
  need?: boolean;      // a bare "ми треба стан" without any extracted detail
  rejected?: boolean;
}

// Latin spellings included — Macedonian clients type in Latin more often than Cyrillic.
// The noun forms („купување“/„изнајмување“) are included too — they are the
// exact answers to the intent question („за купување или за изнајмување?“),
// in both scripts (clients type "ZA KUPUVANJE" as often as Cyrillic).
const BUY_RE = /(купува|купам|купи|купн|куп|продажба|продава|\bbuy\b|kupuvam|kupam|kupan|kupi|kupn|kupuvanje|kupuvanjе|prodazba|prodava)/i;
const RENT_RE = /(изнајмува|изнајмам|изнајми|изнајм|кирија|под кирија|кирја|под кирја|издава|издад|\brent\b|iznajmuvam|iznajmam|iznajmi|iznajm|iznajmuvanje|iznajmuvanjе|kirija|pod kirija|krija|pod krija|izdava|izdad)/i;

const BED_NUM_RE = /(\d+)[-\s]*(?:спални|спална|соби|соба|спа|собен|собни|sob|sobi|soben|sobni|spalni|spalna)/i;
// Bedroom-specific words (need +1 to convert to room count)
const BED_ONLY_RE = /(?:спални|спална|spalni|spalna)/i;
// Word-form room/bedroom counts, both scripts. The feed stores ROOM COUNT
// in the `bedrooms` field ("2-собен" → bedrooms: 2), so the slot must map
// to room count, not bedroom count.
//
// Macedonian apartment naming: rooms = bedrooms + living room
//   двособен (2-room) = 1 bedroom + 1 living room
//   трисобен (3-room) = 2 bedrooms + 1 living room
//
// Therefore: "спални" (bedrooms) needs +1 to convert to room count.
// "соби" (rooms) and "собен" (room-type) map directly.
const BED_WORDS: Array<[RegExp, number]> = [
  // Room-type words → room count (direct match to feed)
  [/(еднособен|еднособна|ednosoben|ednosobna)/i, 1],
  [/(двособен|двособна|dvosoben|dvosobna)/i, 2],
  [/(трисобен|трисобна|trisoben|trisobna)/i, 3],
  [/(четирисобен|четирисобна|cetirisoben|cetirisobna|chetirisoben|chetirisobna)/i, 4],
  // Room-count words → room count (direct match to feed)
  [/(една\s+соба|edna\s+soba)/i, 1],
  [/(две\s+соби|dve\s+sobi)/i, 2],
  [/(три\s+соби|tri\s+sobi)/i, 3],
  [/(четири\s+соби|chetiri\s+sobi|cetiri\s+sobi)/i, 4],
  // Bedroom-count words → room count (bedrooms + 1, since rooms = bedrooms + living room)
  [/(една\s+спална|edna\s+spalna)/i, 2],        // 1 bedroom → 2-room
  [/(две\s+спални|два\s+спални|dve\s+spalni)/i, 3],  // 2 bedrooms → 3-room
  [/(три\s+спални|tri\s+spalni)/i, 4],           // 3 bedrooms → 4-room
  [/(четири\s+спални|chetiri\s+spalni|cetiri\s+spalni)/i, 5],  // 4 bedrooms → 5-room
];

const REJECT_RE =
  /(не ми се допаѓа|не ми одговара|не го сакам|не ја сакам|не сакам (овој|оваа|тие|овие|ниту еден)|не ме интересира|нешто друго|друга населба|други опции|ne mi se dopaga|ne mi odgovara|ne go sakam|ne ja sakam|ne sakam|ne me interesira|nesto drugo|druga naselba|drugi opcii|(?:не|ne)\s+(?:барам|baram|сакам|sakam|ми\s+треба|mi\s+treba|ме\s+интересира|me\s+interesira)\s+(?:стан|стана|стани|stan|stana|stani|куќа|кука|kukja|kuka|апартман|apartment)|не\s+е\s+(?:тој|таа|тоа)|ne\s+e\s+(?:toj|taa|toa))/iu;

// "The client SAW a specific property (an ad, on the internet) but gives NO
// number" — "го гледав огласот за стан во Карпош на интернет. дали го имате
// уште?", "тој конкретен стан", "кој стан беше?", "може да ми кажете кој
// стан?". This is NOT a fresh search — Lina must ask for the Евидентен број
// first, then help find the property by details (населба/цена/квадрати).
// Latin + Cyrillic; the first message of the funnel must never dead-end in idle.
const SEEN_PROPERTY_RE =
  /(го\s+(?:гледав|видов|видев)|(?:гледав|видов|видев)\s+(?:оглас|стан|имот)|оглас(?:от)?\s+за|тој\s+конкретен\s+стан|конкретниот\s+стан|кој\s+стан\s+беше|која\s+(?:е|беше)\s+(?:таа|ова)|може\s+да\s+ми\s+кажете\s+кој|кој\s+е\s+тој\s+стан|(?:гледав|видов|видев)[^.!?\n]{0,30}на\s+интернет|go\s+(?:gledav|vidov|videv)|(?:gledav|vidov|videv)\s+(?:oglas|stan|imot)|oglas(?:ot)?\s+za|toj\s+konkreten\s+stan|konkretniot\s+stan|koj\s+stan\s+bese|koja\s+(?:e|bese)\s+(?:taa|ova)|moze\s+da\s+mi\s+kazete\s+koj|koj\s+e\s+toj\s+stan|(?:gledav|vidov|videv)[^.!?\n]{0,30}na\s+internet)/iu;

// Grammar-built slot regex — catches reversed word orders and definite forms
// ("станот видов", "ovoj stan gledav").
const _seenSlotsRe = buildSeenSlots();

/** True when the client references a SPECIFIC property they saw, without a number. */
export function detectSeenProperty(text: string): boolean {
  if (SEEN_PROPERTY_RE.test(text)) return true;
  // Grammar slot check: reversed word orders (object-first), definite forms
  return matchesBoth(_seenSlotsRe, text);
}

// Mid-discovery the client asks to SEE offers before the criteria are complete:
// "што имате во понуда?", "sto imate?", "помало нешто", "покажи ми". Lina
// must ANSWER with real DB offers (smallest м² first, area-locked) instead of
// repeating the missing question. Latin + Cyrillic. "што имаш во Карпош?" (a
// location search) is NOT this — the text after имаш/имате breaks the anchor.
const SEE_OFFERS_RE =
  /(што\s+(?:имаш|имате|има)\s+(?:во\s+|на\s+)?понуда|што\s+(?:имаш|имате|има)\s+(?:на\s+)?(?:лагер|залиха)|sto\s+(?:imas|imate)\s+(?:vo\s+|na\s+)?ponuda|sto\s+(?:imas|imate)\s+(?:na\s+)?(?:lager|zaliha)|помало\s+нешто|нешто\s+помало|покажи\s+ми|имате\s+ли\s+нешто|имаш\s+ли\s+нешто|pomalo\s+nesto|pokazi\s+mi|imate\s+li\s+nesto|imas\s+li\s+nesto|(?:што|sto)\s+(?:имаш|имате|imas|imate)\s*\??$|asto\s+po(?:e|е)ftin|најефтино|naj(e|е)ftino|што\s+е\s+најефтино|колку\s+е\s+најевтин|bilo\s+kolku|било\s+колку|билоколку|bilo\s+kolkube|било\s+колку\s+бе|spalnite\s+ne\s+se\s+tolku\s+bitni|спалните\s+не\s+се\s+толку\s+битни|не\s+се\s+битни\s+спалните|ne\s+se\s+bitni\s+spalnite)/iu;

/** True when the client asks to see current offers mid-collection. */
export function detectSeeOffers(text: string): boolean {
  return SEE_OFFERS_RE.test(text);
}

// Availability question about a KNOWN property: "дали е сеуште достапен?",
// "dali e seuste dostapen?", "дали го имате уште?", "дали е продаден?",
// "сеуште ли е на продажба?". The client saw the ad on the website and knows
// the details — Lina must NOT re-describe the property; she answers the
// availability ack (bank-backed), asks the fee, and only after the fee is
// agreed starts the owner ping-pong (availability + price are the owner's
// truth). Latin + Cyrillic. "дали е достапен 82?" is included — the number
// supplies the propertyId and the same availability funnel fires.
const AVAILABILITY_ASK_RE =
  /(дали[^.!?\n]{0,40}(?:достапен|достапна|достапно|остапен|остапна|слободен|слободна|слободно|слободна|слободно|продаден|продадена|издаден|издадена|на продажба|на prodazba|постои|го имате уште|ја имате уште)|достапен\s+ли\s+е|достапна\s+ли\s+е|слободен\s+ли\s+е|слободна\s+ли\s+е|продаден\s+ли\s+е|издаден\s+ли\s+е|сеуште\s+(?:ли\s+)?(?:е\s+)?(?:достапен|достапна|слободен|на продажба)|(?:е|е\s+ли)\s+(?:слободен|слободна|слободно|достапен|достапна|достапно)|(?:го|ја)\s+имате\s+(?:ли\s+)?(?:уште|сеуште)|(?:уште|сеуште)\s+(?:ли\s+)?(?:го|ја)\s+имате|(?:go|ja)\s+imate\s+(?:li\s+)?(?:uste|seuste)|(?:uste|seuste)\s+(?:li\s+)?(?:go|ja)\s+imate|daa?[il][il][^.!?\n]{0,40}(?:dostapen|dostapna|dostapno|ostapen|ostapna|sloboden|slobodna|slobodno|prodaden|prodadena|izdaden|izdadena|na prodazba|postoi|go imate uste|ja imate uste|za prodavanje|za prodazba|na prodazba|se prodava|prodavate|prodava li)|dostapen\s+li\s+e|dostapna\s+li\s+e|sloboden\s+li\s+e|slobodna\s+li\s+e|prodaden\s+li\s+e|izdaden\s+li\s+e|seuste\s+(?:li\s+)?(?:e\s+)?(?:dostapen|dostapna|sloboden|na prodazba)|(?:e|e\s+li)\s+(?:sloboden|slobodna|slobodno|dostapen|dostapna|dostapno))|остапен\s+ли\s+е|остапна\s+ли\s+е|ostapen\s+li\s+e|ostapna\s+li\s+e|на\s+продажба\s+ли\s+е|се\s+продава\s+ли|продава\s+ли\s+е|на\s+prodazba\s+li\s+e|se\s+prodava\s+li|prodava\s+li\s+e|za\s+prodazba\s+li\s+e/iu;

// Morphology-generated availability forms — catches inflected variants
// the main regex doesn't enumerate (достапниот, продадена, продавање, ...)
const _morphAlt = toRegexAlt(AVAILABILITY_LEXICON);
const AVAILABILITY_MORPH_RE = new RegExp(
  // "дали е достапниот?" — dali + filler + morphology form
  '(?:дали[^.!?\\n]{0,40}(?:' + _morphAlt + '))'
  // "е достапниот ли?" — standalone "е X" or "е X ли"
  + '|(?:е|е\\s+ли)\\s+(?:' + _morphAlt + ')'
  // "го имате достапниот?" — "го/ја + word + (ли +) form"
  + '|(?:го|ја)\\s+\\w+(?:\\s+ли)?\\s+(?:' + _morphAlt + ')',
  'iu',
);

// Grammar-built slot regex — catches reversed word orders the hand-written
// AVAILABILITY_ASK_RE misses ("уште ли го имате?", "го уште имате?").
const _availSlotsRe = buildAvailabilitySlots();

export function detectAvailabilityAsk(text: string): boolean {
  if (AVAILABILITY_ASK_RE.test(text)) return true;
  // Grammar slot check: reversed word orders (clitic mobility, time-adverb movement)
  if (matchesBoth(_availSlotsRe, text)) return true;
  // Morphology secondary check: expanded verb/adjective forms not in the main regex.
  // MUST use matchesBoth() — the morphology regex is Cyrillic-only and the
  // i flag doesn't cross scripts (Latin 'A' ≠ Cyrillic 'а').
  return matchesBoth(AVAILABILITY_MORPH_RE, text);
}

// "Why do you charge for a visit?" — "зошто наплаќате посета?", "зошто
// надомест?", "зошто треба да платам?", "никој не го прави тоа" — the client
// QUESTIONS the fee's existence (in closing), which is NOT a refusal. Lina must
// ANSWER with the agency's rationale (the fee is a filter that recognizes real
// clients, symbolic for serious ones) instead of repeating the fee disclosure
// or burning a persuasion rung. Latin + Cyrillic. "зошто е цената…?" (the
// PROPERTY price) and "зошто е скап…?" are deliberately NOT matched — only
// fee/надомест/посета/платам anchors count.
const FEE_WHY_RE =
  /(зошто|зашто|зоштo|zosto|zashto)[^.!?\n]{0,40}(наплаќате|наплатувате|наплаќа|наплатува|се наплаќа|се наплатува|надомест|надоместок|посетата|посета|naplakjate|naplakate|naplatuvate|naplakja|naplatuva|nadomest|nadomestok|posetata|poseta)|(ником|никому|никој|nikoj|nikomu)[^.!?\n]{0,30}(не го прави|не го прават|го прават|не наплаќа|не наплаќаат|не наплатува|не наплатуваат|ne go pravi|ne go pravat|ne naplakja|ne naplakjaat|ne naplatuva|ne naplatuvaat)|(зошто|зашто|zosto|zashto)[^.!?\n]{0,30}(треба да платам|треба да плаќам|мора да платам|да плаќам|да платам|плаќам|plakjam|plakam|da plakam|da platam)|(како|kako)( тоа| toa)?[^.\n]{0,40}(да платам|да плаќам|плаќам|платам|plakam|platam|plakjam|надомест|надоместок|nadomest|nadomestok|наплаќате|наплаќа|наплатувате|наплатува|се наплаќа|се наплатува|naplakjate|naplakate|naplatuvate|naplakja|naplatuva|se naplakja|se naplatuva)|(првпат|prv\s*pat|prvi\s*pat)[^.!?\n]{0,40}(слушам|чујам|чул|чуш|slusam|cuvam|cul|slusnal|chuvam)/iu;
// "за што/za sto" — the client asks what the fee is FOR, not why it exists.
// This is a WHY question ("за што ми е потребно ова?") not a refusal.
const FEE_FOR_WHAT_RE = /(?:за\s+(?:што|сто|сто|стó)|за\s+сто|за\s+wхат|фор\s+wхат)/iu;
// "kako 500 den" — client questions a specific fee amount. Any combination
// of како/кoа + number + den/denari/euro/evra is a WHY question.
const FEE_AMOUNT_RE = /(?:како|како|која|која)[^.!?\n]{0,30}\d[^.!?\n]{0,20}(?:ден|денар|евр|еур|дин|динари|евра|еуро)/iu;

export function detectFeeWhy(text: string): boolean {
  // Normalize: join multi-line bursts into one line so cross-line patterns work
  const flat = text.replace(/\n/g, ' ');
  return FEE_WHY_RE.test(flat) || matchesBoth(FEE_FOR_WHAT_RE, flat) || matchesBoth(FEE_AMOUNT_RE, flat);
}

// Price complaints about the viewing fee ("скупо", "500 денари за посета?", "50
// станови за 25000 ден"). The client isn't REFUSING — they're questioning the
// value/price of the fee itself. These should get the fee.why rationale (the
// fee is a filter for real clients, symbolic for serious ones), NOT the refusal
// ladder that pivots to alternative properties. Latin + Cyrillic.
const FEE_COMPLAINT_RE = /(?:(?:скуп|скап|надомест)\w*|(?:надомест|посета|платим|плаќам|платам)(?:.*?(?:скуп|скап|неприступн|премал|повеќе|недостат))|(?:5\d{2}|3\d{2})\s*(?:ден|денар|евр|еура|мкд|denari).*?(?:скуп|скап|повеќе|неприступн)|(?:50\s+стан|стан.*50|50.*стан).*(?:\d+\s*(?:ден|денар|евр|мкд))|надомест.*(?:\d+)\s*(?:денари).*?(?:скуп|скап|повеќе|непостиг))/iu;
// Also catch direct price-complaint markers: the fee amount + "too expensive"
const FEE_PRICE_COMPLAINT_RE = /(?:(?:500|300)\s*(?:денари|ден|мкд|mkd|ден\.))[^.!?\n]{0,60}(?:скуп|скап|неприступн|премал|повеќе|жеш|недостат|nadvoz)/iu;

export function detectFeeComplaint(text: string): boolean {
  const flat = text.replace(/\n/g, ' ');
  return FEE_COMPLAINT_RE.test(flat) || matchesBoth(FEE_PRICE_COMPLAINT_RE, flat);
}

// A position pick among the presented closest matches: "првиот" / "вториот"
// ("да, првиот е тој"). Latin + Cyrillic. "прва" (feminine) is too loose
// ("прва населба"…) — require the -от/-та/-и definite forms.
const LOCATE_PICK_RE = /(првиот|првата|вториот|втората|prviot|prvata|vtoriot|vtorata)/iu;

export function detectLocatePick(text: string): number | undefined {
  const m = text.match(LOCATE_PICK_RE);
  if (!m) return undefined;
  const w = m[0].toLowerCase();
  if (w.startsWith('прв') || w.startsWith('prv')) return 0;
  if (w.startsWith('втор') || w.startsWith('vtor')) return 1;
  return undefined;
}

// A bare need for a place WITHOUT any extracted detail (no service marker, no
// location/bedrooms/budget): "ми треба стан", "MI TREBA STANCE". This must
// still start the funnel — idle -> discovery, where the intent question is
// asked — instead of dead-ending in idle as STAY. Negated forms ("не сакам
// стан") are NOT a need.
const NEED_STAN_RE =
  /(ми\s+треба|треба\s+ми|mi\s+treba|treba\s+mi|барам|baram|сакам|sakam|имаш\s+ли|imas\s+li|требаат|trebaat|need)[^.!?\n]{0,30}(стан|станче|стани|stan|stance|stani|куќа|кука|kukja|kuka|апартман|apartment)/i;
const NEED_NEGATION_RE = /(не|не)\s+(ми\s+треба|треба\s+ми|барам|барам|сакам|сакам|имаш\s+ли|имас\s+ли)/i;

export function detectApartmentNeed(text: string): boolean {
  if (matchesBoth(NEED_NEGATION_RE, text)) return false;
  return NEED_STAN_RE.test(text);
}

// "ми треба стан" / "барам стан" / "сакам стан" WITHOUT an explicit buy or
// rent marker must stay UNKNOWN — Lina asks "за купување или за изнајмување?"
// instead of putting words in the client's mouth ("MI TREBA STANCE" is NOT a
// buy statement). Only explicit markers decide.
export function detectService(text: string): Service | undefined {
  const b = text.search(BUY_RE);
  const r = text.search(RENT_RE);
  if (b >= 0 && (r < 0 || b < r)) return 'buy';
  if (r >= 0) return 'rent';
  return undefined;
}

// "мало станче" / "гарсоњера" / "студио" is a 1-bedroom request — only when
// no explicit bedroom was mentioned (explicit numbers/words win). Latin and
// Cyrillic variants (clients type "MALO STANCE" more often than "мало станче").
const SMALL_STAN_RE = /(мал[оаи]?\s+(стан|станче|стани)|мал[оа]?\s+(стан|станце|стани)|гарсоњера|гарсоњера|студио|студио)/i;

export function detectBedrooms(text: string): number | undefined {
  const m = text.match(BED_NUM_RE);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 6) {
      // "2 spalni" = 2 bedrooms → 3-room; "2 sobi" = 2 rooms → 2-room
      const isBedroomWord = BED_ONLY_RE.test(m[0]);
      return isBedroomWord ? n + 1 : n;
    }
  }
  for (const [re, n] of BED_WORDS) {
    if (re.test(text)) return n;
  }
  if (matchesBoth(SMALL_STAN_RE, text)) return 1;
  return undefined;
}

/**
 * Budget = the highest figure mentioned (with currency context, >= 1000, or a
 * cap word before it — "до 250" / "околу 250" / "под 250" is a rent price or
 * budget cap even without currency, so "bilo kade do 250" becomes budget 250
 * and is never misread as an Евидентен број). "2 спални" or a bare "78" still
 * never becomes a budget. "80 илјади" → 80000.
 */
export function detectBudget(text: string): string | undefined {
  // Strip phone numbers first — "078/914 196" must never glue into "914196".
  const cleaned = text.replace(/\b0\d{1,2}\s*[/.]\s*\d{2,4}(?:\s*\d{2,4})?\b/g, ' ');
  // Cyrillic AND Latin currency spellings — clients type "500 EVRA" in Latin
  // far more often than "евра"; /i does NOT fold Latin E into Cyrillic е.
  // A CAP WORD before the number (до/околу/под/do/okolu/oko/pod — "up to /
  // around / under") marks a PRICE even without currency: "bilo kade do 250"
  // is a rent budget of 250, so the 250 is never misread as an EB. The
  // lookbehind is Unicode-aware (JS \b never binds around Cyrillic — "до 250"
  // after "каде" would otherwise never match) and blocks glued words ("здо").
  const re = /(?<![\p{L}\p{N}])((?:до|околу|под|do|okolu|oko|pod)\s+)?(\d[\d\s.,]*)\s*(илјади|хилјади)?\s*(евра|евро|evra|evro|eur|€)?/giu;
  let m: RegExpExecArray | null;
  let bestN = 0;
  while ((m = re.exec(cleaned)) !== null) {
    const capped = !!m[1];
    const digits = m[2].replace(/[\s.,]/g, '');
    let n = parseInt(digits, 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (m[3]) n *= 1000; // "80 илјади" -> 80000
    const hasCur = !!m[4];
    // 1900-2100 without currency is a construction year, not a budget
    if (n >= 1900 && n <= 2100 && !hasCur) continue;
    // Cap-prefixed figures need a sanity floor ("до 3 соби" is bedrooms, not a
    // budget) but no currency — "до 250" is a rent price in a rent funnel.
    if ((n >= 1000 || hasCur || (capped && n >= 100)) && n > bestN) bestN = n;
  }
  return bestN > 0 ? String(bestN) : undefined;
}

// "било каде" / "bilo kade" / "каде било" / "секаде" / "anywhere" — the
// client has NO location preference. This SATISFIES the location criterion
// (the funnel stops asking "кој дел од градот?") and the presentation spans
// the whole city, ordered from the most popular neighborhoods (Центар,
// Капиштец, Карпош, Аеродром, Кисела Вода, Влае, Ѓорче Петров, then the
// rest). Latin + Cyrillic.
const ANYWHERE_RE = /(било\s+каде|било\s+кај|било\s+где|каде\s+било|кај\s+било|где\s+да\s+е|каде\s+да\s+е|секаде|не\s+е\s+битно\s+каде|не\s+е\s+важно\s+каде|није\s+битно\s+где|није\s+важно\s+где|не\s+ми\s+е\s+битно|не\s+ми\s+е\s+важно|не\s+ми\s+е\s+гајле|било\s+каде|било\s+кај|било\s+где|каде\s+било|кај\s+било|каде\s+да\s+e|где\s+да\s+e|секаде|не\s+e\s+битно\s+каде|не\s+e\s+важно\s+каде|ние\s+је\s+битно\s+где|ние\s+је\s+важно\s+где|не\s+ми\s+e\s+битно|не\s+ми\s+e\s+важно|не\s+ми\s+e\s+гајле|анywхере)/iu;

/** True when the client says "anywhere" — no location preference. */
export function detectAnywhere(text: string): boolean {
  return matchesBoth(ANYWHERE_RE, text);
}

// The client asks for ALTERNATIVE suggestions — "predlozi mi", "drugi
// lokaciii", "pokazi drugi", "други предлози" — typically answering the
// not-found line ("Дали би сакале да Ви предложам слични имоти од други
// локации?") or asking for other options after disliking the current one. In
// property_query this must PIVOT to a real city-wide presentation, never
// repeat the not-found line (the stuck loop: every "predlozi mi" re-rendered
// "не можам да го најдам имотот со Евидентен број 250"). Latin + Cyrillic.
const SUGGEST_ALTERNATIVES_RE =
  /(предложи ми|предложете ми|предложи|предложете|sugeri|сугерирај|сугерирате|sugeriraj|predlozi mi|predlozete mi|predlozi|predlozete|други локации|друга локаци|drugi lokacii|drugi lokaciii|drugi lokacija|druga lokaci|други предлози|drugi predlozi|покажи други|pokazi drugi|покажете други|pokazete drugi|нешто друго|друго нешто|nesto drugo|неколку други|некои други|имаш ли други|имате ли други|imas li drugi|imate li drugi|дали имате други|dali imate drugi|на друго место|во друго место|на другa локаци|во другa локаци|na drugo mesto|vo drugo mesto|drugo mesto|druga lokacija|на друг реон|во друг реон|на друг дел|во друг дел|na drug reon|vo drug reon|drugi reon|drugi del|нешто на друго|nesto na drugo|kazi mi drugo|кажи ми друго|kazi mi vo drugo|кажи ми во друго|што имате на друго|shto imate na drugo|што имате во друго|shto imate vo drugo|da mi kazes za drugo|да ми кажеш за друго|isto e skapo|исто е скапо|пак е скапо|пак скапо|пак e skapo|isto e skapo|isto skapo|istata cena|истата цена|skapa e|скапо е|skapo e|сЀ уште е скапо|сè уште е скапо|previsoko e|превисоко е|mnogu e|многу е|preskapo|прескапо|ne mi odgovara cenata|не ми одговара цената|cenata ne mi odgovara|цената не ми одговара|ne odgovara cenata|не одговара цената|poeftino|поевтино|поефтино|pojeftino)/iu;

/** True when the client asks for alternative suggestions / other options. */
export function detectSuggestAlternatives(text: string): boolean {
  return SUGGEST_ALTERNATIVES_RE.test(text);
}

// "DRUG STAN VO CENTAR" / "друг стан во центар" / "покажи друго" / "нешто друго"
// — the client wants to see OTHER properties or something different, not locate
// a specific one. Must bypass both property_description (property_locate) and
// price_ask (price answer) so the classifier routes it as SEARCH_REQUESTED.
// Covers: друг/drugi + property words, покажи/прикажете + други, нешто друг// 'друг стан', 'drugi stanovi', 'покажи други', 'нешто друго',
// 'поефтино', 'next apartment' — the client wants OTHER properties,
// not locate a specific one. Must bypass property_description and price_ask
// so the classifier routes it as SEARCH_REQUESTED → presentation.
function _isDrugAlt(text: string): boolean {
  const t = text.toLowerCase();
  // Matches: друг/drugi + property words, покажи/прикажете + други,
  // нешто друго, drugo nesto, imate li drugo, поевтино/поефтино,
  // next apartment — ANY pattern meaning "other/another property".
  const hasDrugAlt = /друг(?:и|а|о|ом)?|drugi?|drgo|drugo\s+nesto|друго\s+нешто|нешто\s+друг|nesto\s+drug|покажи\s+други|pokazi\s+drugi|прикажете\s+други|покажете\s+други|имате\s+ли\s+друг|имаш\s+ли\s+друг|imate\s+li\s+drugi?|imas\s+li\s+drugi?|дали\s+имате\s+друг|dale\s+imate\s+drugi|next\s+(?:apartment|property|flat|house|option)|поевтино|поефтино|poftino|pojeftino|drugo\s+mesto|друго\s+место|na\s+drugo\s+mesto|vo\s+drugo\s+mesto|на\s+друго\s+место|во\s+друго\s+место|drugi\s+reon|drugi\s+del|drugi\s+lokaci|друг\s+реон|друг\s+дел|друга\s+локаци|na\s+drugi\s+reon|vo\s+drugi\s+reon|на\s+друг\s+реон|во\s+друг\s+реон/i.test(t);
  if (!hasDrugAlt) return false;
  // Exclude pure price questions: "која е цената", "колку е цената" —
  // these ask for THE price, not alternatives.
  return !/\b(?:koja|колку|kolku|која)\b/i.test(t);
}
/** True when the client asks for OTHER properties or something different. */
export function detectDrugAlternative(text: string): boolean {
  return _isDrugAlt(text);
}


export function detectRejection(text: string): boolean {
  return REJECT_RE.test(text);
}

// Location nagging: after the privacy protocol ("the exact address is shared
// 2 hours before the visit"), the client pushes back with questions like
// "KAKO TOGAS KE ZNAM DALI MI ODGOVARA LOKACIJATA?" — they want to know
// if the general area suits them. Instead of repeating the privacy protocol,
// the bot should reveal the nearby landmark as a compromise.
// Covers: kako/како + togas/тогаш + znamm/знам + lokacija/адреса/kade,
//        kakoto ke znam/kako ke znam, kade ke bide, odgovara li mi,
//        pasam li mi lokacijata, dali mi odgovara, da znam dali kade,
//        kako da znam dali, ke znam dali, za da znam kade,
//        moram da znam kade, kako da odlucam, dali mi odgovara reonot,
//        kade e vo blizina, which neighborhood, which area,
//        dali e vo centar, dali e blizu, kade potocno, and all
//        "kako ... ke znam ... dali ... lokacija/adresa" grammar combos.
/** True when the client is nagging about location suitability after the
 *  privacy protocol — they want to know the general area, not the exact address.
 *  Covers: kako/toгas/ke/znam + lokacija/adresa, dali mi odgovara lokacijata,
 *  moram da znam kade e, kako da odlucam, which area/neighborhood,
 *  dali e vo centar/aerodrom, kade potocno, etc. */
export function detectLocationNag(text: string): boolean {
  // Individual regex tests (can't chain || on .test() outside function)
  return (
    // "како ќе знам дали локацијата ми одговара" — broad match (with optional togas/toga filler)
    /(?:како|kako)\s+(?:тогаш|togas|тога|toga)?\s*(?:ќе|ke|ще|shte)?\s*(?: знам|znam|znaam|знаам)\s+(?:дали|dali|дали)/iu.test(text)
    // "дали ми одговара локацијата" / "дали локацијата ми одговара"
    || /(?:дали|dali|дали)\s+(?:ми\s+)?(?:одговара|odgovara|прилега|prilega|паса|pasa)\s+(?:локација|локацијата|lokacija|lokacijata|адреса|адресата|adresata|реонот|реон|reon|местото|место)/iu.test(text)
    // "дали локацијата е за мене" / "дали ми одговара реонот"
    || /(?:дали|dali|дали)\s+(?:локација|локацијата|lokacija|lokacijata|адреса|адресата|adresata|реонот|реон|reon|местото|место)\s+(?:е|e|е\s+за|e\s+za|ми\s+одговара|ми\s+прилега)/iu.test(text)
    // "како да одлучам каде е" / "како да знам каде е" — generic location uncertainty
    || /(?:како|kako)\s+(?:да|da)\s+(?:одлучам|odlucam|знам|znam)\s+(?:каде|kade|kad|ka[je])\s+(?:е|e|се\s+нао[гѓ]а|se\s+naogja)/iu.test(text)
    // "moram da znam kade e" / "морам да знам каде е"
    || /(?:moram|mora|treba|морам|мора|треба)\s+(?:(?:да|da)\s+)?(?:знам|znam|znaam)\s+(?:каде|kade|kad|ka[je])\s+(?:е|e|се\s+нао[гѓ]а|se\s+naogja)/iu.test(text)
    // "za da znam kade e" / "за да знам каде е"
    || /(?:за\s+да|za\s+da)\s+(?:знам|znam)\s+(?:каде|kade|kad|ka[je])\s+(?:е|e|се\s+нао[гѓ]а|se\s+naogja)/iu.test(text)
    // "koj reon e" / "кој реон е" — asking about which area/neighborhood
    || /(?:кој|koj|која|koja|кое|koe)\s+(?:реон|reon|дел|del|део|deo|локација|lokacija|населба|naselba|област|oblast)\s+(?:е|e|е\s+тоа|е\s+тој|е\s+таа)/iu.test(text)
    // "which neighborhood" / "which area" — English
    || /(?:which|what)\s+(?:neighborhood|area|part|district|location|section|zone)/iu.test(text)
    // "dali e vo blizina" / "дали е во близина" / "dali e blizu" — general proximity check
    || /(?:дали|dali|дали)\s+(?:е|e|стои|stoi|е\s+сместен|е\s+нао[гѓ]а|se\s+naogja)\s+(?:(?:во|vo)\s+)?(?:бли[зж]ина|blizina|бли[зж]у|blizu|центар|centar|аеродром|aerodrom)/iu.test(text)
    // "kade e vo blizina na" / "каде е во близина на" — general proximity
    || /(?:каде|kade|kad|ka[je])\s+(?:е|e|стои|stoi|е\s+сместен)\s+(?:во\s+)?(?:бли[зж]ина|blizina)/iu.test(text)
    // "kade potocno" / "каде поточно"
    || /(?:каде|kade|kad|ka[je])\s+(?:поточно|potocno|точно|tochno|tocno|конкретно|konkretno|посебно|posebno)\s+(?:е|e|се|se|е\s+тоа|е\s+тој)/iu.test(text)
    // "koj del od gradot" / "кој дел од градот" — which part of the city
    || /(?:кој|koj|која|koja|кое|koe)\s+(?:дел|del|део|deo)\s+(?:од|od|на|na)\s+(?:град|grad|градот|gradot)/iu.test(text)
    // "dali e vo centar/aerodrom" — direct area check
    || /(?:дали|dali|дали)\s+(?:е|e)\s+(?:во|vo|на|na)\s+(?:центар|centar|аеродром|aerodrom|водно|vodno|кисела\s+вода|kisela\s+voda|карпош|karpos|чента|centa|лисиче|lisice|ново\s+лисиче|novo\s+lisice|Ѓорче|Gjorce|Ѓорче\s+Петров|Gjorce\s+Petrov)/iu.test(text)
    // "od koj reon e" / "од кој реон е" — which area is it in
    || /(?:од|od|на|na|во|vo)\s+(?:кој|koj|која|koja|кое|koe)\s+(?:реон|reon|дел|del|део|deo|населба|naselba|локација|lokacija|област|oblast)\s+(?:е|e|е\s+тоа|е\s+тој|е\s+таа)/iu.test(text)
    // Broad fallback: lokacija + znaam/odlucam/odgovara/pasa combo
    || /(?:локација|локацијата|lokacija|lokacijata|адреса|адресата|adresata)\s+(?:[а-яА-Яa-zA-Z\s]{0,25})?\s+(?:знам|znam|одлучам|odlucam|одговара|odgovara|погодна|pogodna|соодветна|soodvetna)/iu.test(text)
    // English: "how will I know", "where exactly is it", "which area"
    || /(?:how\s+(?:will|can|do)\s+I\s+know|where\s+exactly\s+is\s+it|which\s+(?:area|neighborhood|part|district)|is\s+it\s+(?:near|in|close))\s*(?:\?|$)/iu.test(text)
    // "kako ke znam" catch-all for the "how will I know" family
    || /(?:како|kako)\s+(?:ќе|ke|ще|shte)?\s*(?:знам|znam|znaam|знаам|одлучам|odlucam|дознаам|doznaam)/iu.test(text)
    // "moram da znam" — must know
    || /(?:moram|mora|treba|морам|мора|треба)\s+(?:(?:да|da)\s+)?(?:знам|znam|znaam|знаам)\s+(?:каде|kade|kad|ka[je]|како|kako)/iu.test(text)
    // "za da znaam" — in order to know
    || /(?:за\s+да|za\s+da)\s+(?:знаам|znaam|знам|znam)\s+(?:каде|kade|kad|ka[je]|како|kako)/iu.test(text)
    // "kako da odlucam" — how to decide
    || /(?:како|kako)\s+(?:да|da)\s+(?:одлучам|odlucam|реширам|resiram|проценам|procenam)/iu.test(text)
    // "dali ke odgovara" — will it suit
    || /(?:дали|dali|дали)\s+(?:ќе|ke|ще|shte)\s+(?:ми\s+)?(?:одговара|odgovara|прилега|prilega|погодува|pogod)/iu.test(text)

    // ===== APPROXIMATE LOCATION: follow-up after privacy protocol =====
    // "ODPRILIKA" / "околу" / "приближно" / "некаде" — the client accepts
    // they won't get the exact address but wants the approximate area.
    // Single-word or short phrase: always show the nearby landmark.
    || /^(?:одприлика|odprilika|отприлике|otprilike)$/iu.test(text)
    || /^(?:приближно|priblizno|приближок|priblizok|поблиску|poblisku)$/iu.test(text)
    || /^(?:околу|okolu|околно|okolno|околината|okolinata)$/iu.test(text)
    || /^(?:некаде|nekade|некојде|nekojde|по некаде|po nekade)$/iu.test(text)
    || /^(?:блиску|blisku|близок|blizok|блиско|blisko)$/iu.test(text)
    || /^(?:од\s+прилика|od\s+prilika|от\s+прилике|ot\s+prilike)$/iu.test(text)
    || /^(?:приближна|priblizna|приближен|priblizen|приближна\s+локација|priblizna\s+lokacija)$/iu.test(text)
    // "одприлика каде" / "околу каде" / "приближно каде" — approximate + location question (exclude price words)
    || /(?:одприлика|odprilika|отприлике|otprilike|приближно|priblizno|околу|okolu|околно|okolno|некаде|nekade|блиску|blisku|блиско|blisko)\s+(?:каде|kade|kad|ka[je]|е|e|се|se)(?!\s+(?:колку|kolku|цената|cenata|цена|cena))/iu.test(text)
    // "okolu kolku e" / "одприлика каде е" — approximate + question (exclude price words)
    || /(?:одприлика|odprilika|отприлике|otprilike|приближно|priblizno|околу|okolu|околно|okolno|некаде|nekade|блиску|blisku|блиско|blisko)\s+(?:каде|kade|колку|kolku|кое|koe|кој|koj|која|koja)(?!\s+(?:е|e)\s+(?:цената|cenata|цена|cena))/iu.test(text)
    // "kade e okolu" / "каде е околу" — where approximately
    || /(?:каде|kade|kad|ka[je])\s+(?:е|e|се\s+нао[гѓ]а|se\s+naogja)\s+(?:околу|okolu|околно|okolno|приближно|priblizno|некаде|nekade|одприлика|odprilika)/iu.test(text)
    // "okolu kade" — approximately where
    || /(?:околу|okolu|околно|okolno|одприлика|odprilika|приближно|priblizno|некаде|nekade)\s+(?:каде|kade|kad|ka[je])\s+(?:е|e|се|se)/iu.test(text)
    // "kade e nekade vo" — where approximately in
    || /(?:каде|kade|kad|ka[je])\s+(?:е|e|се\s+нао[гѓ]а|se\s+naogja)\s+(?:некаде|nekade)\s+(?:во|vo|на|na)/iu.test(text)
    // "blisku do" / "блиску до" — close to
    || /(?:блиску|blisku|блиско|blisko|поблиску|poblisku)\s+(?:до|do|од|od|кон|kon)/iu.test(text)
    // "priblizno vo" / "приближно во" — approximately in
    || /(?:приближно|priblizno|околу|okolu|околно|okolno|некаде|nekade|одприлика|odprilika)\s+(?:во|vo|на|na)/iu.test(text)
    // "kolku e daleku" / "колку е далеку" — how far
    || /(?:колку|kolku|колкуми|kolkumi)\s+(?:е|e)\s+(?:далеку|daleku|оддалечено|oddalecheno|оддалечена|oddalechena)/iu.test(text)
  );
}

// Visit interest: the client wants to SEE the property. In property states
// (property_query/presentation) this is INTERESTED — "кога може да се
// погледне?", "сакам да ја видам", "организирај посета", the bare
// imperatives "договори ми" / "закажи ми" ("ДОГОВОРИ МИ ЗА ОВОЈ СО БРОЈ 89"
// = arrange a visit for 89) and availability questions ("дали е достапен?")
// all mean "I want to visit it". Latin and Cyrillic (clients type "KOGA BI
// MOZELO DA SE POGLEDNE STANOT?" more often than Cyrillic). The negation
// guard keeps "не сакам да ја видам" out.
const VISIT_INTEREST_RE =
  /(кога[^.!?\n]{0,40}(може|би можело|би можела)[^.!?\n]{0,25}(погледн|видам|разгледам|посета)|(сакам|би сакал|би сакала|посакувам)[^.!?\n]{0,40}(погледн|видам|разгледам|посета)|организира(ј|јте)?(?:\s+посета)?|закаж(и|е)(те)?(?:\s+посета)?|дали[^.!?\n]{0,30}достапен|дали[^.!?\n]{0,30}достапна|koga[^.!?\n]{0,40}(moze|bi mozelo|bi mozela)[^.!?\n]{0,25}(pogledn|vidam|razgledam|poseta)|sakam[^.!?\n]{0,40}(da ja vidam|da go vidam|da go poglednam|da go razgledam|poseta)|organiziraj(te)?(?:\s+poseta)?|zakaz(e|i)(te)?(?:\s+poseta)?|da[il][il][^.!?\n]{0,30}dostapen|da[il][il][^.!?\n]{0,30}dostapna|(?<![\p{L}\p{N}])(?:договори|dogovori)(?![\p{L}\p{N}])(?:\s+ми(?:\s+(?:ја|го))?)?|(?<![\p{L}\p{N}])(?:закажи|zakazi)(?![\p{L}\p{N}])(?:\s+ми)?)/iu;

const VISIT_NEGATION_RE = /(не\s+(сакам|сакаме|би сакал|би сакала|посакувам|организира)|не\s+(сакам|сакаме|би сакал|би сакала|посакувам|организира))/i;

// Grammar-built slot regex — catches reversed word orders and missing person
// forms ("кога може да се види?" — 3rd person, "да видам кога може?" —
// verb-before-кога).
const _visitSlotsRe = buildVisitSlots();

export function detectVisitInterest(text: string): boolean {
  if (matchesBoth(VISIT_NEGATION_RE, text)) return false;
  if (VISIT_INTEREST_RE.test(text)) return true;
  // Grammar slot check: reversed word orders, 3rd-person види, gerund погледање
  return matchesBoth(_visitSlotsRe, text);
}

// Property interest: the client expresses positive sentiment about a shown
// property — NOT scheduling ("кога може да се види") but liking ("ми се
// свиѓа 89", "заинтересиран сум", "го сакам"). This triggers the
// enthusiasm response ("Одличен избор! Дали би сакале да организирам
// посета?") which leads into the fee/presence workflow. Patterns cover
// both exact interest words and adjective + copula combos.
const PROPERTY_INTEREST_RE = new RegExp(
  "(?:\u0437\u0430\u0438\u043D\u0442\u0435\u0440\u0435\u0441\u0438\u0440\u0430\u043D(?:\u0430|\u043E)?|zainteresiran(?:a|o)?|interes(?:en|sen)(?:en)?|interessen)(?=[^\\p{L}\\p{N}]|$)" +
  "|(?:\u043C\u0438\\s+\u0441\u0435|mi\\s+se)\\s+(?:\u0441\u0432\u0438[\u0453\u0433]\u0430|\u0441\u0432\u0438\u0433\u0430|svigja|sviga|\u0434\u043E\u043F\u0430[\u0453\u0433]\u0430|\u0434\u043E\u043F\u0430\u0433\u0430|dopaga|sviduva)" +
  "|(?:\u0433\u043E|go)\\s+(?:\u0441\u0430\u043A\u0430\u043C|\u0441\u0430\u043A\u0430\u0430\u043C|sakam|sakaam)" +
  "|(?:\u045C\u0435|ke)\\s+(?:\u0437\u0435\u043C\u0430\u043C|zemam)" +
  "|(?:\u0443\u0431\u0430\u0432\u0430?|\u0443\u0431\u0430\u0432\u043E?|ubav[aeo]?|\u0434\u043E\u0431\u0430\u0440|\u0434\u043E\u0431\u0440\u0430|\u0434\u043E\u0431\u0440\u043E|dobar|dobra|dobro|\u043F\u0440\u0435\u043A\u0440\u0430\u0441\u0435\u043D|\u043F\u0440\u0435\u043A\u0440\u0430\u0441\u043D\u0430|prekrasen|prekrasna|\u043D\u0430\u0458\u0443\u0431\u0430\u0432|najubav)\\s+(?:\u0435|e|\u043C\u0438\\s+\u0435|mi\\s+e)(?=[^\\p{L}\\p{N}]|$)" +
  "|(?:\u0435|e|\u043C\u0438\\s+\u0435|mi\\s+e)\\s+(?:\u0443\u0431\u0430\u0432\u0430?|\u0443\u0431\u0430\u0432\u043E?|\u0443\u0431\u0430\u0432\u0438\u043E\u0442|\u0434\u043E\u0431\u0430\u0440|\u0434\u043E\u0431\u0440\u0430|\u0434\u043E\u0431\u0440\u043E|\u043F\u0440\u0435\u043A\u0440\u0430\u0441\u0435\u043D|\u043F\u0440\u0435\u043A\u0440\u0430\u0441\u043D\u0430|\u043F\u0440\u0435\u043A\u0440\u0430\u0441\u043D\u0438\u043E\u0442|dobar|dobra|dobro|ubav[aeo]?|prekrasen|\u043D\u0430\u0458\u0443\u0431\u0430\u0432|najubav)(?=[^\\p{L}\\p{N}]|$)" +
  "|(?:stanot?|\u0441\u0442\u0430\u043D\u043E\u0442?|\u043E\u0432\u043E\u0458|\u043E\u0432aa|\u043E\u0432\u0430|ovoj|ovaa|ova)\\s+(?:\u0435|e)\\s+(?:\u0443\u0431\u0430\u0432\u0430?|\u0434\u043E\u0431\u0430\u0440|\u043F\u0440\u0435\u043A\u0440\u0430\u0441\u0435\u043D|prekrasen|dobar|ubav[aeo]?)", "iu");

// "ме интересира" / "me interesira" / "ме заинтересира" — verb-form interest,
// the most common colloquial phrasing in Macedonian.  The main regex above
// only has the adjective form (заинтересиран).  Covers both scripts via
// matchesBoth().
const ME_INTEREST_RE = /ме\s+(?:интересира|интригира|заинтересира|заним[ае])/iu;

/** True when the client expresses interest in a specific property. */
const PROPERTY_NEGATION_RE = /(?:не|не)\s+(?:ми\s+се|ми\s+се)\s+(?:сви[ѓг]а|свига|допа[ѓг]а|допага|свиѓ|допаг)|(?:не|не)\s+(?:го|го)\s+(?:сакам|сакам)|(?:не|не)\s+(?:сум|сум)\s+(?:заинтересиран|заинтересиран)|(?:не|не)\s+(?:ме|ме)\s+(?:интересира|интригира|заинтересира|заним[ае])/i;
export function detectPropertyInterest(text: string): boolean {
  if (matchesBoth(VISIT_NEGATION_RE, text) || matchesBoth(PROPERTY_NEGATION_RE, text)) return false;
  return PROPERTY_INTEREST_RE.test(text) || matchesBoth(ME_INTEREST_RE, text);
}

// "MI FATI OKO 94" / "ми фати окото" — the property CAUGHT THE CLIENT'S EYE
// (they saw the ad on the site). Written Cyrillic-only: matchesBoth() folds
// Latin input through normalizeMc, so "mi fati oko" resolves to "ми фати око".
// The idiom matters for inferPropertyId(): its "око 94" looks like a price cap
// ("околу 250") but here it is an Евидентен број.
const EYE_CATCH_RE =
  /ми\s+(?:го\s+|ги\s+)?фат[иј](?:\s+(?:окото|око))?|ми\s+падна(?:\s+во\s+око|а\s+во\s+очи)|(?:ми\s+)?привлече\s+(?:моето\s+)?внимани(?:ето|е)|забележав\s+(?:еден\s+)?(?:имот|стан|куќа|оглас)(?![^\p{L}\p{N}])/iu;
export function detectEyeCatch(text: string): boolean {
  return matchesBoth(EYE_CATCH_RE, text);
}

// Property DESCRIPTION without service type: the client remembers a specific
// property they saw ("гарсоњерата кaj crnogorska ambasada", "станот во центар")
// but doesn't know the EB number. Definite article + location preposition =
// specific property reference, NOT a general search.
const PROPERTY_DESC_RE =
  /(?:гарсоњер(?:ата|та|а)|garsonjer(?:ata|ta|a|е|и)|стан(?:от)?|stan(?:ot)?|куќ(?:ата|а)|kuk(?:ata|a|i)|лок(?:алот?|ал)|lokal(?:ot?|a?)|vilata|vila|deloven(?:\s+prostor)?)(?:\s+(?:кај|кaj|kaj|во|vo|near|close|околу|okolu))/iu;
// Reversed word order: location preposition + property type — "кај crnogorska е
// станот", "во aerodrom е тој стан". The client puts the neighborhood first
// and the property type after the copula.
const PROPERTY_DESC_REV_RE =
  /(?:кај|кaj|kaj|во|vo|near|close|околу|okolu)\s+[^.!?\n]{2,30}\s+(?:е|е\s+ли)?\s*(?:стан(?:от)?|куќ(?:ата|а)|гарсоњер(?:ата|та|а)|garsonjer(?:ata|ta|a)?|stan(?:ot)?|kuk(?:ata|a)?|lokal(?:ot?|a?)|vilata|vila)/iu;
/** True when the client describes a specific property they remember. */
export function detectPropertyDescription(text: string): boolean {
  return PROPERTY_DESC_RE.test(text) || PROPERTY_DESC_REV_RE.test(text);
}

// A proposed visit time (LLM-down path for visit_scheduling -> owner check).
// Anything with a time/date reference: "утре на пладне", "после 6", "петок
// во 17:30", "сабота попладне". Returns the raw phrase (used verbatim in the
// owner check + confirmation).
const VISIT_TIME_RE =
  /(утре|задутре|денес|денеска|вечерва|попладне|напладне|претпладне|утрово|наутро|вечер|викенд|во\s*\d{1,2}([.:]\d{2})?|околу\s*\d{1,2}|после\s*\d{1,2}|по\s*\d{1,2}|после\s+\d{1,2}|понеделник|вторник|среда|четврток|петок|сабота|недела|понеделни|вторни|среди|четврто|петочни|саботи|недели|utre|zadutre|denes|vecer|popladne|napladne|utrovo|vikend|posle\s*\d{1,2}|okolu\s*\d{1,2}|okolo\s*\d{1,2}|vo\s*\d{1,2}([.:]\d{2})?|ponedelnik|vtornik|sreda|cetvrtok|petok|sabota|nedela)/i;

export function detectVisitTime(text: string): string | undefined {
  if (!VISIT_TIME_RE.test(text)) return undefined;
  return text.trim().slice(0, 80);
}

// Vague time-of-day references that need a follow-up for the EXACT hour.
// "попладне" = afternoon (which hour?), "после 5" = after 5 (which exact time?),
// "pred 17:00" = before 5pm (which exact time?). These are valid time
// intentions but too imprecise to pass to the owner — Lina must ask for the
// exact clock before proceeding.
// Time-of-day words that are vague WITHOUT a clock ("попладне" alone = vague,
// but "попладне после 6" = specific). Bare relative times like "после 5"
// (without HH:MM) are also vague.
const VAGUE_TIME_WORD_RE = /(?:попладне|напладне|претпладне|утрово|наутро|вечерва|вечер|навечер|popladne|napladne|utrovo|nautro|vecer|navecer)/i;
const VAGUE_RELATIVE_RE = /(?:(?:после|posle|pred|пред)\s*\d{1,2})(?![.:]\d{2})/i;
// A specific clock: HH:MM or "во/по 16:00" or "после 18:00" (with minutes)
const SPECIFIC_CLOCK_RE = /\d{1,2}[.:]\d{2}|(?:(?:во|по|после|околу|vo|po|posle|okolu)\s*\d{1,2}[.:]\d{2})/i;
// Day-of-week + time-of-day combo ("UTRE POPLADNE", "СРЕДА ПОПЛАДНЕ") = context
const DAY_PLUS_PERIOD_RE = /(?:утре|задутре|denes|utre|zadutre|sreda|petok|sabota|nedela|среда|петок|сабота|недела)\s+(?:попладне|напладне|претпладне|утрово|вечер|popladne|napladne|vecer)/i;

/** True when the text contains a vague time-of-day reference that needs a
 *  follow-up for the exact clock ("попладне", "после 5", "pred 17:00").
 *  Returns false when the text already has a specific clock OR a day+period
 *  combo that gives enough context ("UTRE POPLADNE POSLE 6"). */
export function detectVagueTime(text: string): boolean {
  if (SPECIFIC_CLOCK_RE.test(text)) return false;
  // Day + time-of-day combo is specific enough ("утре попладне после 6")
  if (DAY_PLUS_PERIOD_RE.test(text)) return false;
  return matchesBoth(VAGUE_TIME_WORD_RE, text) || matchesBoth(VAGUE_RELATIVE_RE, text);
}

// The client can't do the PROPOSED visit time — „не можам во 18:00“, „може
// покасно/подоцна“, „не ми одговара“. In owner_checking this sends the
// negotiation back to collecting a NEW concrete time — Lina must never confirm
// (or keep asking the owner about) a time the client already rejected. The
// "не"-anchored forms keep "MOZAM VO 19:00" (a new proposal) out.
const TIME_REJECT_RE = /(не можам|не може|не можев|не можел|не ми одговара|не ми е згодно|не одговара|не тој термин|не тогаш|подоцна|покасно|друг термин|поинаков|поинаку|не мозам|не мозе|не мозев|не ми одговара|не ми e згодно|не одговара|не тој термин|не тогас|подоцна|покасно|друг термин|поинаков|поинаку|нема да мозам|нема да мозе|нема да моземе|нема да можам|нема да може|нема да можеме)/i;

export function detectTimeRejection(text: string): boolean {
  return matchesBoth(TIME_REJECT_RE, text);
}

// Commercial-property intent: деловен простор / канцеларија / локал / магацин /
// дуќан / продавница… ("за стан" searches must never ask or match these — and
// vice versa). The vocabulary mirrors Ana's proven COMMERCIAL_TITLE_RE
// (outbound project). STRONG terms (unambiguous property types) match bare;
// WEAK terms (кафе/ресторан/салон/хотел are often LANDMARKS — "сакам стан до
// кафе") require a need/transaction context so a landmark mention never
// flips a residential search into a business one.
const BUSINESS_STRONG_RE = /(деловен|деловни|деловна|деловно|канцелар|локал|магацин|склад|хала|бизнис|офис|дукјан|дукан|дуќан|продавниц|ателје|деловен|деловни|деловна|канцелари|канцелариски|локал|магацин|склад|хала|бизнис|офис|дуќан|дукан|продавниц|атеље|пословен|пословн|оффице|бусинесс|цоммерциал)/i;
const BUSINESS_WEAK_RE = /(ресторан|кафуле|кафич|кафе|салон|хотел|ресторан|кафуле|кафиц|кафе|салон|хотел)/i;
const BUSINESS_NEED_RE = /(ми треба|барам|сакам|треба|потребен|потребна|неед|треба|барам|сакам|за изнајмување|за издавање|под кирија|за изнајмува|за изнајмување|за издавање|под кирија|за изнајмув|рент|изнајмувам)/i;
// An explicit RESIDENTIAL word (стан/куќа/гаража стамбен) means the weak
// term is a LANDMARK, not the property type: "сакам стан до кафе" is an
// apartment search, "барам локал до кафе" is a business search.
const RESIDENTIAL_WORD_RE = /(стан|стани|станче|куќ|кука|хоусе|стан|станце|апартмент|гаража|гараза|стамбен|стамбен)/i;

export function detectBusiness(text: string): boolean {
  // An explicit residential word ("стан", "куќа") wins over EVERY business
  // term: "стан до кафе" and "стан со дуќан" are residential searches — the
  // business word is a landmark/feature, not the property type.
  if (matchesBoth(RESIDENTIAL_WORD_RE, text)) return false;
  if (matchesBoth(BUSINESS_STRONG_RE, text)) return true;
  if (!matchesBoth(BUSINESS_WEAK_RE, text)) return false;
  // Weak term (кафе/ресторан/салон) is business only WITH a need context:
  // "барам ресторан под кирија" = business; bare "кафе" = nothing.
  return matchesBoth(BUSINESS_NEED_RE, text);
}

// House intent: куќа / кука / house / kukja / kuka / вила (both scripts). An
// explicit apartment word (стан/станче/stan/stance) wins — "сакам куќа или
// стан" is ambiguous and stays an apartment request.
const HOUSE_RE = /(куќ|кука|хоусе|куќа|кука|вила|вила)/i;
const APARTMENT_RE = /(стан|стани|станче|стан|станце|апартмент|апартман)/i;

/**
 * House intent: true = куќа, false = explicit стан, UNDEFINED when the message
 * names NO property type at all ("DVE SPALNI…", "ДО 100.000"). The undefined
 * case is critical: a detail message must never clobber an established куќа
 * funnel into a стан search (the old always-false made "DVE SPALNI…" reset a
 * куќа buyer to стан — Lina then presented an apartment).
 */
export function detectHouse(text: string): boolean | undefined {
  const house = matchesBoth(HOUSE_RE, text);
  const apartment = matchesBoth(APARTMENT_RE, text);
  if (!house && !apartment) return undefined; // no property-type word
  return house && !apartment;
}

/** Square meters for a commercial space: "40 м2", "40 квадрати", "150 kvadrata". */
export function detectSqm(text: string): number | undefined {
  const m = text.match(/(\d{2,4})\s*(м2|м²|m2|m²|кв\.?\s*м|квадрат(и)?|kvadrat(a|i)?)/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 10 && n <= 5000) return n;
  }
  // Word-form sizes the client remembers approximately: "триесетина квадрати"
  // (~30 м²), "околу педесет квадрати". Used when locating a SEEN property by
  // memory — digits win when both are present.
  const w = text.match(/(?:околу\s+|некаде\s+|до\s+)?(?:дваесет(?:ина)?|триесет(?:ина)?|четириесет(?:ина)?|педесет(?:ина)?|шеесет(?:ина)?|седумдесет(?:ина)?|осумдесет(?:ина)?|деведесет(?:ина)?|сто(?:тина)?|dvaeset(?:ina)?|trieset(?:ina)?|chetirieset(?:ina)?|pedeset(?:ina)?|seeset(?:ina)?|sedumdeset(?:ina)?|osumdeset(?:ina)?|devedeset(?:ina)?|sto(?:tina)?)\s*(?:квадрат(?:и)?|м2|м²|m2|m²|kvadrat(?:a|i)?)/i);
  if (!w) return undefined;
  const map: Record<string, number> = {
    дваесет: 20, дваесетина: 20, триесет: 30, триесетина: 30,
    четириесет: 40, четириесетина: 40, педесет: 50, педесетина: 50,
    шеесет: 60, шеесетина: 60, седумдесет: 70, седумдесетина: 70,
    осумдесет: 80, осумдесетина: 80, деведесет: 90, деведесетина: 90,
    сто: 100, стотина: 100,
    dvaeset: 20, dvaesetina: 20, trieset: 30, triesetina: 30,
    chetirieset: 40, chetiriesetina: 40, pedeset: 50, pedesetina: 50,
    seeset: 60, seesetina: 60, sedumdeset: 70, sedumdesetina: 70,
    osumdeset: 80, osumdesetina: 80, devedeset: 90, devedesetina: 90,
    sto: 100, stotina: 100,
  };
  const word = w[0].toLowerCase().match(/(?:дваесет|триесет|четириесет|педесет|шеесет|седумдесет|осумдесет|деведесет|сто|dvaeset|trieset|chetirieset|pedeset|seeset|sedumdeset|osumdeset|devedeset|sto)(?:ина)?/i)?.[0] ?? '';
  const n = map[word];
  return n !== undefined && n >= 10 && n <= 5000 ? n : undefined;
}

// Agreement/contact-intent phrases — the escape hatch from the exhausted
// dead-end ("добро", "контактирај ме" after every option was shown).
const AGREE_PHRASES = ['во ред', 'vo red', 'се согласувам', 'se soglasuvam',
  'контактирај ме', 'контактирајте ме', 'kontaktiraj me', 'kontaktirajte me',
  'запиши ме', 'запишете ме', 'prijavete me'];
const AGREE_WORDS = new Set(['добро', 'ок', 'да', 'може', 'согласен', 'согласна',
  'согласувам', 'запиши', 'запишете', 'контактирај', 'контактирајте', 'регистрирај',
  'ok', 'dobro', 'moze', 'da', 'soglasen', 'soglasna', 'soglasuvam',
  'zapisi', 'zapisete', 'kontaktiraj', 'kontaktirajte', 'registriraj']);

// "moze/може" is ONLY agreement when standalone or followed by "да/da".
// When followed by ANYTHING ELSE it means "can/may" — a criteria modifier
// ("moze i pogolem" = "can be bigger too", "moze 2 spalni" = "can be 2
// bedrooms").  The pattern matches "moze/може" followed by a non-da token.
const MOZE_NOT_AGREEMENT_RE = /(?:може|мозе)(?:\s+|[^\p{L}\p{N}])+(?!\s*(?:да|да)(?![\p{L}\p{N}]))/iu;
// ... but we also need to check it's NOT just standalone "moze" with nothing
// after it (or only punctuation).  Simplest: check if there's a real word
// token AFTER "moze" that isn't "да/da".
const MOZE_HAS_NON_DA_AFTER = /(?:може|мозе)\s+(?!да(?![\p{L}\p{N}])|da\b)([\p{L}\p{N}]+)/iu;

// "da/да" preceded by a verb/modal is NOT agreement: "mora da imas" (you
// must have), "treba da bidat" (they should be), "sakam da vidam" (I want
// to see).  Only standalone "da" or "da" at the start of the message is
// agreement ("да, согласувам", "да, во ред").
const DA_AFTER_VERB_RE = /(?:\S+\s+)(?:да|да)\s/iu;
// Verb/modal stems that precede "da" to form "must/should/want to" phrases
const DA_NOT_AGREEMENT_RE = /(?:мора|мора|треба|сакам|сакас|сакате|сакаме|имас|има|имате|имаме|бидес|биде|ќе|ке|би\s|би\s|цан\s|морам|морат|има|имаш|имаме|имате|сакаш|сакаме|сакате|би(?![\p{L}\p{N}])|ќе(?![\p{L}\p{N}]))(?:\s+[^\s]+)?\s+(?:да|да)(?![\p{L}\p{N}])/iu;
// "да" as a discourse marker at the start of a sentence: "Да ти кажам
// искрено...", "Да знам...", "Да видам..." — these are purpose clauses,
// NOT agreement.  The pattern matches sentence-initial "да/да" followed by
// a verb (2nd/3rd person) or pronoun+verb.
const DA_PURPOSE_RE = /(?:^|(?<=[.!?]\s+))(?:да|да)\s+(?:ти|ми|му|ја|го|ги|се)?\s*(?:[а-яa-z]{3,})/iu;
// "да се инвестира", "да купам", "да продадам" — purpose clauses after
// any word (not just sentence start): "со денешните цени... да се инвестиира"
const DA_PURPOSE_CLAUSE_RE = /(?:да|да)\s+се\s+[а-яa-z]{3,}|(?:да|да)\s+(?:куп|продад|инвести|финанси|зем|погледн|вид|најд|дозн)[а-яa-z]*/iu;
// "да ли" / "дали" — question particle, NOT agreement.  "не знам да ли
// е паметно" = "I don't know if it's smart" — the да is part of
// дали (whether), not a standalone yes.
const DA_LI_RE = /(?:^|[^а-яa-z])(?:да|да)\s+ли|дали/iu;

export function detectAgreement(text: string): boolean {
  const low = text.toLowerCase();
  if (AGREE_PHRASES.some(p => low.includes(p))) return true;
  const tokens = low.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // "moze i pogolem" / "moze 2 spalni" — "moze" here means "can/may"
  // (criteria modifier), NOT agreement.  Skip the "moze/може" token when
  // it's followed by a non-da word (criteria refinement).
  const mozeIsCriteria = matchesBoth(MOZE_HAS_NON_DA_AFTER, low);
  // "mora da imas" / "treba da bidat" — "da" here is part of a
  // verb phrase ("must/should have to"), NOT agreement.
  const daIsVerbPhrase = matchesBoth(DA_NOT_AGREEMENT_RE, low);
  // "Да ти кажам искрено...", "да се инвестиира" — "да" as a discourse
  // marker or purpose clause, NOT agreement.
  const daIsPurpose = matchesBoth(DA_PURPOSE_RE, low) || matchesBoth(DA_PURPOSE_CLAUSE_RE, low);
  // "да ли" / "дали" — question particle (whether), NOT agreement.
  const daIsQuestion = matchesBoth(DA_LI_RE, low);
  return tokens.some(t => AGREE_WORDS.has(t)
    && !(mozeIsCriteria && (t === 'moze' || t === 'може'))
    && !(daIsVerbPhrase && (t === 'da' || t === 'да'))
    && !(daIsPurpose && (t === 'da' || t === 'да'))
    && !(daIsQuestion && (t === 'da' || t === 'да')));
}

// A pure "yes, show me more" — agreement WITHOUT an explicit register/contact
// intent ("контактирај ме", "запиши ме" choose the queue, not a wider search).
const WIDEN_EXCLUDE_RE = /(контактирај|контактирајте|запиши|запишете|забележи|регистрирај|пријави|контактирај|контактирајте|регистрирај|запиши|забелези)/i;
export function detectWidenIntent(text: string): boolean {
  return detectAgreement(text) && !matchesBoth(WIDEN_EXCLUDE_RE, text);
}

// Fee payment agreement — the client explicitly agrees to PAY the viewing fee.
// "DOBRO KE PLATAM", "ќе ја платам", "согласен сум со цената", "договорено",
// "ќе платам", "платам", "прифаќам да платам" etc.
// This is DISTINCT from generic agreement ("да", "добро") — it carries a
// payment intent that must bypass the ownerContactPending guard and go
// directly to the fee agreement path → visit scheduling.
/** True when the client explicitly agrees to pay the fee.
 *  Covers: "dobro ke platam", "ќе ја платам", "согласен со цената",
 *  "договорено", "ќе платам", "прифаќам да платам", etc.
 *  DISTINCT from generic agreement ("да", "добро") — carries payment intent. */
export function detectFeePaymentAgreement(text: string): boolean {
  return (
    // "добро/ок/во ред ќе платам" — agreement + payment
    /(?:добро|dobro|ок|ok|okay|во\s+ред|vo\s+red|договорено|dogovoreno|сум\s+согласен|sum\s+soglasen|согласна\s+сум|сум\s+согласна|согласувам\s+се|se\s+soglasuvam)\s+(?:ќе|ke|ще|shte|да|da)?\s*(?:\s+)?(?:ја\s+)?(?:платам|platam|плаќам|plakjam)/iu.test(text)
    // "ќе платам" / "ke platam" / "да платам" / "да ја платам"
    || /(?:ќе|ke|ще|shte|да|da)\s+(?:ја\s+)?(?:платам|platam|плаќам|plakjam)/iu.test(text)
    // "platam" / "плаќам" — standalone or with filler
    || /(?:^|[\s,.;:!?])(?:платам|platam|плаќам|plakjam)(?:$|[\s,.;:!?])/iu.test(text)
    // "согласен со цената" / "soglasen so cenata" — agreement with the price
    || /(?:согласен|soglasen|согласна|soglasna|согласувам|soglasuvam)\s+(?:(?:со|so)\s+)?(?:цената|cenata|цена|cena|надоместот|nadomestot|надомест|nadomest)/iu.test(text)
    // "се согласувам за посетата" / "согласен за посетата"
    || /(?:согласен|soglasen|согласна|soglasna|согласувам|soglasuvam)\s+(?:за\s+)?(?:посетата|posetata|посета|poseta|надоместот|nadomestot|надомест|nadomest)/iu.test(text)
    // "договорено" / "dogovoreno" — deal/agreement (standalone)
    || /^(?:договорено|dogovoreno|договор|dogovor|договоривме|dogovorivme)$/iu.test(text)
    // "во ред со цената" / "ok so cenata"
    || /(?:во\s+ред|vo\s+red|ok|okej)\s+(?:(?:со|so)\s+)?(?:цената|cenata|цена|cena|надоместот|nadomestot|надомест|nadomest|посетата|posetata|посета|poseta)/iu.test(text)
    // "ќе го платам" / "ќе ја платам" / "ke go platam"
    || /(?:ќе|ke|ще|shte)\s+(?:го|go|ја|ja)\s+(?:платам|platam|плаќам|plakjam)/iu.test(text)
    // "може да платам" / "moze da platam" — can pay
    || /(?:може|можам|moze|mozam)\s+(?:да|da)\s+(?:платам|platam|плаќам|plakjam)/iu.test(text)
    // "прифаќам да платам" / "prihakam da platam"
    || /(?:прифаќам|прифатив|prihakam|prihatam|prihvatam)\s+(?:да|da)\s+(?:платам|platam|плаќам|plakjam)/iu.test(text)
    // "ќе ја земам" (I'll take it) — general acceptance of the deal
    || /(?:ќе|ke|ще|shte)\s+(?:ја|ja|го|go)\s+(?:земам|zemam|прифаќам|prihakam)/iu.test(text)
  );
}

// Investment / market opinion — the client expresses doubt or opinion about
// property investment ("не знам дали е паметно да се инвестира", "цените
// се превисоки"). These are NOT agreements, NOT fee questions, NOT
// rejections — they are off-topic digressions that the LLM handles best.
// In closing state with ownerContactPending, these must NOT trigger the
// fee disclosure path.
const INVESTMENT_OPINION_RE = /(?:не\s*знам\s+дали|neznam\s+dali|незнам\s+дали)[^.!?\n]{0,40}(?:паметно|разумно|исплат|вреди|вреди|инвестира|купи|купувам)|(?:цените|цена|ceni|cena)[^.!?\n]{0,30}(?:превисок[иае]|висок[иае]|скап[иаео]|previsok[iae]|visok[iae]|skap[iae]| padna|опаѓаат|опаѓа)|(?:превисок[иае]|висок[иае]|скап[иаео]|skap[iae]|previsok[iae]|visok[iae])[^.!?\n]{0,30}(?:цените|цена|ceni|cena)|(?:инвестира|инвестиција|инвестирање|investira|investicij|investiranje|вложу|vlozu)[^.!?\n]{0,30}(?:р[аа]змисл|размислув|pakuvam|risks?|nevkl|е\s+ризичн|е\s+risik|е\s+скапо)|(?:е\s+паметно|e\s+pametno|е\s+разумно|e\s+razumno)[^.!?\n]{0,20}(?:да\s+купи|да\s+инвестира|da\s+kupi|da\s+investira)|(?:скапо|skapo|скапи|skapi)[^.!?\n]{0,20}(?:богами|богами|vauf|вау|бре|brate|bro|брате|jeez|џејз|бомба|бомб)|(?:цените?|цена|ceni|cena|ценови)[^.!?\n]{0,30}(?:отидоа|отиде|одат|отишле|отиде|отидов|otidoa|otishe|otisle|odat)[^.!?\n]{0,20}(?:без\s+трага|без\s+траги|без\s+след|во\s+бес\s*трага|в\s+бестрага|vo\s+bestraga|bestraga)/iu;

/** True when the client expresses an investment/market opinion. */
export function detectInvestmentOpinion(text: string): boolean {
  return matchesBoth(INVESTMENT_OPINION_RE, text);
}

// --- Exhausted follow-up detector -----------------------------------------------
// When the bot just said "we exhausted all options in X" and the client asks
// about rent/buy/availability in that area ("skapa kirija ima za toj reon",
// "kirija e skupa", "ima kirija za vodno"), they are questioning the market —
// same intent as an investment opinion.  This detector is ONLY meant to fire
// in the exhausted context (areaExhausted=true).
// Simple keyword match — the context guard (areaExhausted) does the heavy
// lifting, so we just need to detect rent/buy service keywords in the text.
const EXHAUSTED_FOLLOWUP_RE = /(?:kirija|кирија|кириja|киријата|kirijata|rent|kupuvam|kupuvaњe|kupuvanje|kupi|buy|купи|купување|купување|изнајмув|изнajмув|најм)/iu;

/** True when the client asks about service/availability after exhausted state. */
export function detectExhaustedFollowUp(text: string): boolean {
  return matchesBoth(EXHAUSTED_FOLLOWUP_RE, text);
}

// Minimal name+phone intake for the LLM-down path (contact_collection).
const NAME_STOPWORDS = new Set(['моето', 'мое', 'име', 'јас', 'сум', 'се', 'викам',
  'нарекувам', 'тел', 'телефон', 'телефонот', 'број', 'бројот', 'контакт', 'контактниот',
  'ми', 'е', 'и', 'на', 'со', 'ве', 'го', 'ги', 'за', 'ова', 'оваа',
  'evt', 'tel', 'phone', 'broj', 'kontakt', 'moeto', 'ime', 'jas', 'sum', 'vikam',
  'здраво', 'zdravo', 'како', 'kako', 'добар', 'dobar', 'ден', 'den', 'извинете',
  'izvinete', 'ве молам', 've molam', 'посакувам', 'posakuvam', 'господине',
  'gospodine', 'госпоѓа', 'gospogja', 'благодарам', 'blagodaram', 'ова', 'тоа', 'toa',
  // "Горан може на овој број" — function words, never names
  'овој', 'оваа', 'може', 'можам', 'ovoj', 'ovaa', 'moze', 'mozam',
  // "па ти ги напишав" (I already wrote them to you) — must NEVER become a
  // name that overwrites the stored one
  'напишав', 'napisav', 'napishav', 'напишавме', 'напиша',
  // "не знам" (I don't know) — an honest retry, never a name
  'знам', 'znam', 'знаеш', 'znaes']);

export function detectContact(text: string): { name?: string; phone?: string } {
  let t = text.trim();
  // 078/914 196, 078 914 196, 078914196, 02 3123 456 — 3 or 4 number groups
  const phoneRe = /(0\d{1,2})[\s/.-]*(\d{2,4})[\s/.-]*(\d{2,4})(?:[\s/.-]*(\d{2,4}))?/;
  const m = t.match(phoneRe);
  let phone: string | undefined;
  if (m) {
    phone = m[0].replace(/[\s/.-]+/g, '');
    t = t.replace(m[0], ' ');
  }
  const words = t.split(/[^\p{L}]+/u)
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 3 && !NAME_STOPWORDS.has(w));
  const name = words.length
    ? words.slice(0, 2).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    : undefined;
  return { name, phone };
}

/**
 * Acceptance rules for the LLM path (parseClassified). The deterministic
 * path builds these fields by construction; the LLM hands back free text, so
 * it must be validated the same way the budget/location fields are — garbage
 * ("кукја пофтина" as a name) must never reach the appointment record.
 */

// A plausible name: 2-60 letters (Cyrillic or Latin), spaces/hyphens/
// apostrophes allowed, digits/punctuation rejected, 1-3 words, at least one
// word CAPITALIZED ("Горан Петровски" ok — real names come back capitalized;
// lowercase sentence garbage like "кукја пофтина евра" is rejected and the
// deterministic detectContact fills the clean capitalized form instead), and
// not purely stopwords.
export function isPlausibleName(name: string): boolean {
  const n = name.trim();
  if (n.length < 2 || n.length > 60) return false;
  if (/[^\p{L}\s'’-]/u.test(n)) return false;
  const words = n.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 3) return false; // names: 1-3 words, never a sentence
  if (!words.some(w => /^\p{Lu}/u.test(w))) return false; // needs a capital letter
  return words.some(w => w.length >= 2 && !NAME_STOPWORDS.has(w.toLowerCase()));
}

// A phone: 7-15 digits after stripping separators (MK mobile 078/914 196 =
// 9 digits, landlines 8-9, +389 international 11-12). Pure garbage like
// "кукја пофтина" has letters -> rejected.
export function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/[\s/.-]+/g, '');
  return /^\d{7,15}$/.test(digits);
}

// A visit time: a real time/date reference. Broader than detectVisitTime (a
// full-message matcher): the LLM's visitTime field may be JUST the time
// ("19:00", "17:30") with no surrounding words, so a bare HH:MM is accepted
// too. Sentence garbage ("кукја пофтина") has neither -> rejected.
export function isValidVisitTime(t: string): boolean {
  if (t.length > 80) return false;
  return VISIT_TIME_RE.test(t) || /\b\d{1,2}[:.]\d{2}\b/.test(t);
}

// Known Skopje neighborhoods — the FALLBACK for location detection. The feed's
// locations() may be empty (feed unreachable/slow, as in the "karpos" loop the
// client hit) or may lack a property in an area the client names ("Гази Баба"
// with no current listing). Either way the area must still be RECOGNIZED so the
// funnel gives the honest no-match / feed-unavailable line instead of re-asking
// the location question forever. Canonical feed spellings are included so a
// fallback hit still matches real properties once the feed is back.
const KNOWN_NEIGHBORHOODS = [
  'Центар', 'Центар (населба)', 'Карпош', 'Карпош III',
  'Аеродром', 'Кисела Вода', 'Капиштец', 'Чаир', 'Тафталиџе', 'Маџари',
  'Влае', 'Ново Лисиче', 'Лисиче', 'Водно', 'Козле', 'Скопје Север',
  'Дебар Маало', 'Гази Баба', 'Бутел', 'Илинден', 'Сарај', 'Ѓорче Петров',
  'Автокоманда', 'Црниче', 'Радишани', 'Хром', 'Железара', 'Шуто Оризари',
  'Пржино', 'Момин Поток', 'Бег', 'Злокуќани', 'Визбегово', 'Драчево',
  'Сингелиќ', 'Ново Маџари',
];

/**
 * Best matching canonical feed location for a query, or undefined. Feed
 * locations come from PropertyService.locations() (longest first); the same
 * transliteration-aware matcher as the property search decides the hit, so
 * "centar" finds "Центар" and "kisela voda" finds "Кисела Вода". The known
 * Skopje neighborhoods are always in the pool too, so detection works even
 * when the feed is down (locations() = []) — never a silent location loop.
 */
export function detectLocation(text: string, feedLocations: string[]): string | undefined {
  // Multi-area capture: a client open to several neighborhoods ("centar, kisela
  // voda, aerodrom") gets ALL of them stored, so presentations stay inside the
  // union of the named areas instead of a single first match. The joined string
  // reads naturally in recaps and locMatches() matches any of its members.
  const hits = [...KNOWN_NEIGHBORHOODS, ...feedLocations].filter(loc => locMatches(text, loc));
  // Dedupe overlapping names ("Центар" vs "Центар (населба)"): keep the more
  // specific one, longest first — a redundant "Центар (населба), …, Центар"
  // would leak into recaps and no-match lines.
  const kept: string[] = [];
  for (const loc of hits.sort((a, b) => b.length - a.length)) {
    if (!kept.some(k => locMatches(loc, k))) kept.push(loc);
  }
  return kept.length > 0 ? kept.join(', ') : undefined;
}

// ---------------- owner ping-pong (plain-text verdict parsing) --------------
// The owner answers Lina's question in natural language ("da, moze", "ne, samo
// vo petok vo 11", "prodaden e"). This parses the answer deterministically so
// the owner check resolves and Lina relays it to the client — with or without
// LLMs, and without forcing the TUI user to learn slash commands.
const OWNER_GONE_RE = /(продаден|продадена|издаден|издадена|под опција|повеќе не е достапен|веќе не е|немам имот|нема повеќе|нема да може|солд|рентед|продаден|продадена|издаден|издадена|продан|под опција)/i;
// Short words (да/ок/ok) need explicit boundaries — "ок" inside "kako" or
// "да" inside "дава" must never count as agreement. Long words match bare.
const OWNER_AGREE_RE =
  /(?:^|[\s,.;:!?])(?:да|da|ок|ok|okay)(?:$|[\s,.;:!?])|(?:може|можам|можеш|во ред|okej|слободен|слободна|слободно|достапен|достапна|достапно|прифаќам|прифатено|прифатен|прифатена|се согласувам|согласен|согласна|зелено|moze|mozam|vo red|sloboden|slobodna|slobodno|dostapen|dostapna|dostapno|prihaka|prihakat|soglasen|soglasna)/i;
const OWNER_DISAGREE_RE = /(не можам|не ми одговара|не ми е згодно|не одговара|не е достапен|не е достапна|нема да можам|не тој термин|не тогаш|не сакам|не ми се допаѓа|не мозам|не ми одговара|не e достапен|не e достапна|не тој термин)/i;
// "не можам" must NOT count as agreement via the bare "можам" word. The
// negated "nema da mozam" / "нема да можам" ("won't be able to") is the
// MOST common owner refusal — it contains the bare "mozam" that would
// otherwise match OWNER_AGREE_RE and CLOSE THE DEAL on a refusal.
const OWNER_CANT_RE =
  /(не\s+можам|не\s+може|не\s+можеш|ne\s+mozam|ne\s+moze|не\s+ми\s+одговара|не\s+ми\s+е\s+згодно|не\s+можам\s+да|nema\s+da\s+mozam|nema\s+da\s+moze|nema\s+da\s+mozeme|нема\s+да\s+можам|нема\s+да\s+може|нема\s+да\s+можеме)/i;
const OWNER_DAY_RE = /утре|задутре|денес|денеска|вечерва|попладне|напладне|претпладне|утрово|вечер|викенд|понеделник|вторник|среда|четврток|петок|сабота|недела|utre|zadutre|denes|deneska|vecer|popladne|napladne|utrovo|vikend|ponedelnik|vtornik|sreda|cetvrtok|petok|sabota|nedela/i;
// A clock like "во 18:00" or bare "16:00" — but NOT when the number is
// part of a price phrase ("по 60 илјади евра", "околу 70 000 евра"): the
// lookahead rejects a match that continues into more digits or currency.
// Owner messages often omit the preposition ("petok 16:00 ?").
const OWNER_CLOCK_RE = /((?:(?:во|по|после|околу|vo|po|posle|okolu)\s*\d{1,2}(?:[.:]\d{2})?)|(?:\d{1,2}[.:]\d{2}))(?!\s*(?:\d[\d\s.,]*)?\s*(?:илјади|хилјади|iljadi|евра|евро|evra|evro|eur|€))/i;
const OWNER_DAY_PART_RE = /(попладне|напладне|претпладне|утрово|наутро|вечерва|вечер|навечер|popladne|napladne|preтpladne|utrovo|nautro|vecer|navecer)/i;

/**
 * The time phrase in the owner's reply ("петок во 11", "сабота попладне",
 * "утре по 18:00"). The day word paired with the clock is the one NEAREST
 * BEFORE it, not the first in the message: "denes nema da mozam. utre vo 16:00 ?"
 * refuses TODAY and proposes TOMORROW — the 16:00 clock belongs to "утре",
 * and pairing it with the first day ("денес") would relay the wrong day.
 */
function extractOwnerTime(text: string): string | undefined {
  // matchAll needs global regexes; the originals are stateful (.test) so clone
  // them with the g flag instead of mutating the shared patterns.
  const g = (re: RegExp) => new RegExp(re.source, `${re.flags.replace('g', '')}g`);
  const clocks = [...text.matchAll(g(OWNER_CLOCK_RE))];
  const days = [...text.matchAll(g(OWNER_DAY_RE))];
  // The clock picks its day: the nearest day word BEFORE it (skip days that
  // come after the clock — "само во петок во 11" pairs петок+во 11, and a
  // refusal's earlier day like "денес нема да можам, утре во 16:00" is
  // skipped in favor of утре).
  for (const clock of clocks) {
    const cIdx = clock.index ?? 0;
    let best: RegExpMatchArray | undefined;
    let bestGap = Infinity;
    for (const d of days) {
      const dEnd = (d.index ?? 0) + d[0].length;
      if (dEnd > cIdx) continue; // the day must precede the clock
      const gap = cIdx - dEnd;
      if (gap < bestGap) { bestGap = gap; best = d; }
    }
    if (best) return `${best[0]} ${clock[1]}`.trim();
  }
  // First day match: in "сабота попладне" both match OWNER_DAY_RE but
  // "попладне" is a day-part modifier, not a standalone day — taking the
  // last would lose the pairing. The clock+day pairing loop above handles
  // the "refused day + proposed day" case correctly (nearest day before
  // the clock wins).
  if (days.length > 0) {
    const first = days[0];
    const tail = text.slice((first.index ?? 0) + first[0].length);
    const part = tail.match(OWNER_DAY_PART_RE);
    if (part) return `${first[0]} ${part[0]}`.trim();
    return first[0];
  }
  const clock = text.match(OWNER_CLOCK_RE);
  return clock ? clock[1].trim() : undefined;
}

// The owner dictates the CURRENT price ("цената е 60.000 евра", "60 илјади",
// "cenata e 60000") — anchored on цена/cena/price, or a bare amount only when
// it carries a currency ("60000 evra"). A bare clock ("утре во 11", "18:00")
// never counts as a price: no anchor, no currency.
const OWNER_PRICE_ANCHOR_RE = /(?:цена(?:та)?|cenata|cena|price)\s*(?:е|изнесува|се промени(?:ла)?\s+на|е променета\s+на|e|iznesuva)?\s*(\d[\d\s.,]*)\s*(?:илјади|хилјади|iljadi)?\s*(?:евра|евро|evra|evro|eur|€)?/i;
const OWNER_PRICE_CURRENCY_RE = /(\d[\d\s.,]*)\s*(?:илјади|хилјади|iljadi)?\s*(?:евра|евро|evra|evro|eur|€)/i;

/** The new price the owner dictates (EUR), or undefined. "60 илјади" → 60000. */
function extractOwnerPrice(text: string): number | undefined {
  const m = text.match(OWNER_PRICE_ANCHOR_RE) ?? text.match(OWNER_PRICE_CURRENCY_RE);
  if (!m) return undefined;
  let n = parseInt(m[1].replace(/[\s.,]/g, ''), 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (/(илјади|хилјади|iljadi)/i.test(m[0])) n *= 1000;
  return n;
}

/**
 * Parse the OWNER's plain-text answer into a verdict. undefined = not
 * understood (the question must be repeated). Same-time confirmations and
 * agreement without a new time resolve to 'ok'; a different time is a
 * counter-proposal; sold/rented words are 'gone'. A price the owner dictates
 * ("цената е 60.000 евра") rides along on the verdict — the handler stores it
 * (Hermes corrects the public app) and relays it to the client.
 */
export function detectOwnerVerdict(text: string, proposedTime?: string): OwnerVerdict | undefined {
  const t = text.toLowerCase();
  const price = extractOwnerPrice(text);
  const withPrice = (v: OwnerVerdict): OwnerVerdict =>
    price !== undefined ? { ...v, price } : v;
  if (matchesBoth(OWNER_GONE_RE, t)) {
    const note = /продад|prodad/.test(t) ? 'продаден' : /издад|izdad/.test(t) ? 'издаден' : undefined;
    return withPrice({ status: 'gone', note });
  }
  const cant = OWNER_CANT_RE.test(t);
  const time = extractOwnerTime(text);
  const hasClock = OWNER_CLOCK_RE.test(text);
  const agree = !cant && OWNER_AGREE_RE.test(t);
  const disagree = cant || matchesBoth(OWNER_DISAGREE_RE, t);
  // Same-time confirmation or plain agreement → ok (accept the client's time).
  // locMatches is transliteration-aware: "utre po 18:00" === "утре по 18:00".
  if (agree && (!time || (proposedTime && locMatches(time, proposedTime)))) {
    return withPrice({ status: 'ok', ownerTime: proposedTime });
  }
  // A positively proposed DIFFERENT time → counter-proposal, EVEN when the
  // owner also refuses the proposed time ("denes nema da mozam. utre vo 16:00 ?"
  // = can't today, TOMORROW at 16:00 — a counter, never an ok on the old time).
  // The owner often types Latin ("petok vo 11") — the relay reads Cyrillic.
  // A refusal with only the refused day ("денес нема да можам" — no clock, no
  // alternative) is a BARE counter, not a proposal of the refused day itself.
  if (time && (!disagree || hasClock)) {
    return withPrice({ status: 'counter', ownerTime: normalizeLocation(time) });
  }
  // Can't do the proposed time (no alternative given) → counter; the client
  // proposes another time and the owner is asked again.
  if (disagree) return withPrice({ status: 'counter' });
  if (agree) return withPrice({ status: 'ok', ownerTime: proposedTime });
  return undefined;
}

export interface WhereIsQuestion {
  place: string;   // the named place ('' when the client means the last shown property)
  generic: boolean;
}

// "каде е X?" — verb list includes Latin + Cyrillic; lookahead keeps the
// boundary so "каде е?" (no place) still matches and yields an empty rest.
const WHERE_IS_RE = /(?:^|\s)(?:каде|kade|где|gde|where|кај|kaj)\s+(?:поточно|потoчno|potocno|точно|tocno|tochno|ориентино|ориентирно|приближно|бас|bas)?\s*(?:(?:се|se)\s+)?(?:наоѓа|наоjа|naogja|naoga|е|e|се|se|is)(?=\s|[?!.]|$)/iu; // wo+se: removed 'да\s+' from modifier to avoid backtracking issues
// A bare "каде?" / "kade ?" means "where [is it]?" — the last shown property.
const WHERE_BARE_RE = /^(?:каде|каде|где|где|кај|кај|wхере)\s*\??\s*$/iu;
// "што има во близина?" / "what's nearby?" — NEARBY questions about the last shown property.
// "blizina/близина" MUST be preceded by a preposition (во/в/near) to avoid
// matching "има близина" (there's a closeness) or random mentions.
// "something else (well-known)?" family — client wants a MORE RECOGNIZABLE
// nearby landmark than the one just given. Grammar:
//   [drugo/druго] × [nesto] × [poznato]   |   nesto × poznato   |   poznato × mesto
// Word-boundary guarded so "запознаен" (contains "познат") never triggers.
const NEARBY_ALT_RE = new RegExp(
  '(?<![\\p{L}])' +
  '(?:' +
  // 'drugo nesto poznato?' — requires poznato; bare 'drugo nesto' is too
  // broad and catches search queries ('drugo nesto poeftino' = something
  // cheaper, not a landmark question).
  '(?:друго|друго)\\s+(?:нешто|несто)\\s+(?:познат[ао]|познат[ао]?)' +
  '|' +
  '(?:нешто|несто)\\s+(?:познат[ао]|познат[ао]?)' +
  '|' +
  '(?:познат[ао]|познат[ао]?)\\s+(?:место|место)' +
  // 'што уште има познато во реонот' / 'што уште има познато'
  '|' +
  'што\\s+уште\\s+има\\s+познат' +
  // 'кое познато место е во близина'
  '|' +
  'кое\\s+познат' +
  // 'какво познато има' / 'што познато има'
  '|' +
  '(?:што|какво|кој|кое)\\s+познат' +
  // 'што друго познато' / 'друго познато'
  '|' +
  '(?:друго\\s+)?познат' +
  // 'познати места' / 'познати локации'
  '|' +
  'познат[иае]\\s+(?:места|локации|објекти)' +
  // 'ube poznato' / 'poznato mesto' / 'poznata lokacija'
  '|' +
  'poznato\\s+(?:mesto|lokacija|places?)' +
  '|' +
  'poznata\\s+(?:lokacija|mesto)' +
  '|' +
  'poznati\\s+(?:mesta|lokacii|places)' +
  // 'what else is known' / 'what is known nearby'
  '|' +
  'what\\s+else\\s+(?:is\\s+)?(?:known|poznato)' +
  '|' +
  'what\\s+(?:is\\s+)?(?:known|poznato)\\s+nearby' +
  // 'kazi mi sto poznato ima' / 'кажи ми што познато има'
  '|' +
  '(?:кажи|kazi)\\s+(?:ми\\s+)?(?:што|sto)\\s+познат' +
  // 'уveal e poznato' / 'uvek poznato'
  '|' +
  '(?:уше|ushе|уште|uste)\\s+има\\s+познат' +
  // 'okolina' / 'околина' / 'reon' / 'реон' with poznato
  '|' +
  'познат[аои]?\\s+(?:во|vo|на|na)\\s+(?:реон|reon|околина|okolina|близина|blizina)' +
  '|' +
  '(?:во|vo|на|na)\\s+(?:реон|reon|околина|okolina)\\s+.*\\s+познат' +
  ')',
  'iu');

const NEARBY_RE = /(?:што|што|што|wхат|кој|кое|кој|кое)\s+(?:има|има|хаве|имате)\s+(?:во|во|v|неар)\s+(?:близина|близина|вицинитy)|(?:во|во|v|неар)\s+(?:близина|близина|вицинитy)(?:\s*\?|$)|wхат\s+(?:ис\s+)?неарбy|цо\s+је\s+(?:v\s+)?близини/iu;
const WHERE_IS_DETERMINER = /^(?:тоа|toa|тој|toj|таа|taa|ова|ova|оваа|ovaa|овој|ovoj|она|ona|онаа|onaa|оној|onoj|the|that|it)\s+/iu;
// Generic referents = the last shown property, not a named place.
const WHERE_IS_GENERIC =
  /^(?:деловниот простор|delovniot prostor|деловен простор|deloven prostor|локалот|lokalot|локал|lokal|станот|stanot|стан|stan|куќата|kukjata|kukata|куќа|kukja|kuka|зградата|zgradata|зграда|zgrada|имотот|imotot|имот|imot|објектот|objektot|објект|objekt)$/iu;
// Non-place words that happen to follow "каде е" ("до каде е цената?") —
// those are NOT place questions and must fall through to normal handling.
const WHERE_IS_BLACKLIST =
  /^(?:цената|cenata|цена|cena|евра|evra|киријата|kirijata|кирија|kirija|бројот|brojot|број|broj|шифрата|sifrata|шифра|sifra|достапен|dostapen|достапна|dostapna|сместен|smesten|сместена|smestena|паркингот|parkingot|паркинг|parking)$/iu;

/**
 * "каде е X?" — a question about a PLACE's whereabouts ("каде е Палома
 * Бјанка?", "каде се наоѓа тој стан?", bare "каде?"). This is NEVER a
 * search for properties IN X — treating it as one produced the bogus
 * "exhausted all properties in Палома Бјанка" reply. Returns the extracted
 * place, or { generic: true } when the client means the last shown property.
 */

const PROPERTY_TYPE_END_RE = /(?:гарсоњер(?:ата|та|а)|гарсоњер(?:а|a|ата|та)|стан(?:от)?|стан(?:от)?|куќ(?:ата|а)|куќ(?:ата|a|e)|дуќ(?:анот?|ан)|дукѓан(?:от?|а?)|лок(?:алот?|ал)|локал(?:от?|а?)|делов(?:ниот|ниот|ен)|деловен(?:\s+простор)?|објект(?:от)?|објект(?:от)?|зград(?:ата|а)|зград(?:ата|а?)|имот(?:от)?|имот(?:от)?|плац(?:от)?|плац(?:от)?)$/iu;
const WHERE_IS_BLACKLIST_START = /^(?:цената|цената|циената|цена|цена|циена|колк[ао]|колко|колку|колку|бројот|бројот|број|број|шифрата|сифрата|шифра|сифра|достапен|достапен|достапна|достапна|сместен|сместен|сместена|сместена)/iu;

export function detectWhereIs(text: string): WhereIsQuestion | undefined {
  if (matchesBoth(WHERE_BARE_RE, text)) return { place: '', generic: true };
  // "што има во близина?" / "what's nearby?" — treated as "where is it?" for the last shown property.
  if (matchesBoth(NEARBY_RE, text)) return { place: '', generic: true };
  // "drugo nesto poznato?" / "nesto poznato?" / "poznato mesto?" — the client
  // wants the NEXT recognizable nearby landmark: advance the rotation.
  if (matchesBoth(NEARBY_ALT_RE, text)) return { place: '', generic: true };
  // "каде точно се наоѓа?" / "where exactly is it?" — a generic where-is
  // that should get a nearby landmark, not the privacy protocol.
  if (isKadeTocno(text)) return { place: '', generic: true };

  // ===== GRAMMAR RULE: the whole "каде … адресата/локацијата" family =======
  // Macedonian location questions are combinatorial:
  //   каде × [точно|поточно] × [ми|му|и] × [е|би|ке|се наоѓа] × [адресата|локацијата]
  // Enumerating phrases always lags real speech — this filler-token loop
  // covers EVERY combination, including phrasings nobody predicted
  // ("kade mu e lokacijata", "каде адресата?", "kade samo e adresata").
  // Any каде-prefixed question whose object is an address/location noun
  // gets landmark rotation. Explicit demands WITHOUT каде ("дај ми ја
  // адресата", "улица и број") still hit EXACT_ADDRESS.
  // NOTE: улиц(ата) deliberately excluded — "каде е улицата Партизанска?"
  // is a named-place query, not a generic where-is about THE property.
  if (matchesBoth(KADE_ADDR_NOUN_RE, text)) return { place: '', generic: true };

  // ===== SECONDARY CHECK: Missing patterns not caught by WHERE_IS_RE =====
  // These cover property-type variants ("каде е вилата?"), smesten variants,
  // typos, and follow-up phrases ("да ама која улица") that the main regex
  // misses because they lack a "каде" prefix or have unexpected structures.
  const lower = text.toLowerCase();
  const norm = normalizeMc(text); // Cyrillic-canonical — covers Latin inputs via Cyrillic entries
  const whereIsSecondary = [
    // Property type variants
    'каде е имотот', 'kade e imotot',
    'каде е станот', 'kade e stanot',
    'каде е куќата', 'kade e kukata',
    'каде е вилата', 'kade e vilata',
    'каде е локалот', 'kade e lokalot',
    // NOTE: 'каде е тоа' intentionally OMITTED — the main WHERE_IS_RE handles
    // "каде е тоа X?" by stripping "тоа" via WHERE_IS_DETERMINER and
    // extracting X as the place. Adding it here would break place extraction.
    // Smeten variants (blacklisted in WHERE_IS_BLACKLIST but valid WHERE_IS)
    'каде е сместен', 'kade e smeten',
    'каде е сместена', 'kade e smetena',
    'каде е сместено', 'kade e smeteno',
    // Formal location variants
    'каде се наоѓа имотот', 'kade se naogja imotot',
    'каде се наоѓа станот', 'kade se naogja stanot',
    'каде се наоѓа куќата', 'kade se naogja kukata',
    // "каде во X се наоѓа" — where in X is it (area-qualified)
    'каде во центар се наоѓа', 'kade vo centar se naogja',
    'каде во аеродром се наоѓа', 'kade vo aerodrom se naogja',
    'каде во карпош се наоѓа', 'kade vo karpos se naogja',
    'каде во водно се наоѓа', 'kade vo vodno se naogja',
    'каде во кисела вода се наоѓа', 'kade vo kisela voda se naogja',
    'каде во центар е', 'kade vo centar e',
    'каде во аеродром е', 'kade vo aerodrom e',
    // Typo variants
    // "каде му е адресата/локацијата" — CORRECT spellings. These MUST live
    // here (not just in EXACT_ADDRESS_RE): any phrase starting with каде/kade
    // is a where-is question and gets Landmark #1. Without this, the
    // EXACT_ADDRESS_RE branch '(?:каде)...(?:му\s+)?(?:е)\s+(?:адресата|локацијата)'
    // captures them and the client gets the privacy protocol instead of the
    // landmark — same question, different phrasing, different answer.
    'каде му е адресата', 'kade mu e adresata',
    'каде му е локацијата', 'kade mu e lokacijata',
    'каде му е локација', 'kade mu e lokacija',
    'каде му е адерасата', 'kade mu e aderasa',
    'каде се наога имотот', 'kade se naoga imotot',
    'каде се наога станот', 'kade se naoga stanot',
    'каде се наога куќата', 'kade se naoga kukata',
    // FOLLOW-UP PHRASES (trigger landmark rotation, not protocol)
    'да ама која улица', 'da ama koja ulica',
    'да ама кој број', 'da ama koj broj',
    'да ама каде точно', 'da ama kade tocno',
    'да ама каде поточно', 'da ama kade potocno',
    'добро ама каде е', 'dobro ama kade e',
    'добро ама која улица', 'dobro ama koja ulica',
    'добро ама кој број', 'dobro ama koj broj',
    'се согласувам ама адресата', 'se soglasuvam ama adresata',
    'а која е адресата', 'a koja e adresata',
    'а улица и број', 'a ulica i broj',
    'а точно каде', 'a tocno kade',
    'а поточно каде', 'a potocno kade',
    'а која е точната локација', 'a koja e tocnata lokacija',
    'добро а каде е', 'dobro a kade e',
    'да а каде е', 'da a kade e',
    // "каде по точно" — the 'по' between каде and точно defeats the main regex
    'каде по точно', 'kade po tocno',
    'каде по поточно', 'kade po potocno',
    // bare "каде поточно / kade potocno?" with no verb after
    'каде поточно ?', 'каде поточно?', 'kade potocno ?', 'kade potocno?',
    // Nearby-area follow-ups ("what else is nearby?")
    'што уште има во околината', 'sto uste ima vo okolinata',
    'што има околу', 'sto ima okolu',
    'што уште има околу', 'sto uste ima okolu',
    'што друго има', 'sto drugo ima',
    'што друго е околу', 'sto drugo e okolu',
    'кои објекти има', 'koi objekti ima',
    'какви објекти има', 'kakvi objekti ima',
    'какво има околу', 'kakvo ima okolu',
    'што е во близина', 'sto e vo blizina',
    'што уште е во близина', 'sto uste e vo blizina',
    'кој е во близина', 'koj e vo blizina',
    'кои се во близина', 'koi se vo blizina',
    // ── кои/какви објекти се/има (which/what objects are/has) ──
    'кои објекти се тука', 'koi objekti se tuka',
    'какви објекти се тука', 'kakvi objekti se tuka',
    'кои објекти се околу', 'koi objekti se okolu',
    'какви објекти се околу', 'kakvi objekti se okolu',
    'кои објекти се близу', 'koi objekti se blizu',
    'какви објекти се близу', 'kakvi objekti se blizu',
    'кои објекти има тука', 'koi objekti ima tuka',
    'какви објекти има тука', 'kakvi objekti ima tuka',
    'кои објекти има околу', 'koi objekti ima okolu',
    'какви објекти има околу', 'kakvi objekti ima okolu',
    'кои објекти има близу', 'koi objekti ima blizu',
    'какви објекти има близу', 'kakvi objekti ima blizu',
    // ── кои/какви други објекти (which/what other objects) ──
    'кои други објекти се тука', 'koi drugi objekti se tuka',
    'кои други објекти има', 'koi drugi objekti ima',
    'кои други објекти има околу', 'koi drugi objekti ima okolu',
    'какви други објекти се тука', 'kakvi drugi objekti se tuka',
    'какви други објекти има', 'kakvi drugi objekti ima',
    // ── што + се наоѓа (what is located) ──
    'што се наоѓа околу', 'sto se naogja okolu',
    'што се наоѓа тука', 'sto se naogja tuka',
    'што е тука', 'sto e tuka',
    // ── уште/друго што (more/other what) ──
    'уште што има', 'ste sto ima',
    'друго што има', 'drugo sto ima',
    'уште што има околу', 'ste sto ima okolu',
    'околу што има', 'okolu sto ima',
    'околу што се наоѓа', 'okolu sto se naogja',
    // ── има ли нешто (is there something) ──
    'има ли нешто тука', 'ima li nesto tuka',
    'има ли нешто друго тука', 'ima li nesto drugo tuka',
    // ── што можеш/знаеш да кажеш за локациjата (what can/tell about location) ──
    'што можеш да ми кажеш за локациjата', 'sto mozes da mi kazes za lokacijata',
    'што знаеш за локациjата', 'sto znaes za lokacijata',
    'кажи ми за локациjата', 'kazi mi za lokacijata',
    'што е локациjата', 'sto e lokacijata',
    'каде е локациjата', 'kade e lokacijata',
    // ── одприлика кaj се наоѓа (approximately where) ──
    'одприлика кaj се наоѓа', 'odprilika kaj se naogja',
    'одприлика кade', 'odprilika kade',
  ];
  if (whereIsSecondary.some(p => lower.includes(p) || norm.includes(p))) {
    return { place: '', generic: true };
  }
  // ===== END SECONDARY CHECK =====

  const m = text.match(WHERE_IS_RE);
  if (!m) return undefined;
  let rest = text.slice((m.index ?? 0) + m[0].length).trim();
  rest = rest.replace(WHERE_IS_DETERMINER, '').replace(/[?!.]+$/u, '').trim();
  // Strip trailing clauses after a comma — "кaj се наоѓа, за да знам дали е за мене"
  // The part after the comma is a reason/explanation, not a place name.
  rest = rest.replace(/,.*$/u, '').trim();
  // "каде се наоѓа?" / "where is it?" — no named place, means the last
  // shown property (same as bare "каде?"). Without this, the verb form
  // falls through to the classifier and re-shows the property card.
  if (!rest) return { place: '', generic: true };
  if (WHERE_IS_GENERIC.test(rest)) return { place: '', generic: true };
  // EB number: "каде е 89?" — look up directly by evidence number.
  const ebRest = rest.replace(/(?:евидентен\s+)?(?:број|broj|еб|eb)\s*/iu, '').trim();
  if (/^\d{1,5}$/.test(ebRest)) return { place: ebRest, generic: false };
  if (WHERE_IS_BLACKLIST.test(rest)) return undefined;
  if (rest.length < 3) return undefined;
  return { place: rest, generic: false };
}

// "потoчно која улица?", "точно која адреса?", "на која адреса е?", "која е
// точната локација?" — the client wants the EXACT street/address of a shown
// property. Address PRIVACY is absolute: this is answered with the exact-
// address line (Точната адреса ќе ја добиете 2 часа пред посетата), NEVER
// with the street. Detected separately from detectWhereIs because these
// questions must NOT get the landmark/населба answer — the client explicitly
// asked past it. Latin + Cyrillic.
const EXACT_ADDRESS_RE =
  /(?:улица|ulica|улицата|ulicata)\s+(?:и|i)\s+(?:број|broj|бројот|brojot)|(?:moram|mora|treba|морам|мора|треба)\s+(?:(?:да|da)\s+)?(?:(?:ја|ja)\s+)?(?:знам|znam|znaam|знаам)\s+(?:адресата|adresata|улицата|ulicata|локацијата|lokacijata)|(?:prvo|прво|first)\s+(?:адресата|adresata|улицата|ulicata|локацијата|lokacijata|адреса|adresa|address)|(?:moram|mora|treba|морам|мора|треба)\s+(?:(?:да|da)\s+)?(?:(?:ја|ja)\s+)?(?:знам|znam)\s+(?:адресата|adresata|улицата|ulicata|локацијата|lokacijata)|(?:prvo|прво|first)\s+(?:адресата|adresata|улицата|ulicata|локацијата|lokacijata|адреса|adresa)|(?:пото?чно|potocno|pokazete|покажете)\s+(?:која|koja)\s+(?:улица|ulica|адреса|adresa|локација|lokacija)|(?:точно|tochno|tocno)\s+(?:која|koja)\s+(?:улица|ulica|адреса|adresa|локација|lokacija)|(?:кажи|kazi)\s+(?:ми\s+|mi\s+)?точно\s+(?:адресата|adresata|адреса|adresa|улицата|ulicata|улица|ulica|локацијата|lokacijata|lokacija)|(?:потoчно|поточната)\s+(?:која|koja)\s+(?:улица|ulica|адреса|adresa)|(?:кажи|kazi)\s+(?:ми\s+|mi\s+)?точно\s+(?:адресата|adresata|адреса|adresa|улицата|ulicata|улица|ulica|локацијата|lokacijata|lokacija)|(?:(?:која|koja|кое|koe)\s+(?:му\s+|mu\s+)?(?:е|e)\s+(?:адресата|adresata|адреса|adresa|улицата|ulicata|улица|ulica|локацијата|lokacijata|lokacija)|(?:каде|kade|кај|kaj)\s+(?:му\s+|mu\s+)?(?:е|e)\s+(?:адресата|adresata|адреса|adresa|улицата|ulicata|улица|ulica|локацијата|lokacijata|lokacija)|(?:точна|точната|tochna|tocnata|tochnata|točna|preciznata|прецизната)\s+(?:адресата|adresata|адреса|adresa|улицата|ulicata|улица|ulica|локацијата|lokacijata|lokacija)|(?:адресата|adresata|улицата|ulicata|локацијата|lokacijata)\s*[-–]?\s*(?:точна|точната|tochna|tocnata|tochnata|točна)|(?:кажи|kazi)\s+(?:ми\s+|mi\s+)?(?:ја|ja)\s+(?:адресата|adresata|улицата|ulicata|локацијата|lokacijata)|(?:дај|daj)\s+ми\s+ја\s+(?:адресата|adresata|улицата|ulicata|локацијата|lokacijata)|(?:дај|daj)\s+mi\s+ja\s+(?:адресата|adresata|улицата|ulicata|локацијата|lokacijata)|(?:дад(?:и|ете|иј)|dadi(?:te)?)\s+(?:ми\s+|mi\s+)(?:ја\s+|ja\s+)?(?:адресата|adresata|улицата|ulicata|локацијата|lokacijata)|точно\s+(?:каде|kade)\s+(?:е|e)|каде\s+точно|kade\s+tocno|kade\s+tochno|(?:preciznata|прецизната)\s+(?:lokacija|локација)|(?:moram|mora|treba|морам|мора|треба)\s+(?:(?:да|da)\s+)?(?:знам|znam)\s+(?:каде|kade)\s+(?:е|e|се\s+нао[гѓ]а|se\s+naogja|се|se)|za\s+da\s+se\s+odlu(?:cam|čam)|за\s+да\s+се\s+одлу(?:чам|кам)|(?:адресата|adresata|улицата|ulicata|локацијата|lokacijata)\s+(?:ќе|ke|да)\s+(?:ја|ja)\s+(?:доби|dobij|dobam|знам|znam|кажи|kazi)|(?:адресата|adresata)\s+(?:ќе|ke|да)\s+(?:ја|ja)\s+(?:доби|dobij|dobam|знам|znam)\s+кога|(?:на\s+која|na\s+koja)\s+(?:адресата|adresata|адреса|adresa|улицата|ulicata|улица|ulica|локацијата|lokacijata|lokacija)|(?:која|koja)\s+(?:е|e)\s+(?:адреса|adresa)\s+(?:на|na)\s+(?:стан|stanot|sopstvenik)|(?:која|koja)\s+(?:му\s+|mu\s+)?(?:е|e)\s+(?:точната|точн|tochnata|tocnata|tochn|tocn|preciznata|прецизната)\s+(?:локација|lokacija|адреса|adresa|улица|ulica)|(?:покажете|pokazete)\s+(?:ми\s+|mi\s+)?(?:ја|ja)?\s*(?:адресата|adresata|улицата|ulicata|локацијата|lokacijata)|(?:адресата|adresata|улицата|ulicata|локацијата|lokacijata)\s*\?)/iu;

// Filler tokens allowed between "каде" and the address/location noun.
// Anything outside this set (e.g. a place name) stops the match so named
// queries like "каде се наоѓа Рамстор?" keep their place extraction.
const KADE_ADDR_NOUN_RE = new RegExp(
  '(?:каде|каде)' +
  '(?:\\s+(?:точно|тоцно|точно|поточно|потоцно|ми|ми|му|му|и|i|е|e|се|се|нао[ѓг]а|нао[ѓ]a|би|би|било|било|била|била|биле|биле|биде|биде|бидат|бидат|ке|ке|ќе|само|само))*' +
  '\\s*' +
  '(?:адрес(?:ата|а)|адрес(?:ата|a)|локациј(?:ата|а)|локациј(?:ата|a))' +
  '(?![а-яa-z])',
  'iu',
);

/** True when the client asks for the EXACT street/address of a property. */
export function detectExactAddressAsk(text: string): boolean {
  // Main regex check (raw + normalized so Cyrillic-only branches cover Latin)
  if (matchesBoth(EXACT_ADDRESS_RE, text)) return true;

  // ===== SECONDARY CHECK: Missing patterns not caught by EXACT_ADDRESS_RE =====
  const lower = text.toLowerCase();
  const exactAddressSecondary = [
    // Cadastral queries
    'кој катастар', 'koj katastar',
    'кој катастарски број', 'koj katastarski broj',
    'катастарска општина', 'katastarska opshtina',
    // Short demands
    'адреса сега', 'adresa sega',
    'дај адреса', 'daj adresa',
    'кажи адреса', 'kazi adresa',
    'дај адреса сега', 'daj adresa sega',
    'кажи адреса сега', 'kazi adresa sega',
    // Formal street queries
    'во која улица е', 'vo koja ulica e',
    'во која улица се наоѓа', 'vo koja ulica se naogja',
    'која е точната адреса', 'koja e tocnata adresa',
    // "What is the address?" variants
    'што е адресата', 'sto e adresata',
    'што е точната адреса', 'sto e tocnata adresa',
    // Precision demands
    'прецизна адреса', 'precizna adresa',
    'прецизна локација', 'precizna lokacija',
    // Priority requests (only those NOT already in EXACT_ADDRESS_RE)
    'прво локација', 'prvo lokacija',
    'прво точно каде', 'prvo tocno kade',
    'прво поточно каде', 'prvo potocno kade',
    // Additional formal variants
    'точна адреса', 'tocna adresa',
    'точна локација', 'tocna lokacija',
    'целосна адреса', 'celosna adresa',
    // Polite requests (no demand verb — "please" family)
    'молам адресата', 'molam adresata',
    'молам ја адресата', 'molam ja adresata',
    'адресата ве молам', 'adresata ve molam',
    'молам локацијата', 'molam lokacijata',
    // Want-to-know family
    'сакам да знам адресата', 'sakam da znam adresata',
    'сакам да знам локацијата', 'sakam da znam lokacijata',
    'би сакал адресата', 'bi sakal adresata',
    'би сакала адресата', 'bi sakala adresata',
  ];
  if (exactAddressSecondary.some(p => lower.includes(p) || normalizeMc(text).includes(p))) return true;
  // ===== END SECONDARY CHECK =====

  return false;
}

// "каде точно" patterns — these are WHERE_IS questions that should get
// a nearby landmark first, NOT the privacy protocol.
const KADE_TOCNO_RE = /(?:каде|каде)\s+(?:точно|тоцно|точно)|(?:точно|тоцно|точно)\s+(?:каде|каде)/iu;
/** True when the text is a "where exactly" question (not an explicit address demand). */
export function isKadeTocno(text: string): boolean {
  return matchesBoth(KADE_TOCNO_RE, text);
}

// =========================================================================
// NEW SCENARIO DETECTORS — bank-backed, deterministic
// =========================================================================

// Off-topic redirect: the client asks about Lina herself, small talk, or
// gibberish — NOT related to real estate. Redirect to the funnel.
const OFFTOPIC_RE =
  /(?:кој\s+(?:си|сте|е)\s+(?:ти|вие)?|што\s+(?:си|сте|правиш|правите|бараш|бараете)|како\s+(?:си|сте|е|викаш|викате)|(?:who\s+are\s+you|what\s+(?:are\s+you|do\s+you|is\s+your)|how\s+are\s+you|whats\s+up|hey|sup|hello\b|hi\b|привет|здраво\s+до)|колку\s+(?:години|пати|pline)\s+(?:си|сте|имаш|имате)|(?:tell\s+me\s+about\s+yourself|што\s+мислиш\s+за)|(?:дени|ноќи|denes|utre|vecher|sonce|dazhd|sneg|vreme)[^.!?]*\?)/iu;

/** True when the message is off-topic / small talk / self-intro question. */
export function detectOfftopic(text: string): boolean {
  return matchesBoth(OFFTOPIC_RE, text);
}

// Follow-up defer: the client is not ready to decide.
const DEFER_RE =
  /(?:ќе\s+размислам|ќе\s+размислувам|ќе\s+се\s+јавам|ќе\s+се\s+техам|подоцна\s+ќе|не\s+сега|не\s+сум\s+сигурен|сега\s+не\s+сум|sakam\s+da\s+razmislam|ke\s+se\s+javam|podocna\s+ke|sakam\s+pa\s+razmislam|ke\s+razmislam|podocna\s+ke\s+se|ne\s+sum\s+siguran|ne\s+e\s+segas|sega\s+ne\s+sum|not\s+now|later|maybe\s+later|i.ll\s+(?:think|call|contact)|let\s+me\s+(?:think|check)|give\s+me\s+(?:a\s+)?(?:day|time|sec)|zapisete\s+me|запишете\s+ме|запиши\s+ме|евидентирај\s+ме|регистрирај\s+ме)/iu;

// GRAMMAR RULE for the same family: future-marker (ќе/би/подоцна) followed by
// up to two filler words then a decision-delay verb — covers every conjugation
// and word-order variation ("ќе размислам", "би се јавел подоцна", "ke ve
// povikam potoa", "подоцна ќе пишам") without enumerating phrases.
const DEFER_GRAMMAR_RE = new RegExp(
  '(?:ќе|ке|би|би|подоцна|подоцна|потоа|потоа|после|после)' +
  '(?:\\s+[а-яa-z]+){0,3}?' +
  '\\s+(?:размисл|размисл|јав|јав|повик|повик|вид|вид|пиш|пиш|пис|тех|тех|контакт|контакт)',
  'iu');

/** True when the client wants to defer the decision. */
export function detectDefer(text: string): boolean {
  return matchesBoth(DEFER_RE, text) || matchesBoth(DEFER_GRAMMAR_RE, text);
}

// Price negotiation: the client asks to lower the price or requests a discount.
const NEGOTIATE_RE =
  /(?:може\s+ли\s+(?:помала|пониска|поевтина|поевтин|помал)|може\s+ли\s+(?:нешто|nesto)?\s*поевтин[оа]|moze\s+li\s+(?:nesto\s+)?poevtin[oа]|помала\s+(?:цена|евра|евро)|пониска\s+(?:цена|евра)|поевтин\s+(?:стан|нешто)|дали\s+(?:има|постои|ќе\s+има)\s+попуст|попуст|popust|намалување|namaluvanje|појефтинување|pojeftinuvanje|може\s+ли\s+да\s+се\s+договориме\s+за\s+цена|дали\s+е\s+(?:фиксна|финална|конечна)\s+цена|can\s+(?:you|we)\s+(?:lower|reduce|drop|negotiate|cut)\s+(?:the\s+)?(?:price|cost)|discount|cheaper|lower\s+price|price\s+(?:reduction|cut|drop|negotiat)|any\s+(?:wiggle|flexibility|room)\s+(?:on\s+the\s+)?price|is\s+(?:the\s+)?(?:price|cost)\s+(?:fixed|firm|final|negotiable)|negotiate)/iu;

// GRAMMAR RULE for negotiation: price-adjective + price-noun in either order,
// with optional fillers — covers "цена малку помала", "po evtina cena?",
// "дали цената е конечна тука" without enumerating each phrase.
const NEGOTIATE_GRAMMAR_RE = new RegExp(
  '(?:помал[ао]|пониск[ао]|поевтин[ао]?|фиксн[ао]|финалн[ао]|конечн[ао]|помал[ао]|пониск[ао]|поевтин[ао]?|фиксн[ао]|финалн[ао]|конечн[ао])' +
  '(?:\\s+(?:тука|тука|овде|овде|малку|малку|доста|доста|многу|многу))*' +
  '\\s+(?:цена|цена\\s+е|цената|цена|цената|евра|евро|евра|евро)' +
  '|' +
  '(?:цена|цената|цена|цената)\\s+(?:да\\s+)?(?:се\\s+)?(?:намали|намалува|смале|спушти|договори|договори)',
  'iu');

/** True when the client wants to negotiate the price. */
export function detectNegotiate(text: string): boolean {
  return matchesBoth(NEGOTIATE_RE, text) || matchesBoth(NEGOTIATE_GRAMMAR_RE, text);
}

// Provision / commission ask.
const PROVISION_RE =
  /(?:провизи[јjа]+|provizija|provizion|provizia|commission|агенциск[аои]\s+(?:надомест|цена|трошок|услуга)|агенциск[аои]а?т?а?\s+услуга|[аa]генck[аa]а?т?[аa]?\s+(?:услуга|usluga)|agencka[аaтt]*\s+(?:услуга|usluga)|колку\s+(?:е|е\s+провизијата|чиња)|(?:дали|dali)\s+(?:има|постои|ќе\s+плаќам)\s+провизиј)/iu;

/** True when the client asks about provision/commission. */
export function detectProvisionAsk(text: string): boolean {
  return PROVISION_RE.test(text);
}

// Provision who-pays: the client asks WHO pays the lawyer/notary/tax —
// "кој плаќа advokat?", "notarot koj go plakja?", "danokot e nivna obvrskа"
const PROVISION_WHO_RE = /\b(?:кој|koj)\b[^.!?\n]{0,30}\b(?:плаќа|plakja|сносва|snosva|покрива|pokriva)\b|\b(?:адвокат|advokat|нотар|notar|нотарот|notarot|адвокатот|advokatot|danok|данок|данокот|danokot)\b[^.!?\n]{0,20}\b(?:плаќа|plakja|сносва|snosva|покрива|pokriva)\b|\b(?:кој|koj)\s+(?:плаќа|plakja)\s*\?|трошо(?:к|ци)\s+(?:за|на)\s+(?:адвокат|advokat|нотар|notar)|trosho(?:k|ci)\s+(?:za|na)\s+(?:advokat|notar)/iu;
/** True when the client asks WHO pays lawyer/notary/tax. */
export function detectProvisionWho(text: string): boolean {
  return PROVISION_WHO_RE.test(text);
}

// Price ask — the client asks about the property price: "која е цената?",
// "колку чини?", "what is the price?", "KE MU E CENATA?". Latin + Cyrillic.
// "колку е 60.000" (stating a price) is NOT this — only questions.
// "ne ja pamtam cenata" / "не ја памтам цената" — client forgot the price, wants it restated.
const PRICE_ASK_RE = /(?:која|колку|кое|која|колку|koe|koja|kolku|what\s+is|ke\s+mu\s+e|e\s+mu\s+e|mu\s+e)[^.!?\n]{0,20}(?:цена|цена|цени|цени|цената|cena|ceni|cenata|price|евра|евро|евра|евро|еуро|eur)|(?:колку|колку|kolku|kolku|колку|cenata|цена|cena|цена|price|евра|evra|евро|евро)[^.!?\n]{0,15}(?:чини|чини|iznesuva|изнесува|е|e|costs?|bi\s+trebalo)|\b(?:цена|цена|cena|cenata|цена|cenata|цени|ceni|price)\s*\?|\b(?:колку|колку|kolku|колку)\s*\?|(?:не|не|ne|ne)\s+(?:ја|ја|ja|ja|се|се|se|se)\s+(?:памтам|памтам|pamtam|pamtam|сеќавам|секавам|sekavam|запомнам|запомнам|zapomnam|zapomnam)(?:\s+(?:на|на|na|na))?[^.!?\n]{0,10}(?:цената|цената|cenata|cenata|цена|цена|cena|cena)|\b(?:не\s+ја\s+памтам|не\s+се\s+сеќавам|не\s+се\s+секавам|ne\s+ja\s+pamtam|ne\s+se\s+sekavam)\b[^.!?\n]{0,10}(?:цена|cenata)/iu;

/** True when the client asks about the property price. */
export function detectPriceAsk(text: string): boolean {
  return matchesBoth(PRICE_ASK_RE, text);
}

// Scheduling flexibility: the client specifies a preferred day/time window.
const SCHED_FLEX_RE =
  /(?:може\s+ли\s+(?:викенд|сабота|недела|sabota|nedela|weekend|saturday|sunday)|само\s+(?:попладне|утрово|вечер|popladne|napladne|utro|vecher|afternoon|morning|evening)|само\s+претпладне|утро\s+само|afternoon\s+only|morning\s+only|evening\s+only|weekend\s+only)/iu;

// GRAMMAR RULE: [само|може ли|bi sakal] × time-window word, and the reversed
// order (window first, "само/only" after). Covers "samo vo utro moze?",
// "popladne samo", "може викендот?" without enumeration.
const SCHED_FLEX_GRAMMAR_RE = new RegExp(
  '(?:само|само|може\\s+ли|мозе\\s+ли|би\\s+сакал[аи]?)' +
  '(?:\\s+(?:во|во|на|на|околу|околу))*' +
  '\\s*(?:утро|утрово|претпладне|попладне|напладне|вечер|вечерво|викенд|wеекенд|сабота|саботите|недела|недела|утро|претпладне|попладне|вечер|вецер|викенд|сабота)' +
  '|' +
  '(?:утро|утрово|претпладне|попладне|напладне|вечер|вечерво|викенд|wеекенд|сабота|недела|утро|попладне|вечер|вецер|викенд|сабота)' +
  '\\s+(?:само|само|онлy)',
  'iu');

/** True when the client specifies a scheduling window. */
export function detectSchedulingFlex(text: string): boolean {
  return matchesBoth(SCHED_FLEX_RE, text) || matchesBoth(SCHED_FLEX_GRAMMAR_RE, text);
}

// Escalation polite: the client asks to speak with a manager.
const ESCALATION_RE =
  /(?:сакам\s+(?:да\s+)?(?:разговарам|зборувам|контактирам|пишувам)\s+(?:со|кај)\s+(?:менаџер|управител|шеф|директор)|sakam\s+(?:manager|менаџер|supervisor|управител)|разговара[јите]?\s+со\s+(?:менаџер|управител|директор|шеф)|talk\s+(?:to|with)\s+(?:a\s+)?(?:manager|supervisor|boss|director|owner)|speak\s+(?:to|with)\s+(?:a\s+)?(?:manager|supervisor|boss)|сакам\s+(?:надзор|одговорни|погоре)|не\s+ми\s+е\s+јасно\s+со\s+(?:вас|ти))/iu;

// Escalation grammar: [request verb] × [authority noun] — covers every
// combination without enumerating full phrases.
const ESCALATION_GRAMMAR_RE = new RegExp(
  '(?:сакам|сакам|треба|треба|нека|нека|дали\\s+можам|дали\\s+можам|барам|барам)' +
  '\\s+(?:(?:да|да)\\s+)?((?:разговарам?|разговарај|зборувам?|зборувај|контактирам?|контактирај|јавам?|пишувам?)' +
  '|(?:разговарам?|разговарај|зборувам?|зборувај|контактирам?|контактирај|јавам?|писувам?))?' +
  '(?:\\s+(?:со|со|кај|кај))?\\s*' +
  '(?:менаџер(?:от|[аи])?|менадзер(?:от|[аи])?|шеф(?:от|а)?|шеф(?:от|a)?|управител(?:от|[аи])?|управител(?:от|a)?|директор(?:от|[аи])?|директор(?:от|a)?|раководител(?:от|[аи])?|раководител(?:от|a)?|надзорен?|надзорен?)' +  '|' +
  // Bare imperative: "зборувај со шефот", "razgovarajte so direktorot"
  '(?:разговарајте?|зборувајте?|разговарајте?|зборувајте?)\\s+(?:со|со|кај|кај)\\s+' +
  '(?:менаџер(?:от|[аи])?|менадзер(?:от|[аи])?|шеф(?:от|а)?|шеф(?:от|a)?|управител(?:от|[аи])?|управител(?:от|a)?|директор(?:от|[аи])?|директор(?:от|a)?|раководител(?:от|[аи])?|раководител(?:от|a)?)' +
  '|' +
  '(?:менаџер(?:от|[аи])?|менадзер(?:от|[аи])?|шеф(?:от|а)?|шеф(?:от|a)?|управител(?:от|[аи])?|управител(?:от|a)?|директор(?:от|[аи])?|директор(?:от|a)?|раководител(?:от|[аи])?|раководител(?:от|a)?)' +
  '\\s+(?:нека|нека|треба\\s+да|треба\\s+да)\\s+(?:(?:се|се)\\s+)?(?:јави|јави|контактира|контактира|(?:се|се)\\s+обади|обади)',
  'iu');

/** True when the client asks for a manager / escalation. */
export function detectEscalation(text: string): boolean {
  return matchesBoth(ESCALATION_RE, text) || matchesBoth(ESCALATION_GRAMMAR_RE, text);
}
// Documents info: the client asks what documents they need.
const DOCUMENTS_RE =
  /(?:какви\s+документи|кои\s+документи|документи\s+(?:ми\s+требаат|треба\s+да\s+имам|ќе\s+ми\s+требаат)|what\s+(?:doc|paper|form)|need\s+(?:i\s+)?(?:any|some)?\s*(?:doc|paper|form)|што\s+треба\s+за\s+(?:купување|изнајмување)|документација\s+за|документи|документација|договор|договори|документи\b|договор\b|документација\b|doc(?:ument)?s?|papers?|forms?)/iu;

/** True when the client asks about required documents. */
export function detectDocumentsAsk(text: string): boolean {
  return matchesBoth(DOCUMENTS_RE, text);
}

// Mortgage / credit info: the client mentions credit/mortgage or asks about financing.
const MORTGAGE_RE =
  /(?:со\s+(?:кредит|банка|loan|mortgage|credit)|купувам\s+со\s+кредит|имам\s+кредит|од\s+банка\s+купувам|банка\s+ми\s+(?:одобри|одобрила|дава)|credit|mortgage|хипотека|hypoteka|купување\s+(?:со|преку)\s+(?:кредит|банка)|can\s+(?:i|we)\s+(?:buy|purchase|finance|get\s+a\s+(?:loan|mortgage|credit))|кредит(?:\s|$)|банка(?:\s|$)|loan(?:\s|$)|mortgage(?:\s|$)|credit(?:\s|$)|банкарски)/iu;

/** True when the client mentions mortgage / credit / bank financing. */
export function detectMortgageAsk(text: string): boolean {
  return matchesBoth(MORTGAGE_RE, text);
}

// Neighborhood general: the client asks general questions about neighborhoods.
const NEIGHBORHOOD_RE =
  /(?:во\s+(?:која|кој)\s+(?:населба|дел|локаци|део|neighborhood|area|part)\s+(?:е\s+)?(?:најдобро|подобро|популарно|барано|барана|супер|одлично|добро)|(?:како\s+е|што\s+е|какво\s+е|каков\s+е|каква\s+е)\s+во\s+(?:центар|капиштец|карпош|аеродром|кисела\s+вода|влае|ѓорче|маџари|хиподром|ченто|орце|пржино|тафталиџе|кареа)|(?:безбедно|сигурно)\s+(?:ли\s+е|е\s+ли|во)|safe\s+(?:in|area|neighborhood)|населба(?:\s|$)|кварт(?:\s|$)|реон(?:\s|$)|лиjspx|neighborhood(?:\s|$)|area(?:\s|$))/iu;

/** True when the client asks a general neighborhood question. */
export function detectNeighborhoodAsk(text: string): boolean {
  return matchesBoth(NEIGHBORHOOD_RE, text);
}

// Comparison help: the client asks to compare two properties.
const COMPARISON_RE =
  /(?:што\s+е\s+(?:подобро|посигурно|подобра|побргзо|поевтино|поскапо|поголемо|помало)|(?:кој|која|кое)\s+е\s+(?:подобро|посигурно|подобра|побргзо|поевтин|поевтино|поскапо|поголем|поголемо|помал|помало|популарно|барано)|(?:кој|која|кое)\s+(?:ќе\s+ми\s+(?:одговара|биде\s+подобар)|е\s+(?:подобар|добар|погоден))|спореди|сравни|compare|which\s+(?:is\s+)?(?:better|cheaper|bigger|smaller|newer)|whats\s+(?:the\s+)?(?:difference|better|best)|пониско|поскапо|поголемо|помало|подобро|е\s+пониско|е\s+поскапо|е\s+поголемо|е\s+помало|е\s+подобро|poеftino|pockapo|pogolemo|pomalo|podobro|lower|higher|bigger|smaller)/iu;

/** True when the client asks to compare properties. */
export function detectComparison(text: string): boolean {
  return matchesBoth(COMPARISON_RE, text);
}

// Feature question after a property was shown: the client asks about a feature.
const FEATURE_RE =
  /(?:има\s+ли\s+(?:паркинг|лифт|кујна|тераса|башта|двор|orman|klima|garazha|garage|lift|elevator|kujna|kitchen|terasa|terrace|yard|balkon|orman|ormar|klima|centralno|kamin|solarni|alarm|video|security)|(?:дали|е\s+ли)\s+(?:е\s+)?(?:реновиран|новоградба|стар|нов)|е\s+ли\s+(?:реновиран|новоградба|стар|нов)|newly\s+renovated|renovated|new\s+build|(?:паркинг|лифт|кујна|тераса|двор|balkon|orman|klima|garazha|garage|lift|elevator|kujna|kitchen|terasa|terrace|yard|orman|ormar|klima|centralno|kamin|solarni|alarm|video|security)\s+(?:ли|да|е|има|ќе\s+има|би\s+имало)|energy\s+(?:class|rating|efficien)|енергетска\s+(?:класа|ефикасност|рејтинг)|колку\s+(?:квадрати|м2|квадратни)|колку\s+е\s+(?:голем|големина)|колку\s+(?:спални|соби)|колку\s+е\s+(?:голем|големина)|spalni|sobi|kvadrati|kolku\s+(?:spalni|sobi|kvadrati)|колку\s+спални|колку\s+соби|колку\s+квадрати|колку\s+м2|спални(?:\s|$)|соби(?:\s|$)|кујна(?:\s|$)|тераса(?:\s|$)|лифт(?:\s|$)|паркинг(?:\s|$)|garage(?:\s|$)|lift(?:\s|$)|kitchen(?:\s|$)|bedroom(?:\s|$)|parking(?:\s|$))/iu;

/** True when the client asks about a specific property feature. */
export function detectFeatureAsk(text: string): boolean {
  return matchesBoth(FEATURE_RE, text);
}

/**
 * Build the classifier event from deterministic slots. STAY when nothing was
 * detected; REJECTED against shown offers (property states) AND against the
 * current direction in the intake states ("не барам стан", "нешто друго" —
 * the handler pivots to ask what the client DOES want); a full criteria set
 * becomes SEARCH_REQUESTED (straight to presentation); service alone is
 * INTENT_DECLARED; anything partial is DETAILS_PROVIDED so discovery asks for
 * the missing pieces.
 */
export function buildEvent(state: State, slots: DetectedSlots): Event {
  const { service, location, bedrooms, sqm, business, house, budget, anywhere, need, rejected } = slots;
  const has = !!(service || location || bedrooms || budget || sqm || anywhere);
  // A rejection is honored ONLY when the message carries NO new direction —
  // "не барам стан, барам куќа" names a new type, which wins over the denial.
  // Checked BEFORE the STAY guard so a pure denial ("не барам стан", nothing
  // extracted) still becomes REJECTED instead of dead-ending as STAY.
  if (rejected && !house && !business && !need
    && ['idle', 'intent', 'discovery', 'property_locate', 'property_query', 'presentation', 'closing'].includes(state)) {
    return { type: 'REJECTED', service, location, bedrooms, sqm, business, house, budget };
  }
  // house/business count as a direction even with no other detail —
  // "не барам стан, барам куќа" must become a house request, not STAY.
  if (!has && !need && !house && !business) return { type: 'STAY' };
  // Commercial spaces complete with size (м²) instead of bedrooms; a house
  // completes with bedrooms like any apartment. "Било каде" (anywhere) satisfies
  // the location criterion AND waives the bedroom requirement — a flexible
  // client gets the budget-driven city-wide presentation ("bilo kade do 250"
  // → rent options till 250, from the most popular neighborhoods), instead of
  // being asked for a location/bedrooms they explicitly didn't care about.
  const complete = service && (location || anywhere)
    && (business ? sqm : (bedrooms || anywhere)) && budget;
  if (complete) {
    return { type: 'SEARCH_REQUESTED', service, location, bedrooms, sqm, business, house, budget, anywhere };
  }
  if (service && !location && !bedrooms && !budget && !sqm && !anywhere) {
    return { type: 'INTENT_DECLARED', service, business, house };
  }
  // A bare need ("ми треба стан", "MI TREBA STANCE") with NOTHING extracted:
  // INTENT_DECLARED with no service — routes idle -> discovery, where the
  // intent question is asked instead of dead-ending in idle. When any detail
  // WAS extracted (location, bedrooms…), normal DETAILS_PROVIDED applies.
  if (need && !has) {
    return { type: 'INTENT_DECLARED', service: undefined, business, house };
  }
  return { type: 'DETAILS_PROVIDED', service, location, bedrooms, sqm, business, house, budget, anywhere };
}


// Both services: client wants BOTH buy and rent.
const BOTH_SERVICES_RE = /(?:^|\s)(?:i\s+тоа\s+i\s+тоа|i\s+за\s+двете|за\s+двете|и\s+тоа\s+и\s+тоа|и\s+за\s+двете|за\s+двете|i\s+купам\s+i\s+киријам|и\s+купам\s+и\s+кирија|кедето|ке\s+треба(?:ат)?|ќе\s+треба(?:ат)?|сакам\s+(?:i\s+)?(?:купам|киријам)|сакам\s+(?:и\s+)?(?:купам|кирија)|две\s+работи|две\s+работи|купување\s+i\s+изнајмување|купување\s+и\s+изнајмување|i\s+купувам\s+i\s+изнајмувам|и\s+купувам\s+и\s+изнајмувам|ке\s+купам\s+i\s+киријам|ќе\s+купам\s+и\s+кирија|моз(?:e|ам|хе|ххе?|ззе?)\s+да\s+куп(?:ам|увам).*?моз(?:e|ам|хе|ххе?|ззе?)\s+(?:i\s+)?да\s+изн(?:ајм(?:увам|ам|ат)|ајм(?:ување))|може\s+да\s+куп(?:ам|увам).*?може\s+(?:и\s+)?да\s+изн(?:ајм(?:увам|ам|ат)|ајмување))/iu;
export function detectBothServices(text: string): boolean {
  return matchesBoth(BOTH_SERVICES_RE, text);
}

// Visit cancellation: the client or owner says they can't make it.
const CANCEL_RE = /(?:не\s+можам|неможам|не\s+мозам|не\s+сум|не\s+сум|не\s+сакам|не\s+сакам|не\s+доаѓам|отказувам|откажувам|откажи|откази|цанцел|цанцелед|цанцеллед|само\s+да\s+те\s+извести|само\s+да\s+те\s+извести|бол(?:ен|на|ест)|бол(?:ен|на|ест)|дојде\s+работа|дојде\s+работа|имам\s+проблем|имам\s+проблем|не\s+مى\s+е\s+полесно|жал|жал|поплаќа|поплаки|болест|болест)/iu;
export function detectVisitCancellation(text: string): boolean {
  return matchesBoth(CANCEL_RE, text);
}

export function extractSlots(text: string): DetectedSlots {
  const out: DetectedSlots = {};
  const service = detectService(text);
  if (service) out.service = service;
  if (detectBusiness(text)) out.business = true;
  // house is set ONLY when the message actually names a property type (true =
  // куќа, false = explicit стан). A type-less detail message ("DVE SPALNI…")
  // leaves it undefined so the session's established куќа survives.
  const house = detectHouse(text);
  if (house !== undefined) out.house = house;
  const beds = detectBedrooms(text);
  if (beds) out.bedrooms = beds;
  const sqm = detectSqm(text);
  if (sqm) out.sqm = sqm;
  const budget = detectBudget(text);
  if (budget) out.budget = budget;
  if (detectAnywhere(text)) out.anywhere = true;
  if (detectApartmentNeed(text)) out.need = true;
  if (detectRejection(text)) out.rejected = true;
  return out;
}

// Price reference: "та цена", "та cenа", "таа цена", "та cenа",
// "истата цена", "онaa цена" — client refers to a previously discussed price.
// Used when detectBudget returns undefined but the client clearly references
// a prior price ("DO TA CENA").
const PRICE_REF_RE = /(?:та|таа|таa|таa|истата|онaa|онaa|онaa|истата|таа?)\s+(?:цена|цена|cena|cenа)/iu;
/** True when the client references a previously discussed price ("та цена"). */
export function detectPriceReference(text: string): boolean {
  return matchesBoth(PRICE_REF_RE, text);
}

// =========================================================================
// OWNER CONTACT REFUSAL — the client asks for the owner's phone number
// or direct contact. The agency NEVER shares owner contacts before a
// visit is arranged. This triggers a privacy-refusal + redirect to
// visit scheduling.
// =========================================================================
const OWNER_CONTACT_RE = /(?:контакт|контакт|број|број|телефон|телефон|емаил|емаилл?|линија|линија)\s*(?:од|от|од|на|на|за|за|наш|нас)?\s*(?:сопственик|сопственик|власник|власник)|(?:сопственик|сопственик|власник|власник)(?:от|от)?(?:\s+(?:е|e))?\s*(?:телефон|телефон|број|број|контакт|контакт)|(?:може|мозе)\s+ли\s+(?:контакт|контакт|број|број)\s+(?:од|от|од|на|на)\s*(?:сопственик|сопственик|власник|власник)|(?:дад(?:и|иј|ете|иите)|дади(?:j|те)?)\s+(?:ми|ми)?\s*(?:го|го)?\s*(?:сопственикот|сопственикот|власникот|власникот|бројот|бројот|телефонот|телефонот)|(?:сакам|сакам)\s+(?:да|да)\s+(?:разговарам|разговарам|контактирам|контактирам|звонам|звонам|зборувам|зборувам)\s+(?:со|са|со)\s*(?:сопственик|сопственик|власник|власник)|(?:имам|имам)\s+(?:ли|ли)\s+(?:можност|можност|могућност|могуцност)\s+(?:да|да)\s+(?:звам|звам|контактирам|контактирам)/iu;
/** True when the client asks for the owner's direct contact/phone. */
export function detectOwnerContact(text: string): boolean {
  return matchesBoth(OWNER_CONTACT_RE, text);
}

