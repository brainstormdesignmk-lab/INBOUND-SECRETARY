import { Service, State, Event } from '../fsm/machine';
import { locMatches, normalizeLocation } from '../data/properties';
import { OwnerVerdict } from '../backoffice/ownerAgent';

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
// Word-form bedroom counts, both scripts. "спални" is the most common typing
// ("DVE SPALNI ОБАВЕЗНО А МОЖЕ И ТРИ") — it MUST count, or a куќа funnel stays
// stuck in discovery asking the bedrooms question forever.
const BED_WORDS: Array<[RegExp, number]> = [
  [/(еднособен|еднособна|една соба|една спална|ednosoben|ednosobna|edna soba|edna spalna)/i, 1],
  [/(двособен|двособна|две соби|две спални|dvosoben|dvosobna|dve sobi|dve spalni)/i, 2],
  [/(трисобен|трисобна|три соби|три спални|trisoben|trisobna|tri sobi|tri spalni)/i, 3],
  [/(четирисобен|четирисобна|четири соби|четири спални|cetirisoben|cetirisobna|chetiri sobi|cetiri spalni)/i, 4],
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

/** True when the client references a SPECIFIC property they saw, without a number. */
export function detectSeenProperty(text: string): boolean {
  return SEEN_PROPERTY_RE.test(text);
}

// Mid-discovery the client asks to SEE offers before the criteria are complete:
// "што имате во понуда?", "sto imate?", "помало нешто", "покажи ми". Lina
// must ANSWER with real DB offers (smallest м² first, area-locked) instead of
// repeating the missing question. Latin + Cyrillic. "што имаш во Карпош?" (a
// location search) is NOT this — the text after имаш/имате breaks the anchor.
const SEE_OFFERS_RE =
  /(што\s+(?:имаш|имате|има)\s+(?:во\s+|на\s+)?понуда|што\s+(?:имаш|имате|има)\s+(?:на\s+)?(?:лагер|залиха)|sto\s+(?:imas|imate)\s+(?:vo\s+|na\s+)?ponuda|sto\s+(?:imas|imate)\s+(?:na\s+)?(?:lager|zaliha)|помало\s+нешто|нешто\s+помало|покажи\s+ми|имате\s+ли\s+нешто|имаш\s+ли\s+нешто|pomalo\s+nesto|pokazi\s+mi|imate\s+li\s+nesto|imas\s+li\s+nesto|(?:што|sto)\s+(?:имаш|имате|imas|imate)\s*\??$)/iu;

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
  /(дали[^.!?\n]{0,40}(?:достапен|достапна|достапно|продаден|продадена|издаден|издадена|на продажба|на prodazba|постои|го имате уште|ја имате уште)|достапен\s+ли\s+е|достапна\s+ли\s+е|продаден\s+ли\s+е|издаден\s+ли\s+е|сеуште\s+(?:ли\s+)?(?:е\s+)?(?:достапен|достапна|на продажба)|(?:го|ја)\s+имате\s+(?:ли\s+)?(?:уште|сеуште)|(?:go|ja)\s+imate\s+(?:li\s+)?(?:uste|seuste)|da[il][il][^.!?\n]{0,40}(?:dostapen|dostapna|dostapno|prodaden|prodadena|izdaden|izdadena|na prodazba|postoi|go imate uste|ja imate uste)|dostapen\s+li\s+e|dostapna\s+li\s+e|prodaden\s+li\s+e|izdaden\s+li\s+e|seuste\s+(?:li\s+)?(?:e\s+)?(?:dostapen|dostapna|na prodazba))/iu;

export function detectAvailabilityAsk(text: string): boolean {
  return AVAILABILITY_ASK_RE.test(text);
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
const FEE_FOR_WHAT_RE = /(?:за\s+(?:што|stо|sto|stó)|za\s+sto|za\s+what|for\s+what)/iu;
// "kako 500 den" — client questions a specific fee amount. Any combination
// of како/кoа + number + den/denari/euro/evra is a WHY question.
const FEE_AMOUNT_RE = /(?:како|kako|која|koja)[^.!?\n]{0,30}\d[^.!?\n]{0,20}(?:den|denar|евр|eur|din|dinari|евра|euro)/iu;

export function detectFeeWhy(text: string): boolean {
  // Normalize: join multi-line bursts into one line so cross-line patterns work
  const flat = text.replace(/\n/g, ' ');
  return FEE_WHY_RE.test(flat) || FEE_FOR_WHAT_RE.test(flat) || FEE_AMOUNT_RE.test(flat);
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
const NEED_NEGATION_RE = /(не|ne)\s+(ми\s+треба|треба\s+ми|барам|baram|сакам|sakam|имаш\s+ли|imas\s+li)/i;

export function detectApartmentNeed(text: string): boolean {
  if (NEED_NEGATION_RE.test(text)) return false;
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
const SMALL_STAN_RE = /(мал[оаи]?\s+(стан|станче|стани)|mal[oa]?\s+(stan|stance|stani)|гарсоњера|garsonjera|студио|studio)/i;

export function detectBedrooms(text: string): number | undefined {
  const m = text.match(BED_NUM_RE);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 6) return n;
  }
  for (const [re, n] of BED_WORDS) {
    if (re.test(text)) return n;
  }
  if (SMALL_STAN_RE.test(text)) return 1;
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
const ANYWHERE_RE = /(било\s+каде|било\s+кај|било\s+где|каде\s+било|кај\s+било|где\s+да\s+е|каде\s+да\s+е|секаде|не\s+е\s+битно\s+каде|не\s+е\s+важно\s+каде|није\s+битно\s+где|није\s+важно\s+где|не\s+ми\s+е\s+битно|не\s+ми\s+е\s+важно|не\s+ми\s+е\s+гајле|bilo\s+kade|bilo\s+kaj|bilo\s+gde|kade\s+bilo|kaj\s+bilo|kade\s+da\s+e|gde\s+da\s+e|sekade|ne\s+e\s+bitno\s+kade|ne\s+e\s+vazhno\s+kade|nie\s+je\s+bitno\s+gde|nie\s+je\s+vazhno\s+gde|ne\s+mi\s+e\s+bitno|ne\s+mi\s+e\s+vazhno|ne\s+mi\s+e\s+gajle|anywhere)/iu;

/** True when the client says "anywhere" — no location preference. */
export function detectAnywhere(text: string): boolean {
  return ANYWHERE_RE.test(text);
}

// The client asks for ALTERNATIVE suggestions — "predlozi mi", "drugi
// lokaciii", "pokazi drugi", "други предлози" — typically answering the
// not-found line ("Дали би сакале да Ви предложам слични имоти од други
// локации?") or asking for other options after disliking the current one. In
// property_query this must PIVOT to a real city-wide presentation, never
// repeat the not-found line (the stuck loop: every "predlozi mi" re-rendered
// "не можам да го најдам имотот со Евидентен број 250"). Latin + Cyrillic.
const SUGGEST_ALTERNATIVES_RE =
  /(предложи ми|предложете ми|предложи|предложете|sugeri|сугерирај|сугерирате|sugeriraj|predlozi mi|predlozete mi|predlozi|predlozete|други локации|друга локаци|drugi lokacii|drugi lokaciii|drugi lokacija|druga lokaci|други предлози|drugi predlozi|покажи други|pokazi drugi|покажете други|pokazete drugi|нешто друго|друго нешто|nesto drugo|неколку други|некои други|имаш ли други|имате ли други|imas li drugi|imate li drugi|дали имате други|dali imate drugi)/iu;

/** True when the client asks for alternative suggestions / other options. */
export function detectSuggestAlternatives(text: string): boolean {
  return SUGGEST_ALTERNATIVES_RE.test(text);
}

export function detectRejection(text: string): boolean {
  return REJECT_RE.test(text);
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

const VISIT_NEGATION_RE = /(не\s+(сакам|сакаме|би сакал|би сакала|посакувам|организира)|ne\s+(sakam|sakame|bi sakal|bi sakala|posakuvam|organizira))/i;

export function detectVisitInterest(text: string): boolean {
  if (VISIT_NEGATION_RE.test(text)) return false;
  return VISIT_INTEREST_RE.test(text);
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

/** True when the client expresses interest in a specific property. */
const PROPERTY_NEGATION_RE = /(?:не|ne)\s+(?:ми\s+се|mi\s+se)\s+(?:сви[ѓг]а|свига|допа[ѓг]а|допага|svigj|dopag)|(?:не|ne)\s+(?:го|go)\s+(?:сакам|sakam)|(?:не|ne)\s+(?:сум|sum)\s+(?:заинтересиран|zainteresiran)/i;
export function detectPropertyInterest(text: string): boolean {
  if (VISIT_NEGATION_RE.test(text) || PROPERTY_NEGATION_RE.test(text)) return false;
  return PROPERTY_INTEREST_RE.test(text);
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

// The client can't do the PROPOSED visit time — „не можам во 18:00“, „може
// покасно/подоцна“, „не ми одговара“. In owner_checking this sends the
// negotiation back to collecting a NEW concrete time — Lina must never confirm
// (or keep asking the owner about) a time the client already rejected. The
// "не"-anchored forms keep "MOZAM VO 19:00" (a new proposal) out.
const TIME_REJECT_RE = /(не можам|не може|не можев|не можел|не ми одговара|не ми е згодно|не одговара|не тој термин|не тогаш|подоцна|покасно|друг термин|поинаков|поинаку|ne mozam|ne moze|ne mozev|ne mi odgovara|ne mi e zgodno|ne odgovara|ne toj termin|ne togas|podocna|pokasno|drug termin|poinakov|poinaku|nema da mozam|nema da moze|nema da mozeme|нема да можам|нема да може|нема да можеме)/i;

export function detectTimeRejection(text: string): boolean {
  return TIME_REJECT_RE.test(text);
}

// Commercial-property intent: деловен простор / канцеларија / локал / магацин /
// дуќан / продавница… ("за стан" searches must never ask or match these — and
// vice versa). The vocabulary mirrors Ana's proven COMMERCIAL_TITLE_RE
// (outbound project). STRONG terms (unambiguous property types) match bare;
// WEAK terms (кафе/ресторан/салон/хотел are often LANDMARKS — "сакам стан до
// кафе") require a need/transaction context so a landmark mention never
// flips a residential search into a business one.
const BUSINESS_STRONG_RE = /(деловен|деловни|деловна|деловно|канцелар|локал|магацин|склад|хала|бизнис|офис|дукјан|дукан|дуќан|продавниц|ателје|deloven|delovni|delovna|kancelari|kancelariski|lokal|magacin|sklad|hala|biznis|ofis|dukjan|dukan|prodavnic|atelje|posloven|poslovn|office|business|commercial)/i;
const BUSINESS_WEAK_RE = /(ресторан|кафуле|кафич|кафе|салон|хотел|restoran|kafule|kafic|kafe|salon|hotel)/i;
const BUSINESS_NEED_RE = /(ми треба|барам|сакам|треба|потребен|потребна|need|treba|baram|sakam|за изнајмување|за издавање|под кирија|за изнајмува|za iznajmuvanje|za izdavanje|pod kirija|za iznajmuv|rent|изнајмувам)/i;
// An explicit RESIDENTIAL word (стан/куќа/гаража стамбен) means the weak
// term is a LANDMARK, not the property type: "сакам стан до кафе" is an
// apartment search, "барам локал до кафе" is a business search.
const RESIDENTIAL_WORD_RE = /(стан|стани|станче|куќ|кука|house|stan|stance|apartment|гаража|garaza|стамбен|stamben)/i;

export function detectBusiness(text: string): boolean {
  // An explicit residential word ("стан", "куќа") wins over EVERY business
  // term: "стан до кафе" and "стан со дуќан" are residential searches — the
  // business word is a landmark/feature, not the property type.
  if (RESIDENTIAL_WORD_RE.test(text)) return false;
  if (BUSINESS_STRONG_RE.test(text)) return true;
  if (!BUSINESS_WEAK_RE.test(text)) return false;
  // Weak term (кафе/ресторан/салон) is business only WITH a need context:
  // "барам ресторан под кирија" = business; bare "кафе" = nothing.
  return BUSINESS_NEED_RE.test(text);
}

// House intent: куќа / кука / house / kukja / kuka / вила (both scripts). An
// explicit apartment word (стан/станче/stan/stance) wins — "сакам куќа или
// стан" is ambiguous and stays an apartment request.
const HOUSE_RE = /(куќ|кука|house|kukja|kuka|вила|vila)/i;
const APARTMENT_RE = /(стан|стани|станче|stan|stance|apartment|apartman)/i;

/**
 * House intent: true = куќа, false = explicit стан, UNDEFINED when the message
 * names NO property type at all ("DVE SPALNI…", "ДО 100.000"). The undefined
 * case is critical: a detail message must never clobber an established куќа
 * funnel into a стан search (the old always-false made "DVE SPALNI…" reset a
 * куќа buyer to стан — Lina then presented an apartment).
 */
export function detectHouse(text: string): boolean | undefined {
  const house = HOUSE_RE.test(text);
  const apartment = APARTMENT_RE.test(text);
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
  'ok', 'dobro', 'moze', 'da', 'soglasen', 'soglasna', 'kontaktiraj', 'kontaktirajte', 'registriraj']);

// "moze/може" is ONLY agreement when standalone or followed by "да/da".
// When followed by ANYTHING ELSE it means "can/may" — a criteria modifier
// ("moze i pogolem" = "can be bigger too", "moze 2 spalni" = "can be 2
// bedrooms").  The pattern matches "moze/може" followed by a non-da token.
const MOZE_NOT_AGREEMENT_RE = /(?:може|moze)(?:\s+|[^\p{L}\p{N}])+(?!\s*(?:да|da)\b)/iu;
// ... but we also need to check it's NOT just standalone "moze" with nothing
// after it (or only punctuation).  Simplest: check if there's a real word
// token AFTER "moze" that isn't "да/da".
const MOZE_HAS_NON_DA_AFTER = /(?:може|moze)\s+(?!да\b|da\b)([\p{L}\p{N}]+)/iu;

// "da/да" preceded by a verb/modal is NOT agreement: "mora da imas" (you
// must have), "treba da bidat" (they should be), "sakam da vidam" (I want
// to see).  Only standalone "da" or "da" at the start of the message is
// agreement ("да, согласувам", "да, во ред").
const DA_AFTER_VERB_RE = /(?:\S+\s+)(?:да|da)\s/iu;
// Verb/modal stems that precede "da" to form "must/should/want to" phrases
const DA_NOT_AGREEMENT_RE = /(?:мора|mora|treba|sakam|sakas|sakate|sakame|imas|ima|imate|imame|bides|bide|ќе|ke|bi\s|би\s|can\s|moram|morat|има|имаш|имаме|имате|сакаш|сакаме|сакате|би\b|ќе\b)(?:\s+[^\s]+)?\s+(?:да|da)\b/iu;

export function detectAgreement(text: string): boolean {
  const low = text.toLowerCase();
  if (AGREE_PHRASES.some(p => low.includes(p))) return true;
  const tokens = low.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // "moze i pogolem" / "moze 2 spalni" — "moze" here means "can/may"
  // (criteria modifier), NOT agreement.  Skip the "moze/може" token when
  // it's followed by a non-da word (criteria refinement).
  const mozeIsCriteria = MOZE_HAS_NON_DA_AFTER.test(low);
  // "mora da imas" / "treba da bidat" — "da" here is part of a
  // verb phrase ("must/should have to"), NOT agreement.
  const daIsVerbPhrase = DA_NOT_AGREEMENT_RE.test(low);
  return tokens.some(t => AGREE_WORDS.has(t)
    && !(mozeIsCriteria && (t === 'moze' || t === 'може'))
    && !(daIsVerbPhrase && (t === 'da' || t === 'да')));
}

// A pure "yes, show me more" — agreement WITHOUT an explicit register/contact
// intent ("контактирај ме", "запиши ме" choose the queue, not a wider search).
const WIDEN_EXCLUDE_RE = /(контактирај|контактирајте|запиши|запишете|забележи|регистрирај|prijavi|kontaktiraj|kontaktirajte|registriraj|zapishi|zabelezi)/i;
export function detectWidenIntent(text: string): boolean {
  return detectAgreement(text) && !WIDEN_EXCLUDE_RE.test(text);
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
const OWNER_GONE_RE = /(продаден|продадена|издаден|издадена|под опција|повеќе не е достапен|веќе не е|немам имот|нема повеќе|нема да може|sold|rented|prodaden|prodadena|izdaden|izdadena|prodan|pod opcija)/i;
// Short words (да/ок/ok) need explicit boundaries — "ок" inside "kako" or
// "да" inside "дава" must never count as agreement. Long words match bare.
const OWNER_AGREE_RE =
  /(?:^|[\s,.;:!?])(?:да|da|ок|ok|okay)(?:$|[\s,.;:!?])|(?:може|можам|можеш|во ред|okej|слободен|слободна|слободно|достапен|достапна|достапно|прифаќам|прифатено|прифатен|прифатена|се согласувам|согласен|согласна|зелено|moze|mozam|vo red|sloboden|slobodna|slobodno|dostapen|dostapna|dostapno|prihaka|prihakat|soglasen|soglasna)/i;
const OWNER_DISAGREE_RE = /(не можам|не ми одговара|не ми е згодно|не одговара|не е достапен|не е достапна|нема да можам|не тој термин|не тогаш|не сакам|не ми се допаѓа|ne mozam|ne mi odgovara|ne e dostapen|ne e dostapna|ne toj termin)/i;
// "не можам" must NOT count as agreement via the bare "можам" word. The
// negated "nema da mozam" / "нема да можам" ("won't be able to") is the
// MOST common owner refusal — it contains the bare "mozam" that would
// otherwise match OWNER_AGREE_RE and CLOSE THE DEAL on a refusal.
const OWNER_CANT_RE =
  /(не\s+можам|не\s+може|не\s+можеш|ne\s+mozam|ne\s+moze|не\s+ми\s+одговара|не\s+ми\s+е\s+згодно|не\s+можам\s+да|nema\s+da\s+mozam|nema\s+da\s+moze|nema\s+da\s+mozeme|нема\s+да\s+можам|нема\s+да\s+може|нема\s+да\s+можеме)/i;
const OWNER_DAY_RE = /утре|задутре|денес|денеска|вечерва|попладне|напладне|претпладне|утрово|вечер|викенд|понеделник|вторник|среда|четврток|петок|сабота|недела|utre|zadutre|denes|deneska|vecer|popladne|napladne|utrovo|vikend|ponedelnik|vtornik|sreda|cetvrtok|petok|sabota|nedela/i;
// A clock like "по 18:00" — but NOT when the number is part of a price
// phrase ("по 60 илјади евра", "околу 70 000 евра"): the lookahead rejects
// a match that continues into more digits or a thousands/currency word.
const OWNER_CLOCK_RE = /((?:во|по|после|околу|vo|po|posle|okolu)\s*\d{1,2}(?:[.:]\d{2})?)(?!\s*(?:\d[\d\s.,]*)?\s*(?:илјади|хилјади|iljadi|евра|евро|evra|evro|eur|€))/i;
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
  const day = text.match(OWNER_DAY_RE);
  if (day) {
    const tail = text.slice((day.index ?? 0) + day[0].length);
    const part = tail.match(OWNER_DAY_PART_RE);
    if (part) return `${day[0]} ${part[0]}`.trim();
    return day[0];
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
  if (OWNER_GONE_RE.test(t)) {
    const note = /продад|prodad/.test(t) ? 'продаден' : /издад|izdad/.test(t) ? 'издаден' : undefined;
    return withPrice({ status: 'gone', note });
  }
  const cant = OWNER_CANT_RE.test(t);
  const time = extractOwnerTime(text);
  const hasClock = OWNER_CLOCK_RE.test(text);
  const agree = !cant && OWNER_AGREE_RE.test(t);
  const disagree = cant || OWNER_DISAGREE_RE.test(t);
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
const WHERE_IS_RE = /(?:^|\s)(?:каде|kade|где|gde|where|кај|kaj)\s+(?:да\s+)?(?:(?:се|se)\s+)?(?:наоѓа|naogja|naoga|е|e|се|se|is)(?=\s|[?!.]|$)/iu;
// A bare "каде?" / "kade ?" means "where [is it]?" — the last shown property.
const WHERE_BARE_RE = /^(?:каде|kade|где|gde|кај|kaj|where)\s*\??\s*$/iu;
// "што има во близина?" / "what's nearby?" — NEARBY questions about the last shown property.
// "blizina/близина" MUST be preceded by a preposition (во/в/near) to avoid
// matching "има близина" (there's a closeness) or random mentions.
const NEARBY_RE = /(?:што|shto|shto|what|koj|koe|кој|кое)\s+(?:има|ima|have|imate)\s+(?:во|vo|v|near)\s+(?:близина|blizina|vicinity)|(?:во|vo|v|near)\s+(?:близина|blizina|vicinity)(?:\s*\?|$)|what\s+(?:is\s+)?nearby|co\s+je\s+(?:v\s+)?blizini/iu;
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

const PROPERTY_TYPE_END_RE = /(?:гарсоњер(?:ата|та|а)|garsonjer(?:а|a|ata|та)|стан(?:от)?|stan(?:ot)?|куќ(?:ата|а)|kukj(?:ata|a|e)|дуќ(?:анот?|ан)|dukdjan(?:ot?|а?)|лок(?:алот?|ал)|lokal(?:ot?|а?)|делов(?:ниот|ниот|ен)|deloven(?:\s+prostor)?|објект(?:от)?|objekt(?:ot)?|зград(?:ата|а)|zgrad(?:ata|а?)|имот(?:от)?|imot(?:ot)?|плац(?:от)?|plac(?:ot)?)$/iu;
const WHERE_IS_BLACKLIST_START = /^(?:цената|cenata|cienata|цена|cena|ciena|колк[ао]|kolko|колку|kolku|бројот|brojot|број|broj|шифрата|sifrata|шифра|sifra|достапен|dostapen|достапна|dostapna|сместен|smesten|сместена|smestena)/iu;

export function detectWhereIs(text: string): WhereIsQuestion | undefined {
  if (WHERE_BARE_RE.test(text)) return { place: '', generic: true };
  // "што има во близина?" / "what's nearby?" — treated as "where is it?" for the last shown property.
  if (NEARBY_RE.test(text)) return { place: '', generic: true };
  // "каде точно се наоѓа?" / "where exactly is it?" — a generic where-is
  // that should get a nearby landmark, not the privacy protocol.
  if (isKadeTocno(text)) return { place: '', generic: true };
  const m = text.match(WHERE_IS_RE);
  if (!m) return undefined;
  let rest = text.slice((m.index ?? 0) + m[0].length).trim();
  rest = rest.replace(WHERE_IS_DETERMINER, '').replace(/[?!.]+$/u, '').trim();
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
  /(?:пото?чно|точно|tocno|potocno|pokazete|покажете|која|koja|којашто|koja)\s+(?:е\s+(?:му\s+)?|mu\s+е\s+|му\s+е\s+|да\s+е\s+)?(?:точната|точн|tocnata|tocna)?\s*(?:адреса|adresa|улица|ulica|локацијата|lokacijata|локација|lokacija)|(?:на\s+која|na\s+koja)\s+(?:адреса|adresa|улица|ulica)|(?:адресата|adresata|улицата|ulicata|локацијата|lokacijata)\s+(?:ќе|ke|да)\s+(?:ја\s+)?(?:доби|dobij|знам|znam|кажи|kazi)|кажи\s+(?:ми\s+)?(?:ја\s+)?(?:адресата|adresata|улицата|ulicata|точно|tocno|каде\s+точно)|точно\s+(?:каде|kade)\s+(?:е|e)|каде\s+точно|kade\s+tocno|kade\s+tochno|(?:каде|kade)\s+(?:е\s+|e\s+)?(?:точната|tocnata|точна|tocna|прецизната|preciznata)\s*(?:адреса|adresa|улица|ulica|локација|lokacija)|(?:moram|mora|treba|морам|мора|треба|сакам|sakam)\s+(?:(?:да|da)\s+)?(?:знам|znam)\s+(?:каде|kade)\s+(?:е|e|се\s+нао[гѓ]а|se\s+naogja|се|se)|(?:морам|мора|moram|mora|треба|treba)\s+(?:(?:да|da)\s+)?(?:знам|znam)\s+(?:каде|kade)\s+е|za\s+da\s+se\s+odlu(?:cam|čam)|за\s+да\s+се\s+одлу(?:чам|кам)|(?:која|koja)\s+(?:му\s+|mu\s+)?(?:е|e)\s+(?:точната|точн|tocnata|tocna|прецизната|preciznata)\s*(?:локација|lokacija|адреса|adresa|улица|ulica)|(?:дад(?:и|ете)|dadi(?:te)?)\s+(?:ми\s+)?(?:ја\s+)?(?:адресата|adresata|улицата|ulicata|локацијата|lokacijata)|(?:точната|точна|tocnata|tocna)\s+(?:адреса|adresa|улица|ulica|локација|lokacija)/iu;

/** True when the client asks for the EXACT street/address of a property. */
export function detectExactAddressAsk(text: string): boolean {
  return EXACT_ADDRESS_RE.test(text);
}

// "каде точно" patterns — these are WHERE_IS questions that should get
// a nearby landmark first, NOT the privacy protocol.
const KADE_TOCNO_RE = /(?:каде|kade)\s+(?:точно|tocno|tochno)|(?:точно|tocno|tochno)\s+(?:каде|kade)/iu;
/** True when the text is a "where exactly" question (not an explicit address demand). */
export function isKadeTocno(text: string): boolean {
  return KADE_TOCNO_RE.test(text);
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
  return OFFTOPIC_RE.test(text);
}

// Follow-up defer: the client is not ready to decide.
const DEFER_RE =
  /(?:ќе\s+размислам|ќе\s+размислувам|ќе\s+се\s+јавам|ќе\s+се\s+техам|подоцна\s+ќе|не\s+сега|не\s+сум\s+сигурен|сега\s+не\s+сум|sakam\s+da\s+razmislam|ke\s+se\s+javam|podocna\s+ke|sakam\s+pa\s+razmislam|ke\s+razmislam|podocna\s+ke\s+se|ne\s+sum\s+siguran|ne\s+e\s+segas|sega\s+ne\s+sum|not\s+now|later|maybe\s+later|i.ll\s+(?:think|call|contact)|let\s+me\s+(?:think|check)|give\s+me\s+(?:a\s+)?(?:day|time|sec)|zapisete\s+me|запишете\s+ме|запиши\s+ме|евидентирај\s+ме|регистрирај\s+ме)/iu;

/** True when the client wants to defer the decision. */
export function detectDefer(text: string): boolean {
  return DEFER_RE.test(text);
}

// Price negotiation: the client asks to lower the price or requests a discount.
const NEGOTIATE_RE =
  /(?:може\s+ли\s+(?:помала|пониска|поевтина|поевтин|помал)|помала\s+(?:цена|евра|евро)|пониска\s+(?:цена|евра)|поевтин\s+(?:стан|нешто)|дали\s+(?:има|постои|ќе\s+има)\s+попуст|попуст|намалување|може\s+ли\s+да\s+се\s+договориме\s+за\s+цена|дали\s+е\s+(?:фиксна|финална|конечна)\s+цена|can\s+(?:you|we)\s+(?:lower|reduce|drop|negotiate|cut)\s+(?:the\s+)?(?:price|cost)|discount|cheaper|lower\s+price|price\s+(?:reduction|cut|drop|negotiat)|any\s+(?:wiggle|flexibility|room)\s+(?:on\s+the\s+)?price|is\s+(?:the\s+)?(?:price|cost)\s+(?:fixed|firm|final|negotiable)|negotiate)/iu;

/** True when the client wants to negotiate the price. */
export function detectNegotiate(text: string): boolean {
  return NEGOTIATE_RE.test(text);
}

// Provision / commission ask.
const PROVISION_RE =
  /(?:провизи[јjа]+|provizija|provizion|provizia|commission|агенциск[аои]\s+(?:надомест|цена|трошок|услуга)|колку\s+(?:е|е\s+провизијата|чиња)|(?:дали|dali)\s+(?:има|постои|ќе\s+плаќам)\s+провизиј)/iu;

/** True when the client asks about provision/commission. */
export function detectProvisionAsk(text: string): boolean {
  return PROVISION_RE.test(text);
}

// Scheduling flexibility: the client specifies a preferred day/time window.
const SCHED_FLEX_RE =
  /(?:може\s+ли\s+(?:викенд|сабота|недела|sabota|nedela|weekend|saturday|sunday)|само\s+(?:попладне|утрово|вечер|popladne|napladne|utro|vecher|afternoon|morning|evening)|само\s+претпладне|утро\s+само|afternoon\s+only|morning\s+only|evening\s+only|weekend\s+only)/iu;

/** True when the client specifies a scheduling window. */
export function detectSchedulingFlex(text: string): boolean {
  return SCHED_FLEX_RE.test(text);
}

// Escalation polite: the client asks to speak with a manager.
const ESCALATION_RE =
  /(?:сакам\s+(?:да\s+)?(?:разговарам|зборувам|контактирам|пишувам)\s+(?:со|кај)\s+(?:менаџер|управител|шеф|директор)|sakam\s+(?:manager|менаџер|supervisor|управител)|разговара[јите]?\s+со\s+(?:менаџер|управител|директор|шеф)|talk\s+(?:to|with)\s+(?:a\s+)?(?:manager|supervisor|boss|director|owner)|speak\s+(?:to|with)\s+(?:a\s+)?(?:manager|supervisor|boss)|сакам\s+(?:надзор|одговорни|погоре)|не\s+ми\s+е\s+јасно\s+со\s+(?:вас|ти))/iu;

/** True when the client asks for a manager / escalation. */
export function detectEscalation(text: string): boolean {
  return ESCALATION_RE.test(text);
}

// Documents info: the client asks what documents they need.
const DOCUMENTS_RE =
  /(?:какви\s+документи|кои\s+документи|документи\s+(?:ми\s+требаат|треба\s+да\s+имам|ќе\s+ми\s+требаат)|what\s+(?:doc|paper|form)|need\s+(?:i\s+)?(?:any|some)?\s*(?:doc|paper|form)|што\s+треба\s+за\s+(?:купување|изнајмување)|документација\s+за)/iu;

/** True when the client asks about required documents. */
export function detectDocumentsAsk(text: string): boolean {
  return DOCUMENTS_RE.test(text);
}

// Mortgage / credit info: the client mentions credit/mortgage or asks about financing.
const MORTGAGE_RE =
  /(?:со\s+(?:кредит|банка|loan|mortgage|credit)|купувам\s+со\s+кредит|имам\s+кредит|од\s+банка\s+купувам|банка\s+ми\s+(?:одобри|одобрила|дава)|credit|mortgage|хипотека|hypoteka|купување\s+(?:со|преку)\s+(?:кредит|банка)|can\s+(?:i|we)\s+(?:buy|purchase|finance|get\s+a\s+(?:loan|mortgage|credit)))/iu;

/** True when the client mentions mortgage / credit / bank financing. */
export function detectMortgageAsk(text: string): boolean {
  return MORTGAGE_RE.test(text);
}

// Neighborhood general: the client asks general questions about neighborhoods.
const NEIGHBORHOOD_RE =
  /(?:во\s+(?:која|кој)\s+(?:населба|дел|локаци|део|neighborhood|area|part)\s+(?:е\s+)?(?:најдобро|подобро|популарно|барано|барана|супер|одлично|добро)|(?:како\s+е|што\s+е|какво\s+е|каков\s+е|каква\s+е)\s+во\s+(?:центар|капиштец|карпош|аеродром|кисела\s+вода|влае|ѓорче|маџари|хиподром|ченто|орце|пржино|тафталиџе|кареа)|(?:безбедно|сигурно)\s+(?:ли\s+е|е\s+ли|во)|safe\s+(?:in|area|neighborhood))/iu;

/** True when the client asks a general neighborhood question. */
export function detectNeighborhoodAsk(text: string): boolean {
  return NEIGHBORHOOD_RE.test(text);
}

// Comparison help: the client asks to compare two properties.
const COMPARISON_RE =
  /(?:што\s+е\s+(?:подобро|посигурно|подобра|побргзо|поевтино|поскапо|поголемо|помало)|(?:кој|која|кое)\s+е\s+(?:подобро|посигурно|подобра|побргзо|поевтин|поевтино|поскапо|поголем|поголемо|помал|помало|популарно|барано)|(?:кој|која|кое)\s+(?:ќе\s+ми\s+(?:одговара|биде\s+подобар)|е\s+(?:подобар|добар|погоден))|спореди|сравни|compare|which\s+(?:is\s+)?(?:better|cheaper|bigger|smaller|newer)|whats\s+(?:the\s+)?(?:difference|better|best))/iu;

/** True when the client asks to compare properties. */
export function detectComparison(text: string): boolean {
  return COMPARISON_RE.test(text);
}

// Feature question after a property was shown: the client asks about a feature.
const FEATURE_RE =
  /(?:има\s+ли\s+(?:паркинг|лифт|кујна|тераса|башта|двор|orman|klima|garazha|garage|lift|elevator|kujna|kitchen|terasa|terrace|yard|balkon|orman|ormar|klima|centralno|kamin|solarni|alarm|video|security)|(?:дали|е\s+ли)\s+(?:е\s+)?(?:реновиран|новоградба|стар|нов)|е\s+ли\s+(?:реновиран|новоградба|стар|нов)|newly\s+renovated|renovated|new\s+build|(?:паркинг|лифт|кујна|тераса|двор|balkon|orman|klima|garazha|garage|lift|elevator|kujna|kitchen|terasa|terrace|yard|orman|ormar|klima|centralno|kamin|solarni|alarm|video|security)\s+(?:ли|да|е|има|ќе\s+има|би\s+имало)|energy\s+(?:class|rating|efficien)|енергетска\s+(?:класа|ефикасност|рејтинг))/iu;

/** True when the client asks about a specific property feature. */
export function detectFeatureAsk(text: string): boolean {
  return FEATURE_RE.test(text);
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
const BOTH_SERVICES_RE = /(?:^|\s)(?:i\s+toa\s+i\s+toa|i\s+za\s+dvete|za\s+dvete|и\s+тоа\s+и\s+тоа|и\s+за\s+двете|за\s+двете|i\s+kupam\s+i\s+kirijam|и\s+купам\s+и\s+кирија|kedeto|каде[^т]|ke\s+treba(?:at)?|ќе\s+треба(?:ат)?|sakam\s+(?:i\s+)?(?:kupam|kirijam)|сакам\s+(?:и\s+)?(?:купам|кирија)|dve\s+raboti|две\s+работи|kupuvanje\s+i\s+iznajmuvanje|купување\s+и\s+изнајмување|i\s+kupuvam\s+i\s+iznajmuvam|и\s+купувам\s+и\s+изнајмувам|ke\s+kupam\s+i\s+kirijam|ќе\s+купам\s+и\s+кирија|moz(?:e|am|he|hhe?|zze?)\s+da\s+kup(?:am|uvam).*?moz(?:e|am|he|hhe?|zze?)\s+(?:i\s+)?da\s+izn(?:ajm(?:uvam|am|at)|ajm(?:uvanje))|може\s+да\s+куп(?:ам|увам).*?може\s+(?:и\s+)?да\s+изн(?:ајм(?:увам|ам|ат)|ајмување))/iu;
export function detectBothServices(text: string): boolean {
  return BOTH_SERVICES_RE.test(text);
}

// Visit cancellation: the client or owner says they can't make it.
const CANCEL_RE = /(?:не\s+можам|nemozham|ne\s+mozam|не\s+сум|ne\s+sum|не\s+сакам|ne\s+sakam|не\s+доаѓам|otkazuvam|откажувам|откажи|otkazi|cancel|canceled|cancelled|само\s+да\s+те\s+извести|samo\s+da\s+te\s+izvesti|bol(?:en|na|est)|бол(?:ен|на|ест)|дојде\s+работа|dojde\s+rabota|имам\s+проблем|imam\s+problem|не\s+مى\s+е\s+полесно|zhal|жал|poplakja|поплаки|bolest|болест)/iu;
export function detectVisitCancellation(text: string): boolean {
  return CANCEL_RE.test(text);
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

// =========================================================================
// OWNER CONTACT REFUSAL — the client asks for the owner's phone number
// or direct contact. The agency NEVER shares owner contacts before a
// visit is arranged. This triggers a privacy-refusal + redirect to
// visit scheduling.
// =========================================================================
const OWNER_CONTACT_RE = /(?:контакт|kontakt|број|broj|телефон|telefon|емаил|emaill?|линија|linija)\s*(?:од|от|od|на|na|за|za|наш|nas)?\s*(?:сопственик|sopstvenik|власник|vlasnik)|(?:сопственик|sopstvenik|власник|vlasnik)(?:от|ot)?(?:\s+(?:е|e))?\s*(?:телефон|telefon|број|broj|контакт|kontakt)|(?:може|moze)\s+ли\s+(?:контакт|kontakt|број|broj)\s+(?:од|от|od|на|на)\s*(?:сопственик|sopstvenik|власник|vlasnik)|(?:дад(?:и|иј|ете|иите)|dadi(?:j|te)?)\s+(?:ми|mi)?\s*(?:го|go)?\s*(?:сопственикот|sopstvenikot|власникот|vlasnikot|бројот|brojot|телефонот|telefonot)|(?:сакам|sakam)\s+(?:да|da)\s+(?:разговарам|razgovaram|контактирам|kontaktiram|звонам|zvonam|зборувам|zboruvam)\s+(?:со|sa|so)\s*(?:сопственик|sopstvenik|власник|vlasnik)|(?:имам|imam)\s+(?:ли|li)\s+(?:можност|mozhnost|могућност|mogucnost)\s+(?:да|da)\s+(?:звам|zvam|контактирам|kontaktiram)/iu;
/** True when the client asks for the owner's direct contact/phone. */
export function detectOwnerContact(text: string): boolean {
  return OWNER_CONTACT_RE.test(text);
}

