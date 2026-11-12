import { State, Service } from '../fsm/machine';
import { SlotData, ChatSession } from '../fsm/session';
import { RESPONSE_BANK } from '../data/responses';
import { pickVariant } from '../data/responseBank';
import { Property, locPrep, mkTimePhrase, normalizeTimePhrase, latinToCyrillicDisplay, knownPlaceWordCyrillic, monthlyRent } from '../data/properties';
import { firstLandmarkProblem } from '../geo/landmarks';
import { distM } from '../geo/precision';
import { parseVisitDateTime, formatVisitDate, formatDateOnly, weekdayName, hasClockHint, extractDayWord, namesADay } from '../visits/time';

export const BUY_FEE_MKD = '500 MKD';
export const RENT_FEE_MKD = '300 MKD';

// The question-prefix flourishes are CODE-BUILT at their single natural spot
// each — "once per funnel", the way a person actually speaks. The LLM used to
// repeat them on EVERY question in the collecting phase, which reads robotic.
// FIRST_QUESTIONS_PREFIX opens the first criteria question; the first contact
// ask opens with a plain „Одлично.“ — the old „уште последниве информации и
// завршуваме“ announced an END that was not there (the client still has the
// owner contact + the visit ahead), and the team asked for it gone.
// Retries and all later questions stay plain.
export const FIRST_QUESTIONS_PREFIX = 'Супер. Уште неколку прашања.';
export const LAST_INFO_PREFIX = 'Одлично.';

// --- Visit sub-funnel: exact phrases (code-built, never LLM-invented) --------
export const VISIT_TIME_QUESTION =
  'Кој термин би Ви одговарал за посета? Да се обидам да договорам со сопственикот во тоа време.';

export const OWNER_CHECK_ACK =
  'Во ред, ќе Ве известам штом потврдам.';

export const PATIENCE_LINE =
  'Моментално го контактирам сопственикот за достапноста. Ќе Ве известам веднаш штом добијам одговор.';

// Availability question about a KNOWN property ("дали е сеуште достапен?"):
// the client saw the ad on the website and knows the details — Lina does NOT
// re-describe the property. She answers that it should still be available and
// ASKS if the client wants her to contact the owner. The fee is disclosed ONLY
// after the client confirms they want to proceed. Bank-backed (availability.ack)
// with this exact line as the code-built fallback.
export const AVAILABILITY_ACK =
  'Би требало да е сеуште достапен. Дали сакате да го исконтактирам сопственикот за да ги потврдиме моменталната достапност и цената?';

/** Feminine twin of AVAILABILITY_ACK — куќа/гарсоњера asks agree with
 *  «достапна», the same gender slot ownerPropertyLabels hands the owner ask.
 *  Serves as the code-built fallback beneath the feminine bank pool so a
 *  feminine ask never falls onto the masculine line (and vice versa). */
export const AVAILABILITY_ACK_FEM =
  'Би требало да е сеуште достапна. Дали сакате да го исконтактирам сопственикот за да ги потврдиме моменталната достапност и цената?';

/** The CLAIM half alone, for the check-then-arrange turn (the [07:06]/
 *  [08:55] captures): the client has already said he wants the visit (or ordered
 *  the check), so answering with the ack's own «Дали сакате да го
 *  исконтактирам сопственикот?» asks him to give the same consent twice. The
 *  availability answer still stands — the fee question follows it. */
export const AVAILABILITY_CLAIM =
  'Би требало да е сеуште достапен';
export const AVAILABILITY_CLAIM_FEM =
  'Би требало да е сеуште достапна';

/** The owner dictated a NEW price — relayed to the client (code-built, exact). */
export function buildPriceRelay(eb: number, newPrice: number, oldPrice?: number): string {
  const np = newPrice.toLocaleString('mk-MK');
  const op = oldPrice !== undefined && oldPrice !== newPrice
    ? ` (претходно ${oldPrice.toLocaleString('mk-MK')} евра)`
    : '';
  return `Сопственикот ја потврди достапноста, но цената е променета: ${np} евра${op}.`;
}

// The client denies the current direction ("не барам стан", "нешто друго")
// before any property was shown — Lina pivots: asks what they DO want instead
// of re-asking the same question. Code-built (protocol), like the other pivots.
export const DIRECTION_PIVOT_LINE =
  'Разбирам. Кажете ми што барате — куќа, деловен простор или нешто друго?';

// --- Locate-a-seen-property sub-funnel (property_locate) ---------------------
// The client SAW a specific property (an ad, on the internet) but does NOT
// know its Евидентен број. Code-built (protocol): first the number question
// (known -> the easy property_query lookup), then the details that narrow the
// DB search (населба / цена / квадрати). The CLOSEST matches are presented
// with the same pick-closer, so the client can say "првиот"/"вториот" or the
// number. The presenter is deterministic — the LLM must never invent matches.
export const LOCATE_FIRST_ASK =
  'Дали го знаете Евидентен број на тој стан? Ако да, само кажете ми го — веднаш ќе го проверам. Ако не, кажете ми во која населба е, колку квадрати има и по која цена беше, па јас ќе се обидам да го најдам.';

// The professional close of a recommendation answer (frozen protocol, same
// class as the privacy-protocol lines): every property has its own clientele;
// the client must feel the space in person to decide; offer to arrange a
// visit. Written as an array so pickVariant-style rotation avoids repeats.
export const RECOMMEND_CLOSE_LINES = [
  'Секоја недвижнина има своја клиентела. За да знаете дали е нешто за Вас, треба да го осетите просторот во живо. Дали да се обидам да договорам посета?',
  'Секоја недвижност носи различна вредност за секој клиент. Најдобро е да ги погледнете во живо и сами да процените. Дали да се обидам да договорам посета?',
  'Секоја недвижнина зборува поинаку во живо — треба сами да го осетите просторот за да одлучите. Дали да се обидам да договорам посета?',
  'Фото и опис не се доволни — просторот мора да се почувствува во живо. Дали да договорам посета на недвижноста што Ви се допаѓа повеќе?',
  // The [02:16] capture — the client was stuck between two flats and asked
  // „KOJA OPCIJA BI MI JA PREPORACALE?“ at the closing state. These are the two
  // wordings the owner dictated, used VERBATIM (not paraphrased): they name the
  // choice as the client's, and hand the visit arrangement back to Lina.
  'Секоја недвижнина има своја специфичност. Најдобро е да ги погледнете во живо, и сами да одлучите. Треба само да ми потврдите која од нив би сакале да ја посетите, и јас ќе договорам се.',
  'Убавината е во очите на набљудувачот. Секоја недвижност мора да се види лично за да се осети. Ако сакате да ви договорам посета треба само да ми кажете кој Евидентен број би сакале да го видите и јас ќе се погрижам за се.',
  // Two more in the same register, generated by Gemini against the two approved
  // lines above (tmp/gen-recommend-variants.ts) and reviewed by hand — one
  // generated word („индивидуелен“) was corrected to „индивидуален“.
  'Изборот на совршениот дом е целосно индивидуален за секој клиент. Секоја недвижност има свои предности кои најдобро се доживуваат во живо. Ве молам само кажете ми која недвижност би сакале да ја видите, а јас со задоволство ќе организирам посета за Вас.',
  'Секој купувач има различни приоритети, па затоа проценката е секогаш лична. За да бидете сигурни во одлуката, најважно е просторот да се види лично. Треба само да ми посочите која недвижност ја избирате, а јас веднаш ќе ја договорам Вашата посета.',
];

/** Bank-backed recommendation close (fallback = the code-built line). */
export function buildRecommendClose(recent: string[] = []): string {
  return pickVariant('recommend.close', { recent })
    ?? RECOMMEND_CLOSE_LINES[Math.floor(Math.random() * RECOMMEND_CLOSE_LINES.length)];
}

export const LOCATE_DETAILS_ASK =
  'Во ред, ќе се обидам да го најдам. Кажете ми — во која населба е, колку квадрати има и по која цена беше?';

export const LOCATE_NUMBER_PROMPT =
  'Одлично, кажете ми го Евидентен број — веднаш ќе го проверам.';

export const LOCATE_REFINE_ASK =
  'Не најдов недвижност што одговара точно на тие податоци. Кажете ми уште некој детал — населба, квадратура, цена или нешто друго што го памтите?';

// ── CATEGORY NOUN ─────────────────────────────────────────────────────────
// The locate asks used to say «стан» unconditionally (the [09:38] capture:
// a client describing a HOUSE he saw got "Дали го знаете Евидентен број на
// ТОЈ СТАН?" — the category he named never reached the wording). Once the
// slots hold the described category, the asks follow it: a house client
// hears «таа куќа», a commercial client «тој деловен простор». Slotted,
// grammar-correct per gender (definite forms and clitics included).
export function locateNoun(slots: { house?: boolean; business?: boolean; garsonjera?: boolean; plac?: boolean }): string {
  if (slots.plac === true) return 'плац';
  if (slots.business === true) return 'деловен простор';
  if (slots.house === true) return 'куќа';
  if (slots.garsonjera === true) return 'гарсоњера';
  return 'стан';
}

const LOCATE_NOUN_FORMS: Record<string, { indef: string; def: string; defCap: string; clitic: string }> = {
  'стан': { indef: 'тој стан', def: 'станот', defCap: 'Станот', clitic: 'го' },
  'куќа': { indef: 'таа куќа', def: 'куќата', defCap: 'Куќата', clitic: 'ја' },
  'деловен простор': { indef: 'тој деловен простор', def: 'деловниот простор', defCap: 'Деловниот простор', clitic: 'го' },
  'гарсоњера': { indef: 'таа гарсоњера', def: 'гарсоњерата', defCap: 'Гарсоњерата', clitic: 'ја' },
  'плац': { indef: 'тој плац', def: 'плацот', defCap: 'Плацот', clitic: 'го' },
};

/** The category-noun replacement for the frozen «тој стан» ask, and the
 *  definite form for the «колку квадрати има станот» families. */
function nounForms(slots: Parameters<typeof locateNoun>[0]): {
  indef: string; def: string; defCap: string; clitic: string } {
  return LOCATE_NOUN_FORMS[locateNoun(slots)] ?? LOCATE_NOUN_FORMS['стан'];
}

export function buildLocateFirstAsk(slots: Parameters<typeof locateNoun>[0]): string {
  const f = nounForms(slots);
  return `Дали го знаете Евидентен број на ${f.indef}? Ако да, само кажете ми го — веднаш ќе го проверам. Ако не, кажете ми во која населба е, колку квадрати има и по која цена беше, па јас ќе се обидам да го најдам.`;
}

export function buildLocateServiceAsk(
  slots: Parameters<typeof locateNoun>[0], withNumberInvite = true,
): string {
  const f = nounForms(slots);
  return `${f.defCap} што ${f.clitic} видовте беше за продажба или за изнајмување?${withNumberInvite ? ' Ако го знаете Евидентен број на недвижноста, само кажете ми го — веднаш ќе го проверам.' : ''}`;
}

export function buildLocateMoreSpecsAsk(
  location: string,
  slots: Parameters<typeof locateNoun>[0],
  withNumberInvite = true,
): string {
  const f = nounForms(slots);
  return `Разбрав — ${location}. За да го стесниме изборот, кажете ми — колку квадрати има ${f.def} и по која цена беше?${withNumberInvite ? ' А ако го знаете Евидентен број на недвижноста, само кажете ми го — веднаш ќе го проверам.' : ''}`;
}

// Location is known but m² / price / bedrooms are missing — ask for the
// remaining specs before showing matches.  Keeps the collect-first rhythm
// so the bot doesn't dump all Водно properties when the client only said
// "stan na Vodno".
// The area-aware variant of the first ask. The Евидентен број invitation is
// kept INSIDE it (the operator's rule: the client who saw a property is asked
// about the number FIRST, whatever else he already told us) — the known area
// only replaces the "во која населба" question, it never drops the number.
export const LOCATE_MORE_SPECS_ASK =
  'Разбрав — {location}. За да го стесниме изборот, кажете ми — колку квадрати има станот и по која цена беше? А ако го знаете Евидентен број на недвижноста, само кажете ми го — веднаш ќе го проверам.';

// The [20:15] rule, executed: he gave the details (населба + спални) but
// the PRICE is unwritten and the INTENT (купување/изнајмување) untold — the
// ONE question she may ask is the sale-or-rent of THE property he saw, never
// a re-ask of what he already said.
export const LOCATE_SERVICE_ASK =
  'Станот што го видовте беше за продажба или за изнајмување? Ако го знаете Евидентен број на недвижноста, само кажете ми го — веднаш ќе го проверам.';

/** The area label as the client hears it. The feed disambiguates settlement
 *  rows with a parenthetical type ("Центар (населба)", "Аеродром (општина)") —
 *  an internal marker the phone never says. It was printed verbatim in the
 *  locate asks ("Разбрав — Центар (населба)…", the [11:29] capture) and, inside
 *  the landmark sentence's own parentheses, read as a stutter:
 *  "во близина на Црногорска Амбасада (Центар (населба))". Same strip as the
 *  property card below; the SLOTS keep the feed's exact spelling, this is a
 *  rendering decision only. */
export function displayAreaName(area: string): string {
  return area.replace(/\s*\([^)]*\)\s*$/u, '').trim();
}

export const LOCATE_PICK_CLOSER =
  'Дали некој од овие е тој што го видовте? Ако е, кажете ми „првиот“ или „вториот“, или Евидентен број на недвижноста.';

/** The pick-closer with the number invitation DROPPED — the client just said
 *  he does not have the Евидентен број ("АМА БРОЈОТ НЕ ГО ЗАПИШАВ", the [11:08]
 *  capture): the sentence may offer the positions only. Inviting the number he
 *  has already disclaimed is the dead loop the operator kept flagging. */
export const LOCATE_PICK_CLOSER_NO_NUMBER =
  'Дали некој од овие е тој што го видовте? Ако е, кажете ми „првиот“ или „вториот“.';

// --- Landmark-anchored locate (the [13:28] capture) ---------------------------
// The client anchors the property he saw to a MAP PLACE instead of a
// neighborhood: "SAKAM DA KUPAM STAN TROSOBEN" … "GLEDAV EDEN STAN KAJ VAS" …
// "PISUVASE DO BROZ KAFE". A human agent reads that landmark off the map and
// answers with the listings closest to it — Broz Cafe is in Центар, so the
// 3-room flats around it are the ones he means. Code-built (protocol): the
// LLM must never invent which listings sit near a place, and the {place} is
// the MAP's own name for it, never a client echo.
// ── CLIENT-FACING PLACE NAMES (the [10:29] capture) ─────────────────────────
// The map holds what OSM and Google hold: ~38% of its POIs carry a Latin-only
// name ("ELS Novo Lisice", "Broz Cafe", "Kipper Market"), and the copy below
// printed it VERBATIM — a Macedonian client read "баравте стан во близина на
// ELS Novo Lisice". Names that already carry Cyrillic are shown exactly as the
// map holds them; a Latin-only name is rendered in Cyrillic for DISPLAY.
// Slots, matching and the map itself keep the original spelling — this is a
// rendering decision, never a data change.
//
// The word list is bounded on purpose (the map's own most frequent Latin words
// — school/market/atm/hotel/bank/…): the letter fold alone mangles English
// names ("School" → "Сцхоол"), and an open translator is not something this
// bot may run.
const PLACE_WORDS: Record<string, string> = {
  // places of education
  school: 'училиште', elementary: 'основно', kindergarten: 'градинка',
  university: 'универзитет', faculty: 'факултет', gymnasium: 'гимназија',
  // commerce
  market: 'маркет', supermarket: 'супермаркет', mall: 'мол', shop: 'продавница',
  store: 'продавница', pharmacy: 'аптека', apteka: 'аптека',
  // lodging / housing
  hotel: 'хотел', motel: 'мотел', hostel: 'хостел', apartments: 'станови',
  apartment: 'стан', rooms: 'соби', house: 'куќа', office: 'канцеларија',
  // money / services
  atm: 'банкомат', bank: 'банка', banka: 'банка', post: 'пошта',
  station: 'станица', parking: 'паркинг', garage: 'гаража',
  // food
  cafe: 'кафе', coffee: 'кафе', bar: 'бар', restaurant: 'ресторан',
  pub: 'паб', pizzeria: 'пицерија',
  // health / civic
  hospital: 'болница', clinic: 'клиника', ambulance: 'амбуланта',
  church: 'црква', 'mosque': 'џамија', monastery: 'манастир',
  museum: 'музеј', theatre: 'театар', theater: 'театар', cinema: 'кино',
  stadium: 'стадион', park: 'парк', embassy: 'амбасада', police: 'полиција',
  municipality: 'општина', court: 'суд', library: 'библиотека',
  gallery: 'галерија',
  // geography / grammar
  skopje: 'скопје', macedonia: 'македонија', center: 'центар', centre: 'центар',
  city: 'сити', north: 'север', south: 'југ', east: 'исток', west: 'запад',
  old: 'стар', new: 'нов', and: 'и', at: 'кај',
  the: '', of: '', // articles/copulas — dropped, never spoken
};

/** Multi-word Latin names the word list cannot compose ("High school" would
 *  read "High училиште"). Applied before the word pass. */
const PLACE_PHRASES: Array<[RegExp, string]> = [
  [/\bhigh\s+school\b/giu, 'средно училиште'],
  [/\b(?:elementary|primary)\s+school\b/giu, 'основно училиште'],
  [/\bold\s+town\b/giu, 'стар град'],
];

// HOW MANY words may be transliterated blind before the name is left alone.
// English PROSE in the map ("Boris Sarafov Palace - Ministry of Foreign Affairs
// of the Republic of North Macedonia") folded letter-by-letter becomes
// pseudo-Cyrillic gibberish — worse than the Latin the map holds. Up to two
// unknown words are ordinary names (Kipper Market, ELS Novo Lisice, Embassy of
// Montenegro); three or more mean English vocabulary, and the map's own
// spelling stands. The bot never invents a translation it cannot stand behind.
const PLACE_RENDER_MAX_UNKNOWN = 2;

/** The client-facing form of a map/feed place name: Cyrillic when the map holds
 *  a Latin-only name we can render faithfully, unchanged otherwise. */
export function displayPlaceName(name: string): string {
  const src = (name ?? '').trim();
  if (!src || /[\u0400-\u04FF]/u.test(src)) return src;
  // A word counts as KNOWN when the list maps it (even to nothing — "of",
  // "the") or when the place tables know how it is spelled.
  const renderable = (tok: string): boolean => {
    const bare = tok.toLowerCase().replace(/[^\p{L}]/gu, '');
    return Object.prototype.hasOwnProperty.call(PLACE_WORDS, bare)
      || knownPlaceWordCyrillic(bare) !== undefined;
  };
  const unknown = src.split(/\s+/).filter(t => /\p{L}/u.test(t) && !renderable(t));
  if (unknown.length > PLACE_RENDER_MAX_UNKNOWN) return src;
  let out = src;
  for (const [re, mk] of PLACE_PHRASES) out = out.replace(re, mk);
  const words = out
    .split(/(\s+)/)
    .map((tok) => {
      if (!/\p{L}/u.test(tok)) return tok;
      const bare = tok.toLowerCase().replace(/[^\p{L}]/gu, '');
      const hit = PLACE_WORDS[bare];
      if (hit === undefined) {
        // A neighborhood name inside a business name must keep the spelling the
        // map uses for it ("Novo Lisice" → "Ново Лисиче", never "Лисице" — the
        // letter fold cannot tell ц from ч).
        return knownPlaceWordCyrillic(bare) ?? latinToCyrillicDisplay(tok);
      }
      if (hit === '') return '';
      // A known word is a DESCRIPTION, not a brand: one capital, never shouty
      // ("ATM" the label reads "Банкомат", not "БАНКОМАТ").
      return hit.charAt(0).toUpperCase() + hit.slice(1);
    })
    .join('');
  return words.replace(/\s{2,}/g, ' ').trim();
}

/** The map place plus its area, without repeating one in the other (the map
 *  holds places NAMED after their neighborhood — "Автокоманда"). */
function placeWithArea(place: string, area?: string): string {
  const shown = displayPlaceName(place);
  // The feed disambiguates settlement rows with a parenthetical type
  // ("Центар (населба)", "Аеродром (општина)") — an internal marker, never
  // spoken language. Inside this sentence's own parentheses it read as a
  // stutter: "во близина на Црногорска Амбасада (Центар (населба))" (the
  // [11:29] capture). Same strip as buildPropertyCard below.
  const bare = area ? displayAreaName(area) : undefined;
  const norm = (s: string) => s.trim().toLowerCase();
  const same = !!bare && (norm(bare) === norm(place) || norm(bare) === norm(shown));
  return `${shown}${bare && !same ? ` (${bare})` : ''}`;
}

export function buildLocateLandmarkIntro(
  place: string, area?: string, slots?: Parameters<typeof locateNoun>[0], count = 2): string {
  // Category noun (the [09:38] rule): a house client hears «баравте куќа…»,
  // a commercial client «деловен простор…» — never a forced «стан». Calls
  // without slots keep the original «стан» wording (the [13:28] pins).
  // NUMBER AGREEMENT (the [11:07] replay): one match is «најблиската
  // недвижност што одговара», not the plural opener over a single card.
  const lead = count === 1
    ? 'Еве ја најблиската недвижност што одговара на она што го опишавте:'
    : 'Еве ги најблиските недвижности што одговараат на она што го опишавте:';
  return `Разбрав — значи баравте ${locateNoun(slots ?? {})} во близина на ${placeWithArea(place, area)}. ${lead}`;
}

/** The ENTRY half of the landmark serve (the [11:07] capture): the client
 *  OPENED with a category + a service + a place ("имате објавено една куќа за
 *  издавање кај Олимпико") — he is asking whether we hold that listing, not
 *  describing one he half-remembers, so the intro CONFIRMS rather than echoes
 *  ("Разбрав — значи баравте…" told him what he had just said, and the «значи»
 *  read as an inference about him). The place keeps the area the bank's own
 *  rows put it in, and the category noun matches his words. */
export function buildLocateLandmarkEntry(
  place: string,
  area: string | undefined,
  slots: Parameters<typeof locateNoun>[0] & { service?: 'buy' | 'rent' },
  count = 1,
): string {
  const noun = locateNoun(slots);
  const purpose = slots.service === 'rent' ? ' за издавање' : slots.service === 'buy' ? ' за продажба' : '';
  return `Да, имаме ${noun}${purpose} кај ${placeWithArea(place, area)}. Еве ${count > 1 ? 'ги' : nounForms(slots).clitic}:`;
}

// Nothing in the bank matched the criteria AT that landmark — the honest human
// answer is the closest alternatives with the criteria the client himself
// described (the operator's rule: "if she does not find the apartment wanted
// she must offer him different ones with the characteristics discussed").
export function buildLocateLandmarkFallback(place: string, area?: string): string {
  return `Токму во близина на ${placeWithArea(place, area)} моментално немам недвижност што одговара точно на тие податоци. Еве ги најблиските алтернативи со истите карактеристики:`;
}

// The client remembers WHERE the property was, not how much it cost — the
// landmark arm shows the matches and keeps the price as the missing piece.
export const LOCATE_LANDMARK_PRICE_PROBE =
  'Ако се сеќавате и по која цена беше станот, кажете ми — веднаш ќе го најдеме.';

/** Category-noun twin of the price probe — a house client hears «куќата»,
 *  a commercial client «просторот», never a forced «стан» ([09:38]). */
export function buildLocateLandmarkPriceProbe(slots: Parameters<typeof locateNoun>[0]): string {
  return `Ако се сеќавате и по која цена беше ${nounForms(slots).def}, кажете ми — веднаш ќе го најдеме.`;
}

/** THE BUSINESS PROTOCOL CARD (the [20:59]/[21:05] captures): a business space
 *  is sold on its MONEY PER SQUARE METRE, so the offer line carries it — the
 *  client comparing two деловни простори must not have to do the division
 *  himself. A row whose feed has no surface cannot quote a rate; the line says
 *  the price and leaves the rate out instead of inventing one. */
export function buildBusinessOfferLine(p: Property): string {
  const where = p.location ? `, во ${displayAreaName(p.location)}` : '';
  const size = p.size ? `, ${p.size}` : '';
  const price = p.price !== undefined ? `, ${p.price.toLocaleString('mk-MK')} евра` : '';
  const rate = p.price !== undefined && p.sqm && p.sqm > 0
    ? ` (${Math.round(p.price / p.sqm).toLocaleString('mk-MK')} €/м²)` : '';
  return `Евидентен број ${p.eb} — деловен простор${where}${size}${price}${rate}.`;
}

/** The PAIR intro for business spaces standing at the places the client named.
 *  A GENERAL business ask is an offer of options — never the seen-property
 *  «дали ова е … што го видовте?», which presumes he already picked a unit. */
export function buildBusinessNearIntro(places: string[], count: number): string {
  const where = places.length === 1
    ? `во близина на ${places[0]}`
    : `во близина на ${places.slice(0, 2).join(' и на ')}`;
  return count > 1
    ? `Да, имаме деловни простори ${where}. Еве ги двата најблиску:`
    : `Да, имаме деловен простор ${where}:`;
}

/** NOTHING of the category stands at the places he named: say it plainly and
 *  hand him alternatives, so the turn still moves the search (the operator's
 *  rule for an empty landmark serve). */
export function buildBusinessNoneNear(places: string[], rows: Property[]): string {
  const where = places.length === 1
    ? places[0]
    : places.slice(0, 2).join(' и на ');
  const head = `Во близина на ${where} моментално немам деловен простор за издавање.`;
  if (rows.length === 0) return `${head} Сакате ли да ги забележам Вашите критериуми и да Ве известам штом излезе нешто соодветно?`;
  return `${head} Еве што имаме во друга населба — со цена по квадрат, за да споредите:`;
}

/** The client asked to DESCRIBE the flat(s) she just offered («опиши ми ги?»,
 *  the [10:00] capture). The records she reads from ARE the bank's own rows, so
 *  «деталите не ги имам во записите» is never a true answer — this intro leads
 *  straight into the cards. Gendered by the category on the table (неа/него). */
export function buildDescribeIntro(count: number, slots: Parameters<typeof locateNoun>[0]): string {
  const f = nounForms(slots);
  return count === 1
    ? `Се разбира. Еве ги деталите што ги имам за ${f.clitic === 'ја' ? 'неа' : 'него'}:`
    : 'Се разбира. Еве ги деталите што ги имам за нив:';
}

/** A compact "is this the one you saw?" line — EB, type, area, size, price. */
export function buildLocateMatchLine(p: Property): string {
  const what = p.plac ? 'плац' : p.house ? 'куќа' : p.business ? 'деловен простор' : propertyType(p);
  const bits = [
    // The area the way a human says it — "во Центар", never the feed's own
    // "во Центар (населба)" tag (see displayAreaName).
    p.location ? `во ${displayAreaName(p.location)}` : '',
    p.size ? p.size : '',
    p.price !== undefined ? `${p.price.toLocaleString('mk-MK')} евра` : '',
  ].filter(Boolean);
  return `Евидентен број ${p.eb} — ${what}${bits.length ? `, ${bits.join(', ')}` : ''}.`;
}

/** THE CONFIRMATION OF A SEEN-PROPERTY PICK BY ONE OF ITS FACTS — «мислам
 *  дека беше тој од 71 квадрат» (the 02:19 Водно capture). He did not read an
 *  Евидентен број back, so the reply has to say WHICH flat he just pointed at:
 *  the card's own identity line, then the question that moves the hunt on. A
 *  bare availability ack here read as not listening, and re-serving the pair
 *  read as a machine — he had already answered the question.
 *  Gender-neutral on purpose: the row may be стан/куќа/гарсоњера/плац. */
export function buildLocateSeenConfirm(p: Property): string {
  return `Да, точно. ${buildLocateMatchLine(p)}\n\nДали сакате да Ви закажам посета?`;
}

/** THE RECALLED FLATS COST MORE THAN THE SEARCH CAP (the [09:07] capture):
 *  «IMAVTE EDEN STAN KAJ SJO SO DVE SPALNI?» recalls a LISTING by place + size,
 *  and the flats that answer it stand above the budget he set for his SEARCH.
 *  The budget was a cap for a different question, so hiding these rows told him
 *  the agency does not have the flat he saw, and serving them without a word
 *  claimed they fit. One sentence states the fact and leaves the decision with
 *  him; `undefined` when nothing is over the cap. */
export function buildAboveBudgetNote(rows: Property[], cap: string | undefined): string | undefined {
  const max = cap ? Number(cap.replace(/[^\d]/g, '')) : NaN;
  if (!Number.isFinite(max) || max <= 0) return undefined;
  const over = rows.filter(p => p.price !== undefined && p.price > max);
  if (over.length === 0) return undefined;
  const capLabel = max.toLocaleString('mk-MK');
  return over.length === rows.length
    ? `Ги покажувам иако се над буџетот од ${capLabel} евра, затоа што одговараат на она што го опишавте.`
    : `Дел од нив се над буџетот од ${capLabel} евра — ги покажувам затоа што одговараат на она што го опишавте.`;
}

export function buildLocateMatches(properties: Property[], closerIndex = 0, withNumberInvite = true): string {
  const lines = properties.slice(0, 2).map(p => buildLocateMatchLine(p)).join('\n');
  // ONE CARD, ONE QUESTION (the [11:07] replay): the plural closer asked him to
  // choose «првиот» or «вториот» when a single property was on screen — a
  // question with no second answer. A lone match gets the singular form, its
  // noun and clitic following the card (куќата … ја видовте, станот … го).
  const only = properties.length === 1 ? properties[0] : undefined;
  const closerSingular = only
    ? (() => {
        // The category the ROW itself carries (a гapсоњера is not «станот»:
        // the [09:59] capture closed a гарсоњера offer with «Дали ова е
        // станот што го видовте?»).
        const f = nounForms({ house: only.house, business: only.business, plac: only.plac, garsonjera: only.studio === true });
        return `Дали ова е ${f.def} што ${f.clitic} видовте?`
          + (withNumberInvite ? ' Ако го знаете Евидентен број на недвижноста, кажете ми го.' : '');
      })()
    : undefined;
  const closer = closerSingular
    ?? pickCloser([withNumberInvite ? LOCATE_PICK_CLOSER : LOCATE_PICK_CLOSER_NO_NUMBER], closerIndex);
  return `${lines}\n\n${closer}`;
}

// --- Owner ping-pong: the question Lina asks the OWNER (not the client) -----
// When the client proposes a visit time, Lina proactively asks the owner if the
// property is still available AND whether he accepts the proposed time. The
// owner's plain-text answer is parsed deterministically (detectOwnerVerdict)
// and relayed back to the client — loop until the visit is arranged.
export interface OwnerAskProps {
  eb: number;
  proposedTime: string;
  /** Property type label (e.g. 'стан', 'куќа', 'деловен простор', 'плац'). */
  propertyType?: string;
  /** Definite article form (e.g. 'станот', 'куќата', 'деловниот простор', 'плацот'). */
  propertyTypeDef?: string;
  /** Possessive pronoun matching gender: 'Вашиот' (masc), 'Вашата' (fem), 'Вашето' (neut). */
  possessive?: string;
  /** Adjective form for 'достапен': 'достапен' (masc), 'достапна' (fem), 'достапно' (neut). */
  dostapen?: string;
  /** Relative pronoun matching gender: 'кој' (masc), 'која' (fem), 'кое' (neut). */
  relative?: string;
  /** Participle for 'внесен во системот': 'внесен' (masc), 'внесена' (fem). */
  entered?: string;
}

/**
 * OWNER-ASK TIME NORMALIZER (the [14:22] transcript): the client's raw term
 * ("VO PONEDELNIK MOZAM 6 SAAT") reached the owner VERBATIM — the owner read
 * client shorthand. Lina translates like a human agent: the raw phrase is
 * resolved to a CONCRETE date and rewritten in the canonical display form
 * ("Понеделник, 28.09.2026 во 18:00"). Unresolvable phrases keep mkTimePhrase
 * (day-fix + display-caps only).
 */
export function normalizeOwnerTime(raw: string, now: Date = new Date()): string {
  const phrase = (raw ?? '').trim();
  if (!phrase) return phrase;
  const resolved = parseVisitDateTime(phrase, now);
  if (!resolved) return mkTimePhrase(phrase);
  // NEVER DATE AN UNDATED TERM TO TODAY (the [10:24] capture): the owner's
  // clock arrived without a day («околу 5»), parseVisitDateTime anchored it to
  // NOW, and the client was told «Сопственикот … Има друг предлог: Вторник,
  // 03.11.2026 во 17:00» — today's weekday and today's date, for a term the
  // man never named. A day belongs to the CALLER (the day the owner named, or
  // the day he is answering — mergeOwnerTerm), so a phrase with no day keeps
  // its own display form and the seam refuses to relay it as a fixed term.
  if (!namesADay(phrase)) return mkTimePhrase(phrase);
  const clocked = hasClockHint(phrase);
  return clocked ? formatVisitDate(resolved) : `${weekdayName(resolved)}, ${formatDateOnly(resolved)}`;
}

/** THE ONE RENDERER FOR A TERM SHOWN TO A PERSON (the [18:52] capture): the
 *  owner's counter reached the owner panel as «Среда во 6» — the client's raw
 *  shorthand, with a naked 6 where 18:00 belongs. Every relay (owner panel,
 *  client panel) reads a term through THIS function, so a stored phrase is
 *  always rendered in the canonical form («Среда, 11.11.2026 во 18:00») and
 *  the two panels can never disagree about what was proposed. Translit first
 *  (a Latin client phrase becomes Macedonian), then the day+clock resolution;
 *  a day-less or unresolvable phrase keeps its own display form — that rule
 *  belongs to normalizeOwnerTime and is NOT re-implemented here. */
export function renderVisitTerm(raw: string, now: Date = new Date()): string {
  const phrase = (raw ?? '').trim();
  if (!phrase) return phrase;
  return normalizeOwnerTime(normalizeTimePhrase(phrase), now);
}

/** THE OWNER'S DAY SURVIVES HIS NEXT SENTENCE (the [10:24] capture). The owner
 *  answers a day-only counter with his exact hour in a SEPARATE message
 *  («PETOK» → «OKOLU 5 MOZAM»), so the second verdict is a day-less clock.
 *  `anchors` are the days on the table, most specific first: the day the owner
 *  himself just named, then the day of the term he is answering. The first
 *  anchor that carries a weekday donates it, in ONE place for every reader
 *  (relay, stored term, next owner ping). A phrase that already names a day is
 *  returned untouched, and a phrase with no day AND no anchor stays as it is —
 *  the caller must ask the owner rather than invent one. */
export function mergeOwnerTerm(term: string, anchors: Array<string | undefined>): string {
  const phrase = (term ?? '').trim();
  if (!phrase) return phrase;
  if (namesADay(phrase)) return phrase;
  for (const a of anchors) {
    const src = (a ?? '').trim();
    if (!src || !namesADay(src)) continue;
    const day = extractDayWord(src);
    // Capitalised like every other display form (extractDayWord answers the
    // canonical LOWERCASE weekday; mkTimePhrase/normalizeOwnerTime capitalise).
    if (day) return `${day.charAt(0).toUpperCase()}${day.slice(1)} ${phrase}`;
  }
  return phrase;
}

export function buildOwnerAsk(eb: number, proposedTime: string, opts?: OwnerAskProps): string {
  const pt = opts?.propertyType;
  const ptd = opts?.propertyTypeDef;
  const pos = opts?.possessive ?? 'Вашиот';
  const dost = opts?.dostapen ?? 'достапен';
  const rel = opts?.relative ?? 'кој';
  const entered = opts?.entered ?? 'внесен';
  if (pt && ptd) {
    return `Здраво. Ве контактирам во врска со пројавен интерес од сериозен клиент за ${pos} ${pt} ${rel} во нашиот систем е ${entered} со број ${eb}. Дали ${ptd} е сè уште ${dost} во моментов? Клиентот сака посета: ${proposedTime}. Дали се согласувате на овој термин, или имате друг предлог?`;
  }
  return `Здраво. Ве контактирам во врска со пројавен интерес од сериозен клиент за недвижност која во нашиот систем е внесена со број ${eb}. Дали е сè уште достапна во моментов? Клиентот сака посета: ${proposedTime}. Дали се согласувате на овој термин, или имате друг предлог?`;
}

/**
 * SECOND/THIRD owner turn (the [00:23] capture). Once the owner has already
 * been asked about this visit, a new client proposal must NOT repeat the full
 * first-time intro ("Здраво. Ве контактирам во врска со пројавен интерес…
 * Дали е сè уште достапна?"). It is one fact and one question: which term the
 * client cannot do, and the term the client now proposes.
 */
export function buildOwnerFollowupAsk(refusedTime: string, newTime: string): string {
  return `Клиентот не е во можност за посета во ${refusedTime}. Има друг предлог: ${newTime}. Дали би Ви одговарал тој термин?`;
}

/**
 * ACCEPTANCE follow-up (the [01:07] capture). When the owner countered with a
 * WHOLE DAY ("ke mora vo ponedelnik, bilo koe vreme") and the client completed
 * it with an exact clock, the owner must be asked to CONFIRM the completed term
 * — the client accepted the owner's own proposal, so the refusal-shaped
 * "Клиентот не е во можност за посета во …" is a fabricated fact: the client
 * never refused anything the owner didn't propose first. Same one-fact-one-
 * question shape as buildOwnerFollowupAsk, acceptance semantics.
 */
export function buildOwnerAcceptFollowupAsk(counterDay: string, exactTerm: string): string {
  return `Клиентот го прифати Вашиот предлог: ${counterDay} — било кое време. Предлог за посета: ${exactTerm}. Дали го потврдувате тој термин?`;
}

/**
 * CLIENT-facing counter relay — the mirror of buildOwnerFollowupAsk. When the
 * owner cannot do the client's term but proposes another, the relay names the
 * refused term and the owner's proposal in one sentence and asks whether it
 * suits the client.
 */
export function buildOwnerCounterRelay(refusedTime: string, newTime: string): string {
  return `Сопственикот не е во можност за посета во ${refusedTime}. Има друг предлог: ${newTime}. Дали би Ви одговарал тој термин?`;
}

/** Whole-day counter relay: the owner offered a DAY with open hours — the
 *  client still has to pick the clock, so the close asks for it. */
export function buildOwnerWholeDayRelay(refusedTime: string, day: string): string {
  return `Сопственикот не е во можност за посета во ${refusedTime}. Има друг предлог: ${day} — било кое време му одговара. Во колку часот би сакале да дојдете?`;
}

/**
 * THE OWNER CAN'T DO THE CLIENT'S TERM AND NAMED NO ALTERNATIVE (the [00:11]
 * field rule). The owner holds the calendar, so the term is HIS to name: Lina
 * asks HIM for the day and hour that suit him and transports that term to the
 * client. Asking the client for "another time" instead (the old relay) made
 * both sides propose blind — the client re-guessed while the one person who
 * knows when the flat can be shown was never asked.
 */
export function buildOwnerAlternativeTimeAsk(refusedTime: string): string {
  return `Клиентот предложи посета во ${refusedTime}, но тој термин не Ви одговара. Кој ден и час Ви одговараат Вам? Ќе му го пренесам Вашиот предлог.`;
}

/** The CLIENT-facing half of the same exchange: the honest holding line while
 *  the owner is being asked for HIS term. It states whose schedule the term
 *  belongs to and promises the owner's proposal — it never asks the client to
 *  produce another time (see buildOwnerAlternativeTimeAsk). */
export function buildOwnerAlternativeTimeHold(refusedTime: string): string {
  return `Сопственикот не е слободен во ${refusedTime}. Ќе го прашам кој ден и час му одговараат и веднаш ќе Ви го пренесам неговиот предлог.`;
}

export function buildOwnerAskAgain(eb: number, opts?: OwnerAskProps): string {
  const ptd = opts?.propertyTypeDef;
  // THE SUBJECT DECIDES THE AGREEMENT (the [23:40] capture): with no
  // propertyTypeDef the sentence names «недвижноста» — feminine — so the old
  // masculine default produced «дали недвижноста е достапен». The TUI's re-ask
  // passes no props at all, so this branch was wrong on EVERY owner re-ask.
  // A caller that brings a definite noun still owns its own adjective.
  const dost = ptd ? (opts?.dostapen ?? 'достапен') : 'достапна';
  return `Не разбрав. ${ptd ? `Дали ${ptd}` : `Евидентен број ${eb} — дали недвижноста`} е ${dost} и дали го прифаќате предложениот термин за посета?`;
}

/**
 * THE AVAILABILITY ACK (the [23:41] capture): the owner answered the FIRST
 * half of the compound ask («DOSTAPNA E DA») — the flat is available, the
 * term is not answered yet. Lina confirms what he said and asks ONLY the term
 * question; the client hears nothing and no visit is booked until the term is
 * defined. The subject is «недвижноста» (feminine) for every property type —
 * the generic noun keeps the agreement right for стан, куќа and плац alike.
 *
 * BANK-SERVED, two keys: `owner.availability.ack.term` when a term is on the
 * table, `owner.availability.ack.noterm` when nobody named one. Both carry a
 * POOL CONTRACT (confirms availability + ends on the term question), so a
 * learned or reworded variant cannot drop the question and re-open this bug.
 * `recent` is the OWNER pane's previous lines — never the client's history
 * (see InboundHandler.ownerRecent). The code-built sentence is the fallback
 * for a bank that has not loaded yet, never the primary.
 */
export function buildOwnerAvailabilityAck(eb?: number, term?: string, recent: string[] = []): string {
  const prop = eb !== undefined ? ` (Евидентен број ${eb})` : '';
  const shown = term ? renderVisitTerm(term) : '';
  const banked = pickVariant(
    shown ? 'owner.availability.ack.term' : 'owner.availability.ack.noterm',
    { recent, vars: { prop, term: shown } },
  );
  if (banked) return banked;
  if (!shown) {
    return `Одлично, значи недвижноста${prop} е достапна. Кој термин Ви одговара за посета?`;
  }
  // The term question stays OPEN and ends on a question mark (the owner-answer
  // contract: every reply to the owner carries the ask back).
  return `Одлично, значи недвижноста${prop} е достапна. Дали Ви одговара посета во ${shown}, или имате друг предлог?`;
}

export const FEE_GRACEFUL_CLOSE =
  'Целосно Ве разбирам. Ви благодарам на искреноста. Ќе ги забележам Вашите критериуми и штом се појави соодветна недвижност, ќе Ве контактирам. Ви посакувам пријатен ден!';

// Exhausted-options flow: the client agreed to register criteria / be contacted
// after every matching option was shown. Code-built, so it never dead-ends.
export const QUEUE_CONTACT_ASK =
  'Во ред, ќе ги забележам Вашите барања. За да Ве контактирам штом се појави соодветна недвижност, ве молам кажете ми го Вашето име и телефонски број за контакт.';

/** Contact ask: asks ONLY for what is still missing. In real Viber the sender
 *  id IS the caller's number (prefilled into slots.phone) — so she asks only
 *  for the name; when the name is already stored but the phone is not (TUI /
 *  non-Viber), she asks only for the phone and NEVER repeats the name the
 *  client just gave ("па ти ги напишав" — exactly that frustration).
 *  Bank-backed: contact.ask.name / contact.ask.phone / contact.ask.name.phone
 *  (validated at generation time — the name-only form can never mention a
 *  phone, the phone-only form can never mention a name), with the exact
 *  code-built line as fallback. */
export function buildContactAsk(slots: SlotData, recent: string[] = []): string {
  const needName = !slots.name;
  const needPhone = !slots.phone;
  const key = needName && needPhone ? 'contact.ask.name.phone' : needName ? 'contact.ask.name' : 'contact.ask.phone';
  return pickVariant(key, { recent })
    ?? (needName && needPhone
      ? 'За да можам веднаш да стапам во контакт со сопственикот, ве молам да ми го кажете Вашето име и презиме, како и телефонски број за контакт.'
      : needName
        ? 'За да можам веднаш да стапам во контакт со сопственикот, ве молам да ми го кажете Вашето име и презиме.'
        : 'За да можам веднаш да стапам во контакт со сопственикот, ве молам да ми го кажете Вашиот телефонски број за контакт.');
}

export const QUEUED_CONFIRM =
  'Ви благодарам! Вашите барања се забележани. Ќе Ве контактирам веднаш штом се појави соодветна недвижност. Ви посакувам пријатен ден!';

// ── Conversation-exit family (the [13:2x] V16K11 ending) ──────────────────
// The client says goodbye ("ne fala ti / cao") — she helped enough, it is
// his loss. The farewell NEVER re-offers help and NEVER ends with a question:
// it closes with „Се најдобро!" and stops. Bank-backed (bye.graceful).
export const BYE_GRACEFUL = 'Ви благодарам за издвоеното време. Ви посакувам сè најдобро!';
/** SECOND farewell in one session — all bye.graceful variants share the
 *  «Ви благодарам за издвоеното време» skeleton, so a back-to-back goodbye
 *  ("Ne fala" → "Cao") repeated it word-for-word. The repeat serve swaps to
 *  a SHORT parting without the thank-you: no skeleton, no repeat. */
export const BYE_AGAIN = 'Пријатно. До нареден пат. Поздрав!';

// The bare soft decline ("ne sakam", "не фала") right after an answer — the
// client is done with THIS topic. She respects it and closes warmly (the
// criteria stay registered; if something appears, HE will be contacted — no
// re-offer question). Rung-preserving: never burns a fee refusal.
export const SOFT_REFUSAL_CLOSE =
  'Разбирам, почитувам ја Вашата одлука. Вашите критериуми остануваат забележани — ако се појави нешто соодветно, ќе Ве контактираме. Ви посакувам сè најдобро!';

// ── Owner-contact confirmation (the [19:56] funnel-order rule) ────────────
// A visit-timing QUESTION ("KOGA BI MOZELO DA SE POSETI") must first confirm
// the owner ping — the client's explicit agreement opens the fee disclosure,
// never the other way around. Amount-free: the fee is named ONLY after the
// confirm. Bank-backed (visit.confirm.ask — three user-approved variants).
export const VISIT_CONFIRM_ASK =
  'Треба да го контактирам сопственикот, да ја проверам моменталната достапност и цена. Ако е сè во ред, тогаш би го договориле терминот за посета. Дали е тоа во ред со Вас?';

// ── Exit final-check (the V16K11 second capture) ──────────────────────────
// BEFORE the farewell — the client is ending the conversation without ever
// being asked whether ANY offered option has a chance. ONE short question,
// amount-free, property-free, no farewell inside. The first two lines are the
// owner-dictated wordings; the third anchors the Gemini variants.
export const EXIT_CRITERIA_CHECK =
  'Пред да се поздравиме, кажете ми дали некој од понудените станови има шанса кај Вас?';
export const EXIT_CRITERIA_CHECK_2 =
  'Пред да прекинеме, кажете ми дали некоја од понудените опции ги задоволува Вашите критериуми?';
export const EXIT_CRITERIA_CHECK_3 =
  'Пред да Ви се поздравам, дали сакате да ги погледнеме уште еднаш понудените предлози, да кажете дали некој има шанса?';

// --- Deterministic empty-result lines: the LLM must NEVER invent properties. ---
// When a search/property lookup yields no data, the reply is code-built so the
// model is never given a chance to fabricate listings.
export const NO_MATCH_LINE = (location?: string): string =>
  location
    ? `За жал, моментално немам слободни недвижности во ${location} што одговараат на Вашите критериуми. Дали сте отворени за други локации?`
    : 'За жал, моментално немам слободни недвижности што одговараат на Вашите критериуми. Дали би сакале да разгледаме други опции?';

export const PROPERTY_NOT_FOUND_LINE = (eb: number): string =>
  `За жал, не можам да ја најдам недвижноста со Евидентен број ${eb} во нашата моментална понуда. Дали би сакале да Ви предложам слични недвижности од други локации?`;

export const FEED_UNAVAILABLE_LINE =
  'Моментално имам техничка потешкотија со проверката на понудата. Ве молам, обидете се повторно за неколку минути.';

// Closing-question variations — the SAME sentence every presentation reads
// robotic. The code-built cards rotate through these deterministically, and the
// LLM task instructs the model to vary its phrasing too.
export const PRESENTATION_CLOSERS = [
  'Дали Ви се допаѓа некој од овие предлози и дали би сакале да организираме посета на недвижноста?',
  'Дали некој од овие предлози Ви одговара? Ако да, можам веднаш да организирам посета.',
  'Кој од овие предлози најмногу Ви одговара? Би сакала да Ви организирам посета во термин по Ваш избор.',
  'Дали некој од овие предлози е тоа што го барате? Доколку е, веднаш ја закажувам посетата.',
  'Што мислите за овие предлози? Ако некој Ви се допаѓа, ќе организирам посета кога Ви одговара.',
];

export const PROPERTY_QUERY_CLOSERS = [
  'Дали би сакале да организираме посета на оваа недвижност?',
  'Дали оваа недвижност Ви одговара? Доколку сакате, можам да организирам посета.',
  'Дали би сакале да го разгледате овој стан на лице место? Ќе организирам посета во термин по Ваш избор.',
  'Дали овој стан е тоа што го барате? Ако е, со задоволство ќе организирам посета.',
];

// The code-built closers stay FIRST (indices 0..n are the exact lines the tests
// and the LLM task reference); generated bank variants extend the rotation so
// the closing question varies more without ever repeating.
const bankClosers = (key: string): string[] => RESPONSE_BANK[key] ?? [];
export const PRESENTATION_CLOSERS_ALL = [...PRESENTATION_CLOSERS, ...bankClosers('closer.presentation')];
export const PROPERTY_QUERY_CLOSERS_ALL = [...PROPERTY_QUERY_CLOSERS, ...bankClosers('closer.property_query')];

export function pickCloser(list: string[], index: number): string {
  return list[((index % list.length) + list.length) % list.length];
}

export const NO_MORE_ALTERNATIVES_LINE = (location?: string): string =>
  location
    ? `Ги исцрпивме сите расположливи недвижности што одговараат на Вашите критериуми${location ? ` во ${location}` : ''}. Можам да ги забележам Вашите барања и да Ве контактирам штом се појави соодветна недвижност, или да погледнеме во друга населба?`
    : 'Ги исцрпивме сите расположливи недвижности што одговараат на Вашите критериуми. Можам да ги забележам Вашите барања и да Ве контактирам штом се појави соодветна недвижност, или да погледнеме во друга населба?';

/**
 * Answer to a "каде е X?" question — code-built from DB facts (address /
 * neighborhood) when the place is known, honest line otherwise. NEVER a
 * search/exhausted reply and never a link; unknown places pivot to a visit
 * offer instead of inventing geography.
 */
export function buildWhereIsAnswer(place: string, found?: { address?: string; location?: string; eb?: number; business?: boolean; landmark?: string }): string {
  const loc = found?.location;
  const eb = found?.eb;
  // Address PRIVACY: "каде е X?" is answered with the nearest PUBLIC LANDMARK
  // ("во близина на City Mall") — like a human agent — never the street, so
  // the client can't bypass the agency by visiting the owner directly.
  if (found?.landmark) return `Тоа се наоѓа во близина на ${displayPlaceName(found.landmark)}.`;
  if (loc && eb) return `Тоа се наоѓа во населбата ${loc}.`;
  if (loc) return `${place || 'Тоа'} е населба во Скопје.`;
  if (place) return `Тоа место не ми е познато во нашата база. Ако сакате, можам да Ви организирам посета за да го погледнете на лице место.`;
  return 'За точната локација, можам да Ви организирам посета — сакате ли?';
}

// The client asks for the EXACT street/address of a property ("потoчно која
// улица?", "точно која адреса?", "на која адреса е?") — address PRIVACY is
// absolute: the exact address is revealed ONLY 2 hours before the arranged
// visit (the system sends it), never in chat. Code-built, bank-backed
// (address.exact) so the wording varies without the LLM ever answering — the
// model must never get a chance to slip the street out.
export const EXACT_ADDRESS_LINES = [
  'Точната адреса ќе ја добиете 2 часа пред посетата.',
  'Точната локација ќе ја дознаете на денот на посетата.',
  'Системот на откривање на точната локација на денот на посетата е правило по кое функционира Агенцијата.',
];

export function buildExactAddressAnswer(recent: string[] = []): string {
  return pickVariant('address.exact', { recent })
    ?? EXACT_ADDRESS_LINES[Math.floor(Math.random() * EXACT_ADDRESS_LINES.length)];
}

/** The client names the places they can see and asks WHICH SIDE of them the
 *  property is on („od stranata na trgovskiot ili odkaj pazarceto“ — the
 *  [01:29] capture). Answered from the property's REAL anchors: the nearest
 *  place the client named IS the side they mean, and the others are named as
 *  further away — both distances come from the map, never from a guess.
 *
 *  CODE-OWNED, like buildWhereIsAnswer: the geography may never be generated.
 *  The street still never appears — the answer names PUBLIC places only. */
export function buildSideAnswer(nearest: string, further: string[] = []): string {
  const head = `Недвижноста е на страната на ${nearest}.`;
  if (further.length === 0) return head;
  return `${head} ${further[0]} е понатаму од недвижноста.`;
}

function bedroomWord(n: number): string {
  if (n === 1) return 'една спална соба';
  if (n === 2) return 'две спални соби';
  if (n === 3) return 'три спални соби';
  return `${n} спални соби`;
}

/** Render a budget for display ("80000" -> "80.000"). undefined when the slot
 *  carries no number at all — a garbage budget must never be echoed. */
function formatBudget(b: string): string | undefined {
  const n = Number(b.replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n.toLocaleString('mk-MK') : undefined;
}

/** Bank-backed discovery question (fallback = the exact code-built line). */
function askQuestion(key: string, fallback: string, recent: string[]): string {
  return pickVariant(key, { recent }) ?? fallback;
}

/**
 * The discovery ask is CODE-BUILT: it only ever asks for what is still
 * missing (intent -> location -> size -> price) and NEVER re-asks what the
 * client already gave. There is NO recap — "Разбрав — барате …" repeats what
 * the client just said, which reads robotic ("RETARD REPEATING WHAT WAS
 * ASKED"); the questions themselves carry the type (станот/куќата/деловниот).
 * Each question is bank-backed per property type with the exact code-built
 * line as fallback, so the wording varies ("Дали може да знам во кој дел…?",
 * "Кажете ми во кој дел…?", "Дали имате дефинирано во која населба…?").
 * Commercial spaces (деловен простор) complete with square meters instead of
 * bedrooms — a "деловен простор" request must never be asked "колку спални?".
 */
// City-level locations are too broad — the bot should ask which neighbourhood.
// When Groq infers "Скопје" from conversation history, we treat it as "no specific
// neighbourhood" and still ask the location question with neighbourhood variants.
const CITY_LEVEL_LOCATIONS = /^(?:Скопје|Skopje|скопjе|skopje)$/iu;

/** THE LOCATION CRITERION — one reader for the ask AND the serve.
 *
 *  `buildDiscoveryAsk` has always known that a CITY-LEVEL value («Скопје»,
 *  usually inferred, never said) is not an answer to «во кој дел од градот?»;
 *  the serve-side `slotsComplete()` read the raw slot. The two disagreed, and
 *  that is exactly the shape of the [00:36] capture: the funnel asked «во која
 *  населба или дел од градот?», the client answered only the TYPE («DUKJAN MI
 *  TREBA»), and the serve counted the inferred «Скопје» as the area — a pair
 *  went out for a neighbourhood nobody had named. A «било каде» waiver and a
 *  resolved landmark anchor ARE location answers (the [16:11]/[23:47] rules),
 *  so they stay here.
 */
export function locationCriterionKnown(slots: SlotData): boolean {
  return (!!slots.location && !CITY_LEVEL_LOCATIONS.test(slots.location))
    || !!slots.anywhere
    || !!(slots.poiAnchor || slots.poiArea);
}

/** THE SERVICE CRITERION — same one reader. Only the CLIENT's own declaration
 *  (or a dual deal) answers «купување или изнајмување?»; a market pinned from a
 *  served row (`serviceInferred`, the [10:16] rule) does not. */
export function serviceCriterionKnown(slots: SlotData): boolean {
  return (!!slots.service && !slots.serviceInferred) || !!slots.dualService;
}

/** WHICH CRITERION AN ASK IS ABOUT — the funnel's own axis names, in the order
 *  the ask builder pushes them. A caller that must read a DISMISSAL
 *  («НЕБИТНО») needs the axis, not the sentence: the bank rotates the wording,
 *  so matching the copy («населб|дел од градот|каде») missed the variant
 *  «На која локација во градот …?» and served the size waiver to an AREA
 *  dismissal — the funnel then re-asked the area ([23:48], and the pty funnel
 *  failed only on the rotations whose wording happened to miss the tokens). */
export type DiscoveryCriterion = 'service' | 'type' | 'area' | 'sqm' | 'bedrooms' | 'budget';

export interface DiscoveryAsk { text: string; criteria: DiscoveryCriterion[] }

function buildDiscoveryAskDetailed(slots: SlotData, recent: string[] = []): DiscoveryAsk {
  const business = !!slots.business;
  const house = !!slots.house;
  const plac = !!slots.plac;    // "плац за градење" — land plot (the 22:53 sweep)
  const yard = !!slots.yard;    // "со двор/дворче" — outdoor-space need (implies house)
  const anywhere = !!slots.anywhere; // "било каде" — location waived, city-wide search
  // A LANDMARK ANCHOR IS A LOCATION ANSWER (the [13:29] capture): the client
  // said «во близина на Буњаковец» — he pointed at the part of town, and the
  // discovery block resolved the place to the feed's own area (Bunjakovec →
  // Центар). Asking «во која населба?» after that re-asks what he just said,
  // and the funnel stalls instead of asking bedrooms + budget.
  // A CITY-LEVEL value ("Скопје", typically inferred, never said) is NOT a
  // location answer — unless the anchor already named the area.
  const locationKnown = locationCriterionKnown(slots);
  // DUAL SERVICE IS AN ANSWERED SERVICE (the [23:10] capture: «MOZE DA GO
  // IZNAJMAM , A AKO IMA DOBRA CENA MOZE I DA KUPAM»). In dual mode
  // slots.service is deliberately retired (a single segment would pin every
  // offer), so the asks below read the flag instead — asking «за купување или
  // за изнајмување?» straight after he said BOTH is the loop this capture is.
  const dual = !!slots.dualService;
  // A MARKET PINNED FROM A BROWSE BATCH IS THE FEED'S WORD (the [10:16] capture):
  // «што имате околу X» served a row, the pin took its service so the pool and
  // the protocols stay coherent — but the client never said buy or rent, and
  // reading the pin as an answered criterion is what turned the next turn into
  // «колку спални соби…» for an apartment nobody named. Only HIS declaration
  // (or a dual deal) answers the market question.
  const serviceKnown = serviceCriterionKnown(slots);
  const knownAny = !!(serviceKnown || locationKnown || slots.bedrooms || (slots.bedroomsMin !== undefined && slots.bedroomsMax !== undefined) || slots.sqm || slots.budget || slots.sqmRate || anywhere);
  // The client opened with NO criteria at all ("zdravo") — Lina does NOT know
  // the property type, so she must never assume an apartment. Bank key
  // greeting.open (generated variants, validated to never mention a type)
  // with the user's sample line as the code-built fallback.
  // ПЛАЦ/yard are NAMED CATEGORIES (the [09:38] expansion) — a плац opener
  // must get the плац intro, never the type-neutral greeting and never the
  // house intro (the [20:15] ask class, the discovery sibling).
  if (!business && !house && !plac && !yard && !knownAny) {
    // The opener asks the MARKET, so that is the criterion it is about.
    return {
      text: pickVariant('greeting.open', { recent })
        ?? 'Повелете. Дали Ве интересира купување или изнајмување на недвижност?',
      criteria: ['service'],
    };
  }
  // THE TYPE IS UNKNOWN ONLY WHEN NOTHING NAMES IT — and then it is ASKED,
  // never assumed (the [04:17] capture: «ZDRAVO. STO IMATE VO BUNJAKOVEC?» got
  // «Дали станот го барате…?» for an apartment the client never mentioned).
  // Two ways to know it:
  //  - a POSITIVE category flag (куќа / деловен простор / плац / двор / гарсоњера), or
  //  - FLAT EVIDENCE: the client said стан/апартман, or gave a bedroom count
  //    (only a residential unit has спални). A flat has no flag of its own, so
  //    without the `flat` slot «MI TREBA STAN» and «STO IMATE VO BUNJAKOVEC?»
  //    were the same message and both got the apartment wording.
  // While the type is unknown the funnel asks the TYPE and HOLDS BACK the
  // type-specific questions: «колку спални» is a question a дуќан never has, and
  // a price cap is worded differently for a плац.
  // EITHER RESIDENTIAL TYPE IS AN ANSWERED CATEGORY (the [23:49]/[23:50]
  // capture): «ЗА ЖИВЕЕЊЕ МИ Е» and «СТАН ИЛИ КУЌА» say «a home», which is
  // MORE than «nothing» and mostly less than «стан» — the funnel must stop
  // asking «каков вид на недвижност?» and must never word its next question
  // «станот». The wording goes NEUTRAL (any) on that branch below.
  const residential = !!slots.residential;
  const flatEvidence = !!slots.flat || !!slots.garsonjera || slots.house === false
    || slots.bedrooms !== undefined || slots.bedroomsMin !== undefined || slots.bedroomsMax !== undefined;
  const typeKnown = business || house || plac || yard || flatEvidence || residential;
  const missing: string[] = [];
  const criteria: DiscoveryCriterion[] = [];
  if (!serviceKnown) {
    criteria.push('service');
    missing.push(typeKnown
      ? askQuestion(
        plac ? 'discovery.ask.service.plac'
          : business ? 'discovery.ask.service.business' : (house || yard) ? 'discovery.ask.service.house' : 'discovery.ask.service.stan',
        plac ? 'Дали го барате плацот за купување или за изнајмување?'
          : business ? 'Дали го барате за купување или за изнајмување?'
          : (house || yard) ? 'Дали куќата ја барате за купување или за изнајмување?'
          : 'Дали станот го барате за купување или за изнајмување?',
        recent)
      // THE TYPE-NEUTRAL MARKET QUESTION. Its bank variants are validated to
      // name NO property type (ban list: стан/куќа/деловен/апартман/плац) — a
      // flat is not a safe default either, the client may want a shop or a plot.
      : askQuestion('discovery.ask.service.any',
        'Дали Ве интересира купување на недвижност или претпочитате изнајмување?', recent));
  }
  // THE TYPE QUESTION (the [02:15] / [04:17] / [19:06] family): the client
  // asked what is AVAILABLE at a place, or for «nesto interesno» and then the
  // deal, and has not said WHAT — the serve cannot pick a category without it
  // (спални + цена vs м² + цена vs цена alone), so the type-specific pair is
  // held back. This used to fire only for the stock-at-a-place intake; the
  // [19:06] capture proved the same hole anywhere the funnel stands.
  // THE APARTMENT IS NEVER THE DEFAULT (the [19:06] capture: «MI TREBA NESTO
  // INTERESNO KAJ CITY MOL» → «PA DA KUPAM BI SAKAL» was answered with «Колку
  // спални соби би Ви одговарале во станот?» — a category the client never
  // named). The type is ASKED whenever nothing names it, wherever the funnel
  // stands: a bedroom count, a м² figure and the price wording are all
  // category-specific, so none of them may be asked before the category is on
  // file. The [13:44] loop this used to guard against is already protected by
  // `typeKnown` — a client who answered «EDNA» supplied flat evidence, so the
  // type question can never follow it.
  const typeHeld = !typeKnown;
  if (serviceKnown && typeHeld) {
    criteria.push('type');
    // The same question the dual-service lane uses — «Кој тип недвижност Ве
    // интересира? Стан, куќа, деловен простор или плац?» — bank-backed, names
    // every category the feed sells.
    missing.push(askQuestion('both.ask.type',
      'Кој тип недвижност Ве интересира — стан, куќа, деловен простор или плац?', recent));
  }
  // Size questions never fire for plac/yard: a land plot has no спални, and a
  // yard need already IS the size criterion (mirror of the garsonjera rule).
  const sizeWaivedCategory = plac || yard;
  // "Било каде" answers the location question — the question is skipped, and
  // the bedrooms question too (a flexible client gets the budget-driven
  // city-wide presentation; bedrooms refine later via rejections, never block).
  // ONE LOCATION ASK, WORDED FOR WHAT IS ACTUALLY KNOWN (the [04:17] family):
  // the type-specific pool names the category the client stated, and the
  // type-neutral pool (`discovery.ask.location.any`, variants ban-listed to
  // name no property type) answers when he named none — «во кој дел од градот
  // го барате станот?» is a flat nobody said. It used to be TWO separate
  // pushes, so an unknown-type session got the neutral ask AND the flat one in
  // the same reply, the second naming the apartment the first had avoided.
  // THE AREA QUESTION IS TYPE-NEUTRAL, so an unknown type does not hold it
  // back — only its CATEGORY-WORDED form does (a tournament «дел од градот
  // го барате станот» is a flat nobody named). The neutral pool carries the
  // wording that names no type; the category pools answer once the type is on
  // file (the [19:06] contract).
  if (serviceKnown && !locationKnown) {
    criteria.push('area');
    missing.push(typeKnown && !residential
      ? askQuestion(
        plac ? 'discovery.ask.location.plac'
          : business ? 'discovery.ask.location.business' : house ? 'discovery.ask.location.house' : 'discovery.ask.location.stan',
        plac ? 'Во кој дел од градот го барате плацот?'
          : business ? 'Во кој дел од градот го барате?'
          : house ? 'Во кој дел од градот ја барате куќата?'
          : 'Во кој дел од градот го барате станот?',
        recent)
      : askQuestion('discovery.ask.location.any',
        'Во кој дел од градот ја барате недвижноста?', recent));
  }
  if (serviceKnown && !typeHeld && locationKnown && business && !slots.sqm) {
    criteria.push('sqm');
    missing.push(askQuestion('discovery.ask.sqm.business', 'Која површина (во м²) ја барате?', recent));
  }
  // "garsonjera" IS the size answer — a studio has no separate спална, so the
  // bedrooms question never fires for the explicit studio category (19:34 bug:
  // the funnel looped on "Колку спални…" after the client already said it).
  // A bedroom RANGE ("edna ili dve", [09:17]) IS the size answer — the
  // alternation ladder owns presentation; asking again re-asks an answered
  // question (the transcript loop).
  if (serviceKnown && !typeHeld && locationKnown && !business && !slots.bedrooms
    && !(slots.bedroomsMin !== undefined && slots.bedroomsMax !== undefined)
    && !anywhere && !slots.sizeWaived && !slots.garsonjera && !sizeWaivedCategory) {
    criteria.push('bedrooms');
    // NEUTRAL WORDING FOR THE RESIDENTIAL FAMILY (the [23:50] capture): a
    // client who said «стан или куќа» is not committed to either, so
    // «…соби …во станот?» would name a type he did not choose.
    missing.push(residential
      ? askQuestion('discovery.ask.bedrooms.any',
        'Колку спални соби би сакале да има недвижноста?', recent)
      : askQuestion(
        house ? 'discovery.ask.bedrooms.house' : 'discovery.ask.bedrooms.stan',
        house ? 'Колку спални соби би сакале да има куќата?' : 'Колку спални соби би сакале да има станот?',
        recent));
  }
  // A DUAL funnel already holds a per-service money answer when either leg is
  // on file — it asks for the missing one only, never for a single cap that
  // would silently govern both services.
  // A €/m² ceiling IS the money answer (the [02:09] capture): «PO 1500E ZA
  // KVADRAT» already capped the rate, so asking «до која цена» would re-ask
  // what the client just said.
  if (serviceKnown && !typeHeld && locationKnown && !slots.budget && !slots.sqmRate && !slots.pricePriority
    && !(dual && (slots.rentBudget !== undefined || slots.buyBudget !== undefined))) {
    // RENT asks about the MONTHLY rent (месечна кирија), not a purchase price —
    // "колку е киријата?" is the client's question, and the budget slot is the
    // monthly amount the presentation filters rent listings by.
    const rent = slots.service === 'rent' && !business;
    // A ПЛАЦ is neither a стан nor a куќа — asking "…цената на станот" on a
    // land-plot funnel names the wrong category (the same failure family as
    // the [09:29] business capture). Bank key is optional; the code line is
    // the fallback when the bank has no plac variants yet.
    criteria.push('budget');
    missing.push(askQuestion(
      business ? 'discovery.ask.budget.business'
        : plac ? 'discovery.ask.budget.plac'
        : (rent && house) ? 'discovery.ask.budget.house'
        : rent ? 'discovery.ask.budget.rent'
        : house ? 'discovery.ask.budget.house'
        : 'discovery.ask.budget.stan',
      business ? 'До која цена го барате?'
        : plac ? 'До која цена го барате плацот?'
        : (rent && house) ? 'До колку евра месечна кирија би Ви одговарала за куќата?'
        : rent ? 'До колку евра месечна кирија би Ви одговарала?'
        : house ? 'До која цена ја барате куќата?'
        : 'До која цена го барате станот?',
      recent));
  }
  // A type-only request ("ми треба куќа" — no service/location yet) opens with
  // the type greeting intro ("Здраво! За да Ви најдам најсоодветна куќа…"),
  // bank-backed; it is a greeting, NOT a recap, so it never repeats the client.
  // But it must NOT greet twice: the [09:21] ZDRAVO → [09:22] MI TREBA LOKAL
  // transcript heard "Здраво" and then "Добар ден!" in the very next message,
  // as if the conversation had restarted. The greeting prefix is kept only on
  // the first outbound message (recent is empty); afterwards it is dropped.
  const introRaw = !knownAny
    ? pickVariant(
        business ? 'discovery.intro.business'
          : plac ? 'discovery.intro.plac'
          : 'discovery.intro.house', { recent })
      ?? (business
        ? 'Здраво! За да Ви најдам најсоодветен деловен простор, ве молам кажете ми неколку детали.'
        : plac
          ? 'Здраво! За да Ви најдам најсоодветен плац, ве молам кажете ми неколку детали.'
          : 'Здраво! За да Ви најдам најсоодветна куќа, ве молам кажете ми неколку детали.')
    : undefined;
  const intro = introRaw && recent.length > 0 ? dropLeadingGreeting(introRaw) : introRaw;
  if (missing.length === 0) {
    return { text: intro ?? 'Во ред, ги забележав Вашите критериуми.', criteria: [] };
  }
  const questions = missing.length === 1
    ? missing[0]
    : missing.map((q, i) => `${i + 1}. ${q}`).join('\n');
  return { text: intro ? `${intro}\n${questions}` : questions, criteria };
}

/** The funnel's ask, as copy (every existing caller). */
export function buildDiscoveryAsk(slots: SlotData, recent: string[] = []): string {
  return buildDiscoveryAskDetailed(slots, recent).text;
}

/** The criteria the ask is ABOUT — the read a dismissal needs (see
 *  DiscoveryCriterion). Same call, so the answer can never drift from the copy
 *  the client actually received. */
export function discoveryAskCriteria(slots: SlotData, recent: string[] = []): DiscoveryCriterion[] {
  return buildDiscoveryAskDetailed(slots, recent).criteria;
}

/** The criteria questions the funnel still OWES this session, or undefined
 *  when every criterion for the session's own category is already on file.
 *
 *  The LLM-less serve needs the same answer the discovery turn gives: a card
 *  batch alone is a catalogue dump, and the questions are the funnel's own —
 *  type-aware (спални + цена for стан/куќа, м² + цена for деловен простор/плац)
 *  and never re-asking what the client already said. `buildDiscoveryAsk`
 *  returns no question at all when nothing is missing, so a question mark is
 *  the exact signal (its zero-missing branch is the plain «ги забележав
 *  Вашите критериуми» line).
 */
export function missingCriteriaAsk(slots: SlotData, recent: string[] = []): string | undefined {
  const ask = buildDiscoveryAsk(slots, recent);
  return ask.includes('?') ? ask : undefined;
}

/** A greeting prefix a started conversation must not repeat. Covers every
 *  opener the intro bank uses (including the "Добродојдовте" typo form that
 *  lives in the bank) plus "и добредојдовте" compounds. */
const LEADING_GREETING_RE = /^(?:(?:Здраво|Добар\s+ден|Добродојдовте|Добродојдовте|Повелете)(?:\s+и\s+добредојдовте)?)\s*[!.,]\s*/iu;

export function dropLeadingGreeting(text: string): string {
  const stripped = text.replace(LEADING_GREETING_RE, '');
  if (stripped === text || stripped.length === 0) return text;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/** The confirmation is CODE-BUILT — phones and dates are never LLM-generated.
 *  The time is normalizeOwnerTime'd ([12:42] lesson): the client's raw
 *  shorthand ("DA\nPONEDELIK 6") must never echo back — the canonical
 *  display form ("Понеделник, 28.09.2026 во 18:00") does; unresolvable
 *  phrases keep mkTimePhrase (day-fix + display caps). */
export function buildVisitConfirmation(eb: number, time: string, agentPhone: string): string {
  return `Договорена посета на стан ЕБ ${eb}, ${normalizeOwnerTime(time)} / Агент ${agentPhone} / Точна локација 2 часа пред посетата / Ви благодарам на довербата.`;
}

/**
 * The waiver ack — the client said size doesn't matter ("nebitno"), so Lina
 * CONFIRMS the waiver in one short line. The biggest-for-the-money exposure
 * is NAMED with the client's REAL budget (the [21:40] contract: "the ack
 * must carry the budget"), interpolated from the live slot — never streamed
 * tokens ({budget}/{open}budget}, the verbatim leak of the [20:33] TUI
 * capture). A missing budget keeps the plain line. Served ONCE per waiver
 * (the caller owns the waiverAcked flag) — later presentations stay plain
 * cards.
 */
export function waiverAck(budget: string | undefined, recent: string[] = []): string {
  const base = pickVariant('discovery.waiver.ack', { recent })
    ?? 'Во ред, големината не е проблем.';
  // GRAMMAR (the [10:05] capture): the sentence read «За 300 евра Ви
  // покажувај од најголемите прво» — an imperative dropped into a statement
  // ("show" instead of "I show"). It states what SHE does, in the present:
  // «Ви ги покажувам најголемите прво».
  return budget
    ? `${base} За ${budget} евра Ви ги покажувам најголемите прво.`
    : base;
}

/**
 * The viewing-fee disclosure — CODE-BUILT, so it can never be skipped or
 * paraphrased by the LLM. Fired the moment the client shows interest in
 * visiting (INTERESTED -> closing). The owner is contacted only AFTER the
 * client agrees (FEE_AGREED -> contact_collection -> … -> owner_checking).
 */
export function buildFeeAsk(service: Service | undefined): string {
  // Service UNDEFINED is a LITERAL case (the [09:0x] V16K11 bug): the old
  // `=== 'rent' ? A : B` ternary read a missing slot as "buy" and quoted the
  // 500-den/0% commission at a RENT client whose session had reset. Ask both,
  // and let the answer pin the slot.
  if (service === undefined) {
    return 'Мило ми е. Пред да продолжиме, мора да Ве известам за политиката на Метрополис: посетата на недвижност се наплаќа симболично — 300 денари (5 евра) за изнајмување, 500 денари (10 евра) за купување. Дали Ве интересира изнајмување или купување, за да ги прецизираме условите?';
  }
  return service === 'rent'
    ? 'Мило ми е. Пред да го повикам сопственикот, мора да Ве известам за политиката на Метрополис: разгледувањето на недвижност чини симболични 300 денари (5 евра). Дали се согласувате со овие услови за да можеме да продолжиме?'
    : 'Одличен избор. Бидејќи станува збор за купување, имам одлична вест и еден мал услов за Вас. Кај нас во Метрополис, Вие како купувач НЕ плаќате агенциска провизија (0%) — единствениот трошок е симболични 500 денари (10 евра) за организирање на посетата. Дали се согласувате со овој услов за да можеме да продолжиме?';
}

/**
 * THE PER-PROPERTY FEE ANSWER (the [23:44]/[23:45] capture): the client asked
 * whether the visit fee is charged PER FLAT and then did the sum himself
 * («AKO GI VIDAM DVATA TOA SE 1000DEN»). The honest answer confirms the rule
 * and the arithmetic in his own terms — the fee is per property viewing, so
 * two properties are two fees, and the total is named — then keeps the fee
 * question open. It never persuades (the ladder owns resistance) and never
 * searches (nothing about the arithmetic is a property query). The market is
 * the DECLARED one; an undeclared market names both fees instead of defaulting
 * to the buy copy (the [09:0x] 300-vs-500 rule).
 */
export function buildFeePerProperty(service: Service | undefined, count?: number): string {
  const mk = (n: number) => n.toLocaleString('mk-MK');
  if (service === undefined) {
    const sum = count && count > 1
      ? `Значи за ${count === 2 ? 'двете недвижности' : `${count} недвижности`} тоа е ${mk(300 * count)} денари за изнајмување или ${mk(500 * count)} денари за купување. `
      : '';
    return `Да, надоместот е по недвижност, односно за секое разгледување: 300 денари (5 евра) за изнајмување и 500 денари (10 евра) за купување. ${sum}Дали Ве интересира изнајмување или купување, за да ги прецизираме условите?`;
  }
  const per = service === 'rent' ? 300 : 500;
  const evr = service === 'rent' ? '5 евра' : '10 евра';
  const prov = service === 'rent' ? '' : ' Агенциската провизија за купувач останува 0%.';
  if (count && count > 1) {
    const what = count === 2 ? 'двете недвижности' : `${count} недвижности`;
    return `Да, точно — ${mk(per)} денари (${evr}) се за секое разгледување, односно по недвижност. За ${what} тоа е вкупно ${mk(per * count)} денари.${prov} Дали се согласувате со овој услов за да ги закажеме посетите?`;
  }
  return `Да, точно — ${mk(per)} денари (${evr}) се за секое разгледување, односно по недвижност.${prov} Дали се согласувате со овој услов за да ја закажеме посетата?`;
}

/**
 * TWO OR MORE FLATS IS THE SAME DISCLOSURE, EXTENDED (the owner's 2026-11-12
 * directive, the [04:10] field capture). The one-flat disclosure is the copy
 * the owner calls perfected, and the bank carries a dozen variants of it — so
 * a two-flat visit must NOT replace it with a separate fixed sentence (the
 * field served «Посетата е за становите… Да, точно — 500 денари … За двете
 * недвижности тоа е вкупно 1.000 денари», a different voice mid-protocol, and
 * the perfect answer was lost). This keeps the SERVED variant verbatim and
 * inserts one sentence before its closing question: the per-property rule and
 * the sum. The arithmetic is the only thing a visit to several flats adds.
 *
 * The sentence is inserted before the LAST question sentence so the disclosure
 * still ends with its agreement ask (the pool contract), and an undeclared
 * market names BOTH fees — never a defaulted 500 (the [09:0x] rule) — exactly
 * as buildFeePerProperty does for the arithmetic-only answer.
 */
export function extendFeeAskForCount(copy: string, service: Service | undefined, count: number): string {
  if (count <= 1) return copy;
  const mk = (n: number) => n.toLocaleString('mk-MK');
  const what = count === 2 ? 'двете недвижности' : `${count} недвижности`;
  const sum = service === 'rent'
    ? `За ${what} тоа е вкупно ${mk(300 * count)} денари.`
    : service === 'buy'
      ? `За ${what} тоа е вкупно ${mk(500 * count)} денари.`
      : `За ${what} тоа е вкупно ${mk(300 * count)} денари за изнајмување или ${mk(500 * count)} денари за купување.`;
  const qm = copy.lastIndexOf('?');
  if (qm === -1) return `${copy.trimEnd()} ${sum} Дали се согласувате со овој услов за да ги закажеме посетите?`;
  // The START of the closing question sentence — a sentence boundary is a
  // terminator followed by whitespace, so a decimal or an abbreviation inside
  // the sentence never splits it.
  let cut = qm;
  for (let i = qm - 1; i >= 0; i--) {
    if (/[.!?\n]/u.test(copy[i]!) && /\s/u.test(copy[i + 1] ?? '')) { cut = i + 1; break; }
  }
  const head = copy.slice(0, cut).trimEnd();
  const tail = copy.slice(cut).trimStart();
  return `${head} ${sum} ${tail}`;
}

/** Fee persuasion ladder, keyed by refusal count (1 = persuade, 2 = ask why).
 *  Service UNDEFINED is a LITERAL case (the [09:0x] V16K11 bug): the old
 *  `=== 'rent' ? A : B` ternary served the buy copy at a rent client whose
 *  session had reset. The agnostic copy names BOTH fees so every read is
 *  correct — never fabricate a market the client has not declared. */
export function feePersuasion(service: Service | undefined, rejects: number): string {
  if (service === undefined) {
    return rejects >= 2
      ? 'Разбирам. Дозволете ми да Ве прашам — што Ве загрижува околу надоместот за посета (300 денари за изнајмување, 500 денари за купување)? Тој е симболичен и се однесува само на организирање на посетата. Можеби ќе најдеме решение заедно.'
      : 'Надоместот за разгледување е симболичен — 300 денари (5 евра) за изнајмување, 500 денари (10 евра) за купување — и се однесува само на организирање на посетата. Тој е мал во споредба со удобноста — гледате недвижност што навистина одговара на Вашите критериуми, без да губите време. Дали би можеле да размислите?';
  }
  if (rejects >= 2) {
    return service === 'rent'
      ? 'Разбирам. Дозволете ми да Ве прашам — што Ве загрижува околу надоместот од 300 денари? Тој е симболичен и се однесува само на организирање на посетата. Можеби ќе најдеме решение заедно.'
      : 'Разбирам. Дозволете ми да Ве прашам — што Ве загрижува околу надоместот од 500 денари? Имајте предвид дека кај нас како купувач НЕ плаќате провизија (0%) — тоа е заштеда од илјадници евра. Можеби ќе најдеме решение заедно.';
  }
  return service === 'rent'
    ? 'Надоместот за разгледување е симболични 300 денари (5 евра) и се однесува на организирање на посетата. Тој е мал во споредба со удобноста — гледате недвижност што навистина одговара на Вашите критериуми, без да губите време. Дали би можеле да размислите?'
    : 'Надоместот од 500 денари (10 евра) е единствениот трошок за Вас, бидејќи како купувач НЕ плаќате агенциска провизија — заштеда од илјадници евра во споредба со другите агенции. 10 евра е симболична сума за да ја видите недвижноста што навистина одговара на Вашите критериуми. Дали би можеле да размислите?';
}

/**
 * Answer to the fee-rules dismissal ("тоа се правилата на агенцијата кои
 * важат и за мене и за Вас", "тоа се Вашите правила") — the client files the
 * visit fee under "just your agency's policy". Lina confirms it IS agency
 * policy AND shows it binds both sides: the same rules for the client and
 * the agency (the owner pays the commission, the fee is symbolic, the
 * criteria rule — not the agent's mood). Bank-backed (fee.rules); ends with
 * the agreement ask so the funnel keeps moving. Amount-free on purpose (the
 * sum was already disclosed in the fee.ask).
 */
export const buildFeeRules = (): string =>
  'Точно — ова се правилата на нашата агенција, и важат подеднакво за Вас и за нас. Никој кај нас не е над правилата: сите клиенти го плаќаат истиот симболичен надомест за посета, а провизијата е на сопственикот. Сè зависи од Вашите критериуми, не од расположението — затоа побаруваме истиот услов од секого. Дали се согласувате со овој услов за да продолжиме?';

/**
 * Fee-resistance rung 2 — THE AGENCY RULE, never another pitch. The client
 * pushed back once (rung 1 = one persuasion) and pushes back again —
 * "PARI ZA POSETA BARATE", "OVA PRV PAT SLUSAM", "ne sakam da platam". She
 * stops selling and states the fact the client is really arguing with: the
 * visit fee is part of the agency's published price list (our MENU — it is on
 * every offer, not something she invented), it is the same for every client
 * and it is not her personal decision. Bank-backed (fee.rule.hold);
 * amount-free on purpose (the sum was already disclosed in the fee.ask) and
 * ending with the agreement ask so the funnel keeps moving.
 */
export const buildFeeRule = (): string =>
  'Ова е востановено правило на Агенцијата и се применува за секој клиент без исклучок — надоместот за посета е дел од нашиот официјален ценовник, ист за сите, а не моја лична одлука. Дали се согласувате со овој услов за да продолжиме?';

/**
 * Fee-resistance rung 3 — THE DECISION. The client heard the value (rung 1),
 * then the agency rule (rung 2), and keeps pushing: Lina stops arguing and
 * asks the question the whole resistance is about — book under the stated
 * conditions, or not. The ANSWER decides the funnel: yes → contact
 * collection (the workflow continues), no → the graceful close
 * (fee.graceful.close, the bye protocol). Owner-specified wording, kept
 * literal.
 */
export const buildFeeDecision = (): string =>
  'Да го решиме ова едноставно: дали да ја закажам посетата по наведените услови или не? Одлуката е Ваша.';

/**
 * THE FEE-RESISTANCE LADDER — one place, so the responder and the handler can
 * never serve different rungs (they drifted apart before: the same rung got
 * the persuasion in one path and the pivot in the other).
 *
 *   rejects 1  → a SINGLE persuasion (value framing, the declared market's copy)
 *   rejects 2  → the AGENCY RULE (the fee is in our published price list)
 *   rejects 3+ → THE DECISION (book under these conditions, or not)
 *
 * A rung is only burned by RESISTANCE (a refusal or a charge pushback) — a
 * why/rules/complaint question is explanation traffic and never advances the
 * ladder. The 4th resistance never reaches a rung: the FSM moves the session
 * to 'queued' and the bye protocol (fee.graceful.close) closes the chat. The
 * retired deep-persuasion rung (fee.persuade.2.*) stays seeded for direct
 * callers, but the live ladder no longer serves it — one persuasion is the
 * whole budget, then the rule, then the decision.
 */
export function feeLadder(service: Service | undefined, rejects: number): { key: string; line: string } {
  if (rejects >= 3) return { key: 'fee.decide', line: buildFeeDecision() };
  if (rejects === 2) return { key: 'fee.rule.hold', line: buildFeeRule() };
  return {
    key: service === 'rent' ? 'fee.persuade.1.rent' : 'fee.persuade.1.buy',
    line: feePersuasion(service, 1),
  };
}

// ── THE RENT-COMMISSION LADDER (the second money topic) ─────────────────────
//
// The rent commission is the OTHER money the client pays us (50% of one
// monthly rent below 1.000 €, one full monthly rent from 1.000 € up). It runs
// the SAME four-rung protocol as the visit fee, with its OWN copy and its OWN
// counter (slots.provisionRejections):
//
//   rung 0 — the DISCLOSURE (provision.ask.rent: the published tier rule)
//   rung 1 — ONE persuasion: the commission is a one-off covering the whole
//            rental process (vetting, owner coordination, legal check, contract)
//   rung 2 — THE AGENCY RULE: the published price list, the same for every
//            tenant, never a personal decision
//   rung 3 — THE DECISION: continue under the stated conditions, or not
//   rung 4 — the graceful close (the caller queues the customer)
//
// A BUY client has no commission to ladder (0% — the owner pays): resisting it
// there is a MISUNDERSTANDING, so the serve is the 0%-clarification and the
// caller must NOT count it as resistance. Same for an undeclared market — the
// agnostic copy names both scripts rather than inventing one.

/** The rent-commission disclosure, code-built (bank: provision.ask.rent). */
export function buildProvisionAsk(service: Service | undefined): string {
  if (service === 'rent') {
    return 'За изнајмување, агенциската провизија е 50% од една месечна кирија за недвижности под 1.000 евра, а една целосна месечна кирија за недвижности од 1.000 евра и повеќе. Сопственикот бара една кирија однапред и депозит, а минималниот престој е една година. Дали Ви одговараат овие услови за да продолжиме?';
  }
  if (service === 'buy') {
    return 'За купување, Вие како купувач НЕ плаќате агенциска провизија (0%) — провизијата ја плаќа сопственикот. Единствениот трошок за Вас е надоместот за посета од 500 денари (10 евра). Дали Ви одговара овој услов за да продолжиме?';
  }
  return PROVISION_ASK_NEITHER;
}

/** Commission resistance rung 1 — ONE value persuasion. States the tier rule
 *  once (the client is arguing about a figure he should have straight) and
 *  frames the one-off cost by what it covers. Bank-backed
 *  (provision.persuade.1.rent). */
export const buildProvisionPersuasion = (): string =>
  'Провизијата е еднократна и покрива целата работа околу изнајмувањето: проверени недвижности што одговараат на Вашите критериуми, координација со сопственикот, правна проверка и подготовка на договорот. За недвижности под 1.000 евра изнесува 50% од една месечна кирија, а за недвижности од 1.000 евра и повеќе една целосна месечна кирија. Дали Ви одговара овој услов за да продолжиме?';

/** Commission resistance rung 2 — THE AGENCY RULE, never another pitch. Bank-
 *  backed (provision.rule.hold). */
export const buildProvisionRule = (): string =>
  'Ова е востановено правило на Агенцијата и важи за секој закупец без исклучок — висината на провизијата е дел од нашиот официјален ценовник, ист за сите, и не е моја лична одлука. Дали Ви одговара овој услов за да продолжиме?';

/** Commission resistance rung 3 — THE DECISION. Same protocol shape as the
 *  fee ladder's final rung (the owner's "…или не? Одлуката е Ваша."), with the
 *  question mid-line by design. Bank-backed (provision.decide). */
export const buildProvisionDecision = (): string =>
  'Да го решиме ова едноставно: дали да продолжиме по наведените услови или не? Одлуката е Ваша.';

/**
 * THE RENT-COMMISSION LADDER — one place, so the fast lane and the FSM leg can
 * never serve different rungs (the fee ladder's own reason for existing).
 *
 *   service !== 'rent' → the CLARIFICATION (0% for a buyer / both scripts when
 *   the market is undeclared); the caller must not count a rung for it — there
 *   is no commission to resist on the buy side.
 *   rejects 1  → ONE persuasion
 *   rejects 2  → the AGENCY RULE
 *   rejects 3+ → THE DECISION (a 4th resistance never reaches a rung: the
 *   caller moves the session to 'queued' and serves the graceful close).
 *
 * The `rung` field tells the caller which class it got, so the queue/close
 * decision and the analytics never have to re-derive it from the key string.
 */
export type ProvisionRung = 'clarify' | 'persuade' | 'rule' | 'decide';
export function provisionLadder(
  service: Service | undefined,
  rejects: number,
): { key: string; line: string; rung: ProvisionRung } {
  if (service !== 'rent') {
    return {
      key: service === 'buy' ? 'provision.ask.buy' : 'provision.ask.neither',
      line: buildProvisionAsk(service),
      rung: 'clarify',
    };
  }
  if (rejects >= 3) return { key: 'provision.decide', line: buildProvisionDecision(), rung: 'decide' };
  if (rejects === 2) return { key: 'provision.rule.hold', line: buildProvisionRule(), rung: 'rule' };
  return { key: 'provision.persuade.1.rent', line: buildProvisionPersuasion(), rung: 'persuade' };
}

/**
 * Answer to "why do you charge for a visit?" ("зошто наплаќате посета?",
 * "зошто надомест?", "никој не го прави тоа") — a QUESTION, not a refusal.
 * The fee is the agency's FILTER that recognizes REAL clients; for a serious
 * client it is symbolic; it enables quality and selective service for
 * genuinely interested clients. Bank-backed (fee.why) with this exact line as
 * the code-built fallback. Service-agnostic and amount-free on purpose: the
 * sum (500/300 денари) was already disclosed in the fee.ask — this line
 * explains the WHY and re-asks the agreement so the funnel keeps moving.
 */
export const buildFeeWhy = (): string =>
  'Надоместот за посета е филтер на агенцијата со кој ги препознаваме вистинските клиенти. За сериозен клиент тој е симболичен — вака функционира нашата агенција: симболична цена со која се овозможува квалитетна и селективна услуга за навистина заинтересираните клиенти. Дали се согласувате со овој услов за да продолжиме?';

/**
 * RETIRED from the live serve (kept with its bank pool because the wording was
 * owner-approved and the flow may return): the fee-resistance PIVOT used to
 * answer the 3rd refusal with other neighborhoods. It restarted the same fee
 * fight on a fresh property, so the ladder now answers rung 2 with the AGENCY
 * RULE and rung 3 with THE DECISION (see feeLadder). Bank-backed pool:
 * fee.pivot.neighborhood; the property cards + pick-closer followed it.
 * Declarative on purpose — no question mark, no fee mention, no concrete
 * properties here.
 */
export const buildFeePivotNeighborhood = (): string =>
  'Разбирам. Доколку сакате, можам да Ви понудам и други недвижности во други населби — еве што имам:';

// Persona brain. Written IN Macedonian so the model operates in its native
// register instead of translating from English — the source of calques, typos
// and foreign words ("используется", "преporачав", ...).
export const SYSTEM_PROMPT = `
---
**ИДЕНТИТЕТ**
---
*   **Име:** Лина
*   **Улога:** Продажен асистент во агенцијата за недвижности **Metropolis**.
*   **Тон:** Шармантен, самоуверен, интелигентен, пријатен, но професионален.
*   **Јазик:** ИСКЛУЧИВО македонски — оригинален, точен, без правописни грешки, без туѓи зборови и без машина-превод.
*   **Глас:** САМО прво лице — „Јас“. НИКОГАШ не се претставувај како „Лина“ или во трето лице.
*   **ФОРМАЛНО ОБРАЌАЊЕ („ВИЕ“):** Секогаш формално: „кажете ми“, „се согласувате“. Со голема буква: „Вие“, „Ваш“, „Ви“, „Ве“, „Вас“. НИКОГАШ неформално „ти“/„тебе“/„твој“.
*   **ЗАБРАНЕТ ПОЧЕТОК:** Никогаш не започнувај со „Почит“ или „Почитувани“. Започни со „Здраво!“ или „Добар ден!“.

---
**ПОЛИТИКИ НА АГЕНЦИЈАТА (МЕТРОПОЛИС) — СТРОГИ ПРАВИЛА**
---
**ЗА ИЗНАЈМУВАЊЕ:**
1.  **Провизија:** 50% од првата месечна кирија (ја плаќа кираџијата при потпишување на договорот).
2.  **Времетраење:** Минимум 1 година.
3.  **Надомест за разгледување:** 300 денари (5 евра) по посета.

**ЗА КУПУВАЊЕ:**
1.  **Провизија:** **0% за купувачот!** (Единствена предност!) Сопственикот плаќа целосна агенциска провизија од 2%.
2.  **Надомест за разгледување:** 500 денари (10 евра) по посета.
    *   **Логика на убедување:** Надоместот е задолжителен, но им заштедува илјадници евра. Во други агенции би платиле 1% провизија или би ја делеле провизијата. Тука плаќаат **0% провизија**, па 10 евра за разгледување е ситница во споредба со заштедата. Тоа е „паметна одлука“.

---
**ПРОТОКОЛ ЗА НАВРЕДЛИВО ОДНЕСУВАЊЕ (3 ОПОМЕНИ)**
---
Системот ги брои опомените автоматски. Кога системот ќе ти каже да предупредиш, користи:
1. „Господине, да останеме професионални, ве молам.“
2. „Господине, ова е последна опомена. Доколку продолжите со ваков речник, ќе морам да го прекинам разговорот.“
Никогаш не пишувај ништо на 3. опомена — системот ја прекинува комуникацијата во тишина.

---
**ПРОДАЖНА ЛЕВИЦА (ја спроведува системот; следи ја ЗАДАЧАТА ЗА ТЕКОВНАТА СОСТОЈБА)**
---
*   **ФАЗА 1 — НАМЕРА:** Купување или изнајмување. Никогаш не прикажувај недвижност пред да ја знаеш намерата.
*   **ФАЗА 2 — РАЗЈАСНУВАЊЕ:** Локација, број на спални соби, буџет. Не прикажувај недвижност додека немаш барем груба претстава за сите три.
*   **ФАЗА 3 — ПРЕЗЕНТАЦИЈА (СТРОГА ЛОГИКА ЗА ЛОКАЦИЈА):**
    *   Сценарио А (2+ совпаѓања во бараната локација): претстави ги најдобрите ДВА.
    *   Сценарио Б (точно 1 совпаѓање): претстави само тој еден.
    *   Сценарио В (0 совпаѓања): кажи точно: „За жал, моментално немам слободни недвижности во [Локација] што одговараат на Вашите критериуми.“ Само ТОГАШ смееш да предложиш алтернатива или да прашаш дали се отворени за други локации.
    *   НИКОГАШ не прикажувај недвижност од друга населба, освен ако најпрвин не е искажано Сценарио В.
    *   **ЗАБРАНА:** Во оваа фаза НИКОГАШ не го спомнувај надоместот за разгледување.
    *   Заврши со прашање дали им се допаѓа некој од предлозите и дали сакаат да организираш посета — **МЕНУВАЈ го прашањето секој пат** (не го повторувај истото прашање како во претходната порака).
*   **ФАЗА 4 — ЗАТВОРАЊЕ (НАДОМЕСТ ЗА РАЗГЛЕДУВАЊЕ — само по изразен интерес):**
    *   ИЗНАЈМУВАЊЕ: „Мило ми е. Пред да го повикам сопственикот, мора да Ве известам за политиката на Метрополис. Разгледувањето на недвижност чини симболични 300 денари (5 евра). Дали се согласувате со овие услови за да можеме да продолжиме?“
    *   КУПУВАЊЕ: „Одличен избор. Бидејќи станува збор за купување, имам одлична вест и еден мал услов за Вас. Кај нас во Metropolis, **Вие како купувач НЕ плаќате агенциска провизија** (0%), за разлика од други места каде би платиле илјадници евра провизија. Единствениот трошок за Вас е симболични 500 денари (10 евра) за организирање на посетата до недвижноста. Дали се согласувате со овој услов за да можеме да продолжиме?“
*   **ФАЗА 5 — КОНТАКТ:** По согласување со надоместот, побарај вистинско име и презиме и телефонски број. НИКОГАШ не претпоставувај име.
*   **ФАЗА 6 — ЗАКАЖУВАЊЕ ПОСЕТА:** По име и телефон, прашај: „Кој термин би Ви одговарал за посета? Да се обидам да договорам со сопственикот во тоа време.“ Потоа системот проверува со сопственикот. НИКОГАШ не потврдувај посета и не измислувај достапност на сопственикот — само резултатот од проверката на системот е вистина.
*   **ФАЗА 7 — ЗАТВОРАЊЕ:** Потврди и кажи дека ќе го контактираш сопственикот за достапност.

---
**ПРАВИЛА НА ОДНЕСУВАЊЕ**
---
1.  САМО прво лице, формално „Вие“ насекаде.
2.  **ЈАЗИЧНА ПРАВИЛНОСТ:** Пишувај на точен, оригинален македонски јазик — без правописни грешки, без калки, без туѓи зборови (не руски, не српски, не бугарски, не англиски) и без мешање на кирилица и латиница во ист збор. Размислувај и пишувај ДИРЕКТНО на македонски — не преведувај од друг јазик. Користи исконски македонски термини: „проверка“, „достапен“, „закажување“, „разгледување“ — не „чек“, „авејлабл“, „букинг“, „виево“.
3.  ВРЕМЕНСКИ ТАЈМИНГ: никогаш не го спомнувај надоместот пред клиентот да изрази интерес за посета.
4.  ИНТЕГРИТЕТ НА ЛОКАЦИЈА: почитувај ја бараната населба.
5.  ТЕРМИНОЛОГИЈА: секогаш „**Евидентен број**“, НИКОГАШ „ID“ или „ИД“.
6.  НИКОГАШ НЕ ИСФРЛАЈ ПОДАТОЦИ: не наведувај повеќе од 2 недвижности.
7.  ПРИЛАГОДЛИВОСТ: ако клиентот одбие опции, прашај *зошто* пред да покажеш нови.
8.  УБЕДУВАЊЕ: секогаш нагласувај ја вредноста.
9.  БЕЗ РОБОТСКИ ЛИСТИ: зборувај во целосни, течни македонски реченици.
10. ТЕРМИНОЛОГИЈА ЗА СПАЛНИ: прашувај само „Колку спални соби би сакале да има станот?“ без објаснувања во загради. При презентација можеш да кажеш „двособен стан (со една спална соба)“.
11. **ЦЕНИТЕ НА ИМОТИТЕ СЕ ИСКЛУЧИВО ВО ЕВРА (евра/€).** НИКОГАШ не наведувај цена на недвижност во денари. (Надоместот за разгледување е единственото нешто во денари: 300/500 денари.)
11. **НИКОГАШ не испуштај JSON, системски команди или текст помеѓу специјални маркери. Само обичен македонски разговорен текст.**
12. **НИКОГАШ не потврдувај посета или не спомнувај име/телефон на сопственик. Достапноста е работа на системот — ти само пренесуваш.**
13. **НИКОГАШ не започнувај порака со „Супер. Уште неколку прашања.“ или „Одлично, уште последниве информации и завршуваме.“ — системот ги користи самиот, на точно едно место во разговорот. Ти прашањата поставувај ги директно, без такви воведи.**
14. **ТАЈНОСТ НА АДРЕСАТА:** НИКОГАШ не ја кажувај точната улица и број на недвижноста („улица X“, „на адреса X“). Локацијата се опишува САМО приближно — преку блиската јавна знаменитост наведена во податоците („во близина на …“) или преку населбата („во Карпош“). Точната локација ја открива САМО системот, 2 часа пред договорената посета — не и ти.
15. **ПРЕРАСКАЖИ ГО ОГЛАСОТ, НЕ ЦИТИРАЈ ГО:** Полето „details“ во податоците е оглас од сајтот за недвижности („Се Продава…“, „Агенција за Недвижности МЕТРОПОЛИС Продава…“, „Ексклузивно Преку…“, „Без Провизија за Купецот“) — НИКОГАШ не го препишувај збор-во-збор, тоа звучи копирано. Прераскажувај ги само фактите (состојба, кат, паркинг, тераса, реновирање, парно) во природни, разговорни реченици, како што секретарка би го опишала недвижноста. Без маркетинг фрази и без улица/адреса.
16. **ОКОЛИНАТА НА ИМОТОТ („НА КОЈА СТРАНА?“):** Кога клиентот прашува што има околу недвижноста, на која страна е или го споредува со места што ги гледа („od stranata na trgovskiot ili odkaj pazarceto“), одговарај САМО од полето „nearby“ во податоците — тоа се вистинските јавни места до таа недвижност, со вистинската оддалеченост во метри. Најблиското НАВЕДЕНО место од нив Е страната за која прашува клиентот; другите спомни ги како подалечни. НИКОГАШ не измислувај место што го нема во податоците, не тврди страна што не произлегува од нив, и не кажувај улица. Ако клиентот именува место што не е во „nearby“, кажи дека не можеш да ја потврдиш страната и понуди посета за да го види на лице место.
17. **ОДГОВОРИ САМО НА ПРАШАЊЕТО — БЕЗ ПОНУДИ НАКРАЈ:** Ако клиентот праша за правило, цена, процедура, политика или изрази незадоволство („GLUPOSTI“, „зошто?“, „не ми се допаѓа“) — одговори САМО на тоа, со 1–3 реченици. ЗАБРАНЕТО е на крајот од таков одговор да додаваш понуди или презентација: никакво „Со цел да Ви помогнам… еве ги следните опции…“, никакво „Во меѓувреме, ги издвоив…“, никаков Евидентен број, листа или карта. Недвижности се прикажуваат САМО кога тековната задача тоа го бара (презентација/пребарување). Еден одговор = една тема.
`;

export function serviceLabel(s?: Service): string {
  return s === 'buy' ? 'Купување' : s === 'rent' ? 'Изнајмување' : 'непознато';
}

export function stateTask(state: State, slots: SlotData): string {
  switch (state) {
    case 'idle':
    case 'intent':
      // THE TYPE IS NOT KNOWN YET, so the service question must not presume
      // one (the [21:20] capture: «STO IMATE OKOLU KAPITOL MOL?» answered
      // «Дали барате СТАН за купување или за изнајмување?»). Ask the SERVICE on
      // «недвижност»; the category question comes only after it is known.
      return 'The client has not declared intent yet AND the property TYPE is unknown. Ask politely whether they are interested in BUYING (купување) or RENTING (изнајмување) on "недвижност" — NEVER name стан, куќа, локал, плац or гарсоњера, and never imply which one he wants. Do not show any properties.';
    case 'discovery': {
      const known = [
        slots.service ? `услуга: ${serviceLabel(slots.service)}` : null,
        slots.location ? `локација: ${slots.location}` : null,
        slots.business ? `деловен простор (size matters, NOT bedrooms)` : null,
        slots.sqm ? `површина: ${slots.sqm} м²` : null,
        slots.bedrooms ? `спални: ${slots.bedrooms}` : null,
        slots.budget ? `буџет: ${slots.budget}` : null,
      ].filter(Boolean).join(', ');
      return slots.business
        ? `The client wants a COMMERCIAL space (деловен простор) — NEVER ask about bedrooms. Ask ONLY for the missing details: location (кој дел од градот), square meters (колку м²), budget (до која цена). Do not show properties yet. Known so far: ${known || 'none'}.`
        : `The client's intent is known. Ask ONLY for the missing details: location (кој дел од градот), number of bedrooms (колку спални), budget (до која цена). Do not show properties yet. Known so far: ${known || 'none'}.`;
    }
    case 'property_locate':
      return `The client SAW a specific property (an ad, on the internet) but does NOT know its Евидентен број. If the provided RELEVANT PROPERTY DATA is non-empty, these are the CLOSEST database matches — present them briefly and ask whether one of them is the property they saw (say "првиот"/"вториот" or the Евидентен број). If the data is empty ([]), ask for identifying details — населба (which neighborhood), квадрати (size in м²), цена (price) — and do NOT invent any property. Do NOT mention viewing fees. NEVER include a link.`;
    case 'property_query':
      return `The client asked about a SPECIFIC property: Евидентен број ${slots.propertyId ?? '?'}. Describe ONLY that property from the provided data (layout, size, price, location, address, features, description). PRICE MUST BE QUOTED IN EUROS (евра/€) — the price_eur field is already in euros; NEVER say a property price in денари. STRICT: if the RELEVANT PROPERTY DATA is empty ([]), do NOT invent any details — say you could not find that property in the current offer and offer to suggest similar ones. Do NOT mention any viewing fee in this step. NEVER include a link, "Повеќе информации" or a web address — the client reads everything IN THE CHAT, described with words from the provided data. If a field is null in the data, OMIT it entirely — never write "непозната локација" or "непознат" (only mention what the data really contains). If the client asks whether the property is available ("дали е достапен?") or when they could view it ("кога може да се погледне?"), treat it as visit interest: ask if they would like to schedule a visit — NEVER offer to contact the owner or ask for their phone yet (the system discloses the viewing fee first, then contacts the owner after they agree). End by asking if they would like to visit it (only if the property was found) — VARY the phrasing of that question, never repeat the same sentence twice in a row.`;
    case 'presentation': {
      const size = slots.business ? `${slots.sqm ?? '?'} м²`
        : (slots.plac || slots.yard) ? 'size per listing (a land plot / yard need has no спални spec)'
        : `${slots.bedrooms ?? '?'} спални`;
      const what = slots.business ? 'COMMERCIAL space (деловен простор)'
        : slots.plac ? 'LAND PLOT (плац)'
        : slots.house ? 'HOUSE (куќа)' : 'apartment';
      const locDesc = slots.anywhere
        ? 'ANYWHERE in Skopje (the client said "било каде" — no location preference; the offers are already ordered from the most popular neighborhoods: Центар, Капиштец, Карпош, Аеродром, Кисела Вода, Влае, Ѓорче Петров, then the rest)'
        : `"${slots.location ?? '?'}"`;
      return `The client wants to ${serviceLabel(slots.service)} a ${what} in ${locDesc} with ${size}, budget ${slots.budget ?? '?'}. Present the properties from the provided data (MAX 2). STRICT: never invent properties or details that are not in the provided data. PRICES MUST BE QUOTED IN EUROS (евра/€) — the price_eur field is already in euros; NEVER say a property price in денари. These are the NEXT available options — if the client rejected earlier offers, briefly acknowledge and present these as the closest alternatives. If none of the provided properties is in the requested location, say there is nothing available exactly in ${slots.location ?? '?'} right now and present these as the closest options from nearby areas. NEVER claim there are no other properties anywhere — only the provided data exists.${slots.yard ? ' The client specifically needs a yard (двор/градина) — name the yard for each offer when the data mentions one; when no offer has a yard, say so honestly.' : ''} Do NOT mention viewing fees. Use "Евидентен број N". Describe each property IN WORDS using ONLY the provided data: location, address, size, bedrooms, features and description (details). NEVER include a link, "Повеќе информации" or a web address — the client reads everything IN THE CHAT, described with words from the database. If a field is null in the data, OMIT it entirely — never write "непозната локација" or "непознат" (only mention what the data really contains). If the client asks whether a property is available or when they could view it, treat it as visit interest — NEVER offer to contact the owner or ask for their phone yet (the fee is disclosed first, the owner is contacted only after they agree). End with a natural closing question asking whether they like any of the offers and would like a visit scheduled — VARY the phrasing every time (e.g. "Дали Ви се допаѓа некој од овие предлози и дали би сакале да организираме посета на недвижноста?" / "Дали некој од овие станови Ви одговара? Ако да, можам веднаш да организирам посета." / "Кој од овие предлози најмногу Ви одговара?"). NEVER repeat the exact same closing sentence as your previous reply.`;
    }
    case 'closing': {
      const eb = slots.interestedPropertyId ?? slots.propertyId;
      const rejects = slots.feeRejections ?? 0;
      if (rejects === 0) {
        return `The client wants to visit EB ${eb ?? '?'} (${serviceLabel(slots.service)}). Disclose the viewing fee using the official script: ${slots.service === 'rent' ? `RENT → ${RENT_FEE_MKD} (5 EUR)` : `BUY → ${BUY_FEE_MKD} (10 EUR) with the 0% commission persuasion`}. Ask if they agree. Do NOT ask for their name or phone yet.`;
      }
      if (rejects === 1) {
        return `The client REFUSED the viewing fee once. Do NOT repeat the disclosure. Persuade with value using the persuasion script (0% commission benefit for buy / symbolic 5 EUR for rent). Stay warm, stay in closing. Do NOT ask for name or phone.`;
      }
      return `The client REFUSED the fee TWICE. STOP selling. Ask gently what concerns them about the fee and offer to find a solution together ("што Ве загрижува?"). Do NOT repeat scripts. If they refuse a third time, the system handles the graceful close.`;
    }
    case 'contact_collection':
      return slots.phone
        ? 'The client agreed to the viewing fee. Lina already knows their phone (the Viber number they write from — stored in slots.phone). Ask ONLY for their full name (име и презиме). NEVER assume their name. Do not confirm the appointment yet.'
        : 'The client agreed to the viewing fee. Ask for their full name (име и презиме) and phone number. NEVER assume their name. Do not confirm the appointment yet.';
    case 'visit_scheduling':
      return `The client agreed to the fee and gave name+phone. Ask exactly, in full fluid Macedonian: "Кој термин би Ви одговарал за посета? Да се обидам да договорам со сопственикот во тоа време." Wait for their preferred time. Do NOT confirm, do NOT mention the owner, do NOT ask anything else.`;
    case 'owner_checking': {
      const eb = slots.interestedPropertyId ?? slots.propertyId;
      return `An owner check is in progress for EB ${eb ?? '?'} at ${slots.visitTime ?? 'the proposed time'}. If the client writes, stay patient and brief: "${PATIENCE_LINE}" Do NOT promise the visit and do NOT invent availability.`;
    }
    case 'time_confirm': {
      // The relay prompt carries the term the client is asked to accept — it
      // must name its DAY even when the slot was stored before the day-merge
      // existed (the day audit over the captured sessions): the anchor is the
      // term the owner is answering / the client's own proposal.
      const ownerTime = mergeOwnerTerm(slots.ownerTime ?? '', [slots.ownerAskTime, slots.visitTime])
        || 'предложениот термин';
      return `The owner is available at a different time: "${ownerTime}". Relay this to the client and ask if it works: "Дали овој термин Ви одговара?" Do NOT renegotiate yourself — just relay and ask.`;
    }
    case 'pending':
      return 'Acknowledge the provided contact details and give the closing phrase: "Во ред, ќе ве информирам за терминот и деталите околу посетата, штом ќе го контактирам сопственикот и прашам за моментална достапност и можен термин за посета."';
    case 'queued':
      return 'The client refused the viewing fee three times. Close gracefully and warmly: thank them, note their criteria, promise to contact them when a matching property appears. NO more selling, NO fee mention.';
    case 'escalated':
      return 'A manager will contact the client shortly. Keep the message brief, polite and professional.';
    case 'terminated':
      return 'DO NOT OUTPUT ANYTHING.';
    default:
      return 'Continue the conversation professionally in Macedonian, formal Вие form.';
  }
}

export const FALLBACKS: Record<string, string> = {
  idle: "Здраво! Јас сум Лина. За почеток, кажете ми дали сте заинтересирани за купување на недвижност или за изнајмување?",
  intent: "Здраво! Јас сум Лина. За почеток, кажете ми дали сте заинтересирани за купување на недвижност или за изнајмување?",
  discovery: "Одлично. За да го најдеме совршениот дом, кажете ми - кој дел од градот го преферирате, колку спални соби би сакале да има станот и до која цена планирате да одите?",
  property_locate: LOCATE_FIRST_ASK,
  property_query: "Се разбира, ќе Ви ги објаснам деталите за таа недвижност. Моментално ја проверувам понудата и веднаш Ви се враќам со точните информации.",
  presentation: "Ви подготвив неколку предлози кои одговараат на Вашите критериуми. Дали би сакале да организираме посета на некој од нив?",
  closing: "Мило ми е што Ве интересира недвижноста. Пред да го повикам сопственикот, сакам да Ви ги појаснам условите за посетата.",
  contact_collection: "За да можам веднаш да стапам во контакт со сопственикот, ве молам да ми го кажете Вашето име и презиме, како и телефонски број за контакт.",
  visit_scheduling: VISIT_TIME_QUESTION,
  owner_checking: PATIENCE_LINE,
  time_confirm: "Сопственикот е достапен во друг термин. Дали овој термин Ви одговара?",
  queued: FEE_GRACEFUL_CLOSE,
  pending: "Во ред, ќе ве информирам за терминот и деталите околу посетата, штом ќе го контактирам сопственикот и прашам за моментална достапност и можен термин за посета.",
  escalated: "Разбирам. Ова е специфично прашање, па затоа ќе Ве поврзам директно со мојот претпоставен за да ги добиете најточните информации. Тие ќе Ве контактираат набрзо.",
  default: "Ве молам, можете ли да ми го појасните Вашето барање?",
};

// --- New scenario code-built fallbacks (bank-backed via pickVariant) ----------
// Off-topic redirect: redirect the client back to real estate.
export const OFFTOPIC_REDIRECT =
  'Концентрирана сум на помош околу недвижности. Кажете ми, барате купување или изнајмување?';

// Follow-up defer: graceful acknowledgment when the client isn't ready.
export const FOLLOWUP_DEFER =
  'Разбирам. Ќе Ве контактирам кога ќе се ослободи недвижноста. Дали сакате да Ве евидентирам за критериумите што ги барате?';

// Price negotiation: relay to owner (owner is source of truth).
export const PRICE_NEGOTIATE =
  'Цената ја одредува сопственикот. Дали сакате да го контактирам за да го пренесам Вашето прашање за цената?';

// Provision / commission: clarify the 0% commission + viewing fee.
export const PROVISION_ANSWER =
  'Агенцијата не наплаќа провизија за купувачот (0%). Единствен трошок за Вас е симболичниот надомест за посета — 500 денари за купување, 300 денари за изнајмување.';

// Service-AGNOSTIC provision serve (the [09:0x] V16K11 bug): the old
// resolution ternary read slots.service === undefined as "buy" and served a
// rent searcher the 500 ден/0% провизија rules-of-work script. A market
// question without a declared market names BOTH scripts, both fees —
// correct by construction (see buildFeeAsk for the same pattern).
export const PROVISION_ASK_NEITHER =
  'Условите зависат дали барате купување или изнајмување. Кај нас купувачот НЕ плаќа провизија (0%) — единствен трошок е симболичниот надомест за посета од 500 денари (10 евра). За изнајмување, надоместот за посета е 300 денари (5 евра), а провизијата е 50% од месечната кирија. Дали Ве интересира купување или изнајмување?';

// Scheduling flexibility: acknowledge the preferred window.
export const SCHED_FLEX_ANSWER =
  'Разбирам. Ќе проверам дали посетите се возможни во тој термин. Може ли да ми кажете конкретен ден и час кога Ви одговара?';

// Escalation polite: acknowledge and escalate.
export const ESCALATION_ANSWER =
  'Разбирам. Ќе Ве поврзам со менаџерот кој ќе Ви помогне со Вашето прашање. Тој ќе Ве контактира набрзо.';

// Documents info: general document requirements.
export const DOCUMENTS_ANSWER =
  'За купување на недвижност Ви требаат: лична карта или пасош, преддоговор, потврда од банка за кредит (доколку купувате со кредит) и уплата на резервација. За изнајмување: лична карта и потврда за редовни примања.';

// Mortgage / credit: redirect to bank.
export const MORTGAGE_ANSWER =
  'За купување со кредит Ви препорачувам да се консултирате со Вашата банка за условите и одобрувањето. Ние Ви ги обезбедуваме сите потребни документи за недвижноста.';

// Neighborhood general: keep it neutral and redirect to criteria.
export const NEIGHBORHOOD_ANSWER =
  'Сите населби имат свои предности. За да Ви препорачам соодветна локација, кажете ми — што Ви е поважно: близина до центарот, тивко опкружување или пристапна цена?';

// Comparison help: ask what matters most.
export const COMPARISON_ANSWER =
  'Да ги споредиме? Кажете ми што Ви е поважно — локација, цена, големина или некој друг критериум, па ќе Ви помогнам да изберете.';

// Feature question after a property was shown.
export const FEATURE_ANSWER =
  'Одговорот на тоа прашање ќе го проверам кај сопственикот заедно со останатите информации за недвижноста. Може ли да ми кажете кои карактеристики Ви се најважни?';

/** Macedonian type name for a property (гарсоњера when the size says so). */
function propertyType(p: Property): string {
  const b = p.bedrooms;
  if (b === 1) return 'еднособен стан';
  if (b === 2) return 'двособен стан';
  if (b === 3) return 'трисобен стан';
  if (b && b >= 4) return 'четирисобен стан';
  const sizeN = Number((p.size ?? '').match(/\d+/)?.[0]);
  if (Number.isFinite(sizeN) && sizeN < 35) return 'гарсоњера';
  return 'стан';
}

/** Property type labels for owner messages (indefinite + definite article + gender).
 *  Every gendered slot travels together: a ЖЕНСКИ noun (куќа, гарсоњера) takes
 *  Вашата / која / внесена / достапна — the [20:14] owner ping said "за Вашиот
 *  куќа … кој … е внесен". */
export function ownerPropertyLabels(p: Property): {
  type: string; def: string; possessive: string; dostapen: string; relative: string; entered: string;
} {
  if (p.plac) return { type: 'плац', def: 'плацот', possessive: 'Вашиот', dostapen: 'достапен', relative: 'кој', entered: 'внесен' };
  if (p.house) return { type: 'куќа', def: 'куќата', possessive: 'Вашата', dostapen: 'достапна', relative: 'која', entered: 'внесена' };
  if (p.business) return { type: 'деловен простор', def: 'деловниот простор', possessive: 'Вашиот', dostapen: 'достапен', relative: 'кој', entered: 'внесен' };
  // (the feed's plac flag owns the category now — see isPlac in properties.ts)
  // Default: стан (apartment) with specific type
  const label = propertyType(p);
  if (label.includes('гарсоњер')) return { type: label, def: 'гарсоњерата', possessive: 'Вашата', dostapen: 'достапна', relative: 'која', entered: 'внесена' };
  return { type: label, def: 'станот', possessive: 'Вашиот', dostapen: 'достапен', relative: 'кој', entered: 'внесен' };
}

/** Macedonian list join: "а, б и в" (no Oxford comma). */
function joinMk(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}`;
}

// --- Conversational rewrite of the ad text (opis) ----------------------------
// The feed's description is written for a LISTINGS PAGE ("Агенција за
// Недвижности МЕТРОПОЛИС Продава…", "Се Продава…", "Ексклузивно Преку
// МЕТРОПОЛИС", "Без Провизија за Купецот") — quoting it in a chat sounds
// copied, not like a human secretary. This keeps only the FACTS (state, floor,
// parking, terrace, renovation) and rephrases them conversationally. The exact
// street is stripped (address secrecy — a client who knows it bypasses the
// agency), and the sell/agency boilerplate never survives.

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// \b is ASCII-only in JS — it never binds around Cyrillic. Use explicit
// Unicode-aware word boundaries ("во", "Поседува", "МЕТРОПОЛИС"…).
const CYR = 'А-Яа-яA-Za-z0-9';
const NOT_PREV = `(?<![${CYR}])`;
const NOT_NEXT = `(?![${CYR}])`;

// Whole-sentence ad copy that never survives into the chat.
const AD_COPY_RE: RegExp[] = [
  /агенц(иј|иj)а.*?(?:продава|издава|нуди|метрополис)/i,  // "Агенција МЕТРОПОЛИС Продава…"
  /(?:ексклузивно|единствено)\s+(?:преку|кај)/i,          // "Ексклузивно Преку МЕТРОПОЛИС" / "Единствено преку МЕТРОПОЛИС"
  /без\s+провизи(ј|j)а/i,
  /пристапн(а|о)\s+опци(ј|j)а/i,
  /урбано\s+(?:живеење|домување)/i,                       // "Пристапна Опција за Урбано Живеење/Домување"
  /спремн(а|о|ен)\s+за\s+компактно\s+домување/i,
  /никогаш\s+вселен/i,
  /(?:идеалн(а|о)|совршен(а|о)?)\s+за/i,
  /(?:одличн(а|о)|добра|одлична)\s+инвестиц(иј|иj)а/i,
  /повикајте|јавете\s+се|контактирајте\s+не/i,
  /ретка\s+можност\s+за\s+парче\s+југославиј/i,           // EB 78 "Ретка Можност за парче Југославија"
  /му\s+треба\s+малку\s+љубов/i,                          // EB 78 "Му треба Малку Љубов…"
  new RegExp(`^\\s*метрополис\\s*$`, 'i'),
];

// The "for sale/rent" opener is implied by the funnel — never stated in chat.
// Strips the phrase, keeping the FACTS that follow it ("Се продава нов стан на
// прв спрат…" -> "на прв спрат…"; "Се продава стан од 100м2 + подрум" ->
// "подрум…"). A bare "Се продава." sentence empties and is skipped.
const SELL_OPEN_RE = /^(?:се\s+)?(?:продавам|продава|издавам|издава|изнајмувам|нудам)\s*(?:нов(?:а|о|и)?\s+)?(?:стан|куќа|локал|деловен\s+простор|гарсоњера)?\s*(?:од\s+\d{2,4}\s*(?:м2|м²|m2|m²|квадрат(?:и)?|kvadrat(?:i)?)\s*)?/i;

// The exact street — stripped wherever it appears (address secrecy).
const STREET_RE = new RegExp(
  `${NOT_PREV}(?:на\\s+)?(?:улица|ул\\.?|булевар|бул\\.?)\\s+["'„]?[А-ЯA-Z][А-Яа-яA-Za-z0-9.'\\-–\\s]{1,40}?(?=[,.;–-]|$)`, 'gi');

// Title-case ad phrases -> chat register.
const PHRASE_LOWER: Array<[RegExp, string]> = [
  [/Топ\s+Состојба/gi, 'одлична состојба'],
  [new RegExp(`${NOT_PREV}Поседува${NOT_NEXT}`, 'gi'), 'Има'],
  [new RegExp(`Станче${NOT_NEXT}`, 'gi'), 'Станот'],
  [/Две\s+Спални\s+Соби/gi, 'две спални соби'],
  [/Посебна\s+Спална\s+Соба/gi, 'посебна спална соба'],
  [/Дневна\s+Кујна(?:\s+Трпезарија)?/gi, 'дневна кујна-трпезарија'],
  [/(?:Одличен|Отворен)\s+Поглед/gi, 'одличен поглед'],
  [/Достапно\s+Подземно\s+Паркинг\s+Место/gi, 'подземно паркинг место'],
  [/Комплетно\s+Реновиран/gi, 'комплетно реновиран'],
  [/Комплетно\s+Наместен/gi, 'комплетно наместен'],
  [/Градско\s+Парно/gi, 'градско парно'],
  [/Воен\s+Квалитет/gi, 'воен квалитет'],
  [/Цист\s+Имотен\s+Лист/gi, 'чист имотен лист'],
  [/Одличен\s+Распоред/gi, 'одличен распоред'],
  [/опкружен\s+со\s+Зеленило\s+и\s+Сите\s+Потреби\s+За\s+Модерно\s+Живеење/gi, 'опкружен со зеленило'],
  [/со\s+квалитет\s+за\s+кој\s+новите\s+градби\s+може\s+да\s+сонуваат/gi, ''],  // EB 78 ad-fluff
  [/Состојба\s+Одлична/gi, 'состојбата е одлична'],
  [/Одлична\s+Локаци(ј|j)а/gi, 'одлична локаци$1а'],
  [/Одлична\s+Состојба/gi, 'одлична состојба'],
  [/Во\s+Близина\s+на/gi, 'во близина на'],
  [/Се\s+Наоѓа/gi, 'се наоѓа'],
  [/Рамна\s+Плоча\s+без\s+Косини/gi, 'рамна плоча без косини'],
  [/^Со\s+Тераса/gi, 'Има тераса'],
  [/^Во\s+Сутерен\s+на\s+Зграда/gi, 'Сместена во сутерен на зграда'],
  [/Прв\s+Кат\s+со\s+Лифт/gi, 'на прв кат со лифт'],
  [/^Градско\s+Парно/gi, 'Има градско парно'],
  [/^Стар\s+стан/gi, 'Станот е стар'],
  [/^Со\s+можност/gi, 'Има можност'],
  [/^За\s+Комплетно\s+Реновирање/gi, 'Потребно е комплетно реновирање'],
  [/на\s+Приземје/gi, 'на приземје'],
  [/Доплата\s+од/gi, 'доплата од'],
  [/градба\s+(\d{4})/gi, 'зграда од $1 година'],
];

/** Mostly-uppercase check — ALL-CAPS ad sentences are lowered to chat register. */
function isShouty(s: string): boolean {
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters.length < 5) return false;
  const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
  return upper / letters.length >= 0.5;
}

/** THE AD'S CATEGORY NOUN, ALIGNED WITH THE ROW (the [20:40] capture).
 *
 *  EB 50 is a HOUSE, and its card opened «Куќата под Евидентен број 50 е во
 *  Центар…» — then quoted the ad's own words: «… стан во вид на двоспратна
 *  галерија …». One message called the same property a house and a flat, and the
 *  client has to reconcile it before he can trust anything else on the card.
 *
 *  The ad writer's category word is replaced by the ROW's category, so both
 *  halves of the card agree. Word-bounded, so the legitimate «станбена
 *  површина» keeps its own word, and «стана» (the verb) is deliberately not in
 *  the list — only the noun forms. 
 */
function alignCategoryNoun(sentence: string, p: Property): string {
  const [one, def, many, manyDef] = p.plac
    ? ['плац', 'плацот', 'плацеви', 'плацевите']
    : p.business
      ? ['деловен простор', 'деловниот простор', 'деловни простори', 'деловните простори']
      : ['куќа', 'куќата', 'куќи', 'куќите'];
  const B = '(?<![\\p{L}\\p{N}])';
  const A = '(?![\\p{L}\\p{N}])';
  return sentence
    .replace(new RegExp(B + 'станот' + A, 'giu'), def)
    .replace(new RegExp(B + 'становите' + A, 'giu'), manyDef)
    .replace(new RegExp(B + 'станови' + A, 'giu'), many)
    .replace(new RegExp(B + 'стан' + A, 'giu'), one);
}

/**
 * The ad text rewritten as conversational facts — never a copy-paste. Returns
 * undefined when nothing usable survives (the card then omits the line).
 */
export function conversationalDetails(p: Property): string | undefined {
  const raw = (p.details ?? '').trim();
  if (!raw) return undefined;
  let t = raw.replace(/\s+/g, ' ')
    // List items in the ad are dash-separated ("-Улица X -Дневна и две спални")
    // — turn them into sentences so each clause is processed on its own.
    // ("на ниво -1" and "86 - 1" are safe: a digit follows the dash.)
    .replace(/\s+[-–]\s*(?=[А-ЯA-Z])/g, '. ')
    // The exact street NEVER survives (address secrecy — bypass risk).
    .replace(STREET_RE, ' ');
  const out: string[] = [];
  for (let sent of t.split(/[.!?]+/)) {
    sent = sent.replace(/^[-–•*\s]+/, '').trim();
    if (!sent) continue;
    if (AD_COPY_RE.some(re => re.test(sent))) continue;
    // A dangling "Цена." fragment from the ad author — nothing after it.
    if (/^цена(?:та|та е)?[.!]?$/i.test(sent)) continue;
    // The sell opener is implied — keep only the facts after it. Also strips a
    // mid-sentence "се продава/се издава" ("Скопјанка Аеродром се продава стан
    // 3 собен…", "Помеѓу Универзална сала и Треска, се издава стан…") — but
    // NEVER "се продаваат" ("реон во кој ретко се продаваат станови" is a
    // legit fact — the letter boundary blocks it).
    sent = sent.replace(SELL_OPEN_RE, '')
      .replace(/(?<![А-Яа-яA-Za-z])се\s+(?:продава|издава)(?![А-Яа-яA-Za-z])/gi, ' ')
      .trim();
    // The neighborhood is already in the card's opening sentence.
    if (p.location) {
      // NOTE: template literals eat single-backslash escapes (\\s -> s, \\( -> (),
      // \b -> b) — the regexes are built with plain strings for that reason.
      const locRe = new RegExp(NOT_PREV + 'во\\s+' + escRe(p.location) + '(\\([^)]*\\))?' + NOT_NEXT, 'gi');
      sent = sent.replace(locRe, ' ').trim();
    }
    // When a resolved landmark exists, strip vague proximity phrases from the
    // ad text ("во близина на главниот влез") — the resolved landmark line
    // ("Се наоѓа во близина на Клинички Центар") already answers "каде е?".
    if (p.landmark) {
      sent = sent.replace(/(?:во\s+близина\s+на|близу\s+до|блиску\s+до)\s+[^,.!?]{2,50}/gi, ' ').trim();
    }
    // The size is already its own line in the card ("Има 56 м²…"). Only the
    // token whose number EQUALS the DB size is dropped — "58м2 + 12м2 балкони"
    // keeps the balcony sizes (they are extra facts, not the repeat).
    const sizeN = Number((p.size ?? '').match(/\d+/)?.[0]);
    if (Number.isFinite(sizeN) && sizeN > 0) {
      sent = sent
        // "(56 М2)" — parenthesized repeat, consumed whole (incl. closing paren).
        .replace(/\s*\(\s*(\d{2,4})\s*(?:м2|м²|m2|m²)\s*\)/gi, (m, n) => Number(n) === sizeN ? ' ' : m)
        // "од 45м2" / "24м2 со Тераса" — bound by letters so "од 45м2" is eaten
        // whole, and "58м2 + 12м2 балкони" (extra facts) survives.
        .replace(new RegExp(`${NOT_PREV}(?:од\\s+)?(\\d{2,4})\\s*(?:м2|м²|m2|m²|квадрат(?:и)?|kvadrat(?:i)?)${NOT_NEXT}`, 'gi'),
          (m, n) => Number(n) === sizeN ? ' ' : m)
        .trim();
    }
    if (!sent) continue;
    // ALL-CAPS ad sentences -> normal chat register.
    if (isShouty(sent)) sent = sent.toLowerCase();
    for (const [re, rep] of PHRASE_LOWER) sent = sent.replace(re, rep);
    sent = sent.replace(/\s+/g, ' ').replace(/\s+,/g, ',').replace(/,(?=\S)/g, ', ').replace(/,\s*$/g, '').trim().replace(/^[-–•*+\s]+/, '');
    if (!sent) continue;
    // A house/plot/office ad that calls itself a «стан» must not reach the card
    // of the house/plot/office it describes (see alignCategoryNoun).
    if (p.plac || p.house || p.business) sent = alignCategoryNoun(sent, p);
    out.push(sent.charAt(0).toUpperCase() + sent.slice(1));
  }
  return out.length > 0 ? out.join('. ') + '.' : undefined;
}

/**
 * Code-built property card — used when the LLM is unavailable (fallback).
 * Written as natural Macedonian sentences (not a spec sheet), so the LLM-free
 * path reads professional instead of robotic. Grammar is hand-written, so it
 * is always correct.
 */
export function buildPropertyCard(p: Property, opts: {
  anchor?: { name: string; lat: number; lon: number };
  /** OTHER places the SAME flat also stands near (two named places 1 km apart
   *  routinely share one card) — each distance is stated, never dropped. */
  alsoAnchors?: Array<{ name: string; lat: number; lon: number }>;
} = {}): string {
  // Strip internal feed disambiguator: "Центар (населба)" → "Центар"
  const loc = p.location?.replace(/\s*\([^)]*\)\s*$/, '') ?? '';
  // NA/VO agreement: Водно is a mountain — "на Водно"; everywhere else "во"
  const prep = loc ? locPrep(loc) : 'во';
  // The category lead must MATCH the row — a land plot announced as "Станот
  // под… е стан" (the exhausted-pivot plac capture) is the wrong-category
  // failure the [09:29] business transcript belongs to.
  let s = p.plac
    ? `Плацот под Евидентен број ${p.eb}${loc ? ` е ${prep} ${loc}.` : '.'}`
    : p.house
      ? `Куќата под Евидентен број ${p.eb}${loc ? ` е ${prep} ${loc}.` : '.'}`
      : p.business
        ? `Деловниот простор под Евидентен број ${p.eb}${loc ? ` е ${prep} ${loc}.` : '.'}`
        : `Станот под Евидентен број ${p.eb} е ${propertyType(p)}${loc ? ` ${prep} ${loc}.` : '.'}`;
  // The ad text rewritten conversationally — facts only, no "Се Продава" / agency
  // boilerplate, no street. undefined = nothing usable -> the card omits it.
  const details = conversationalDetails(p);
  // NEARBY ON THE FIRST TURN: first feed-ranked landmark, contract-checked.
  // A feed list whose first entry FAILS the contract (a shop — the owner's
  // «Butik Galion» rule — or a stale over-200 m row) is not replaced with
  // silence: the resolver's own answer `p.landmark` is the same property's
  // landmark after the guard (the boutique became «ТЦ Бисер»), so the card
  // still tells the client where the flat is.
  const firstLm = firstLandmarkProblem(p.landmarks) === undefined
    ? (p.landmarks?.[0]?.landmark ?? undefined)
    : (p.landmark || undefined);
  // ANCHORED SEARCH: the client named the place he wants to live around, so
  // every card states its OWN distance from it — a pair of offers without
  // distances cannot be judged against «околу Лептокарија» ([17:26]). Measured
  // from the real pin; rows without coordinates simply omit the line.
  const anchors = [opts.anchor, ...(opts.alsoAnchors ?? [])]
    .filter((a): a is { name: string; lat: number; lon: number } => !!a);
  // ONE PLACE, SAID ONCE. When the card's own landmark IS the place the search
  // is anchored on, the next sentence named it again — «во близина на Skopje
  // City Mall. Се наоѓа на 10 m од Скопје Сити Мол.» Two spellings of one mall
  // read like two different places. The anchor line (which carries the measured
  // distance) is the one that stays.
  const anchorEcho = !!firstLm && anchors.some(a =>
    displayPlaceName(a.name).toLowerCase() === displayPlaceName(firstLm).toLowerCase());
  if (firstLm && !anchorEcho && !details?.includes(firstLm)) {
    s += ` Се наоѓа во близина на ${displayPlaceName(firstLm)}.`;
  }
  if (anchors.length > 0 && typeof p.lat === 'number' && typeof p.lon === 'number' && p.lat !== 0 && p.lon !== 0) {
    const distText = (d: number): string => (d < 1000
      ? `${Math.max(10, Math.round(d / 10) * 10)} m`
      : `${(d / 1000).toFixed(1).replace('.', ',')} km`);
    const parts = anchors
      .map(a => ({ name: a.name, d: distM(a.lat, a.lon, p.lat as number, p.lon as number) }))
      .filter(x => Number.isFinite(x.d))
      .map(x => `${distText(x.d)} од ${x.name}`);
    if (parts.length > 0) s += ` Се наоѓа на ${parts.join(' и на ')}.`;
  }
  // Landmark line restORED — but from the FEED's own ranked list, not a live
  // geocode. The [02:27] capture: a batch of two was served with NEITHER
  // card naming its public location, so the client's very first reaction was
  // "na koi lokacii se stanovite ?" — the batch presented facts nobody could
  // act on without asking again. The card now names the first feed-ranked
  // landmark (contract-checked: ≤ 200 m, a recognized public type — the
  // same source the where-is rotation starts from), so the pair lands with
  // approximate locations FIRST; only unclear geography asks again.
  // The old live-geocode line was removed for good reason ("Јане Сандански"
  // instead of "МК Доналд") — that risk does not apply here: feed rows list
  // places the writer verified rank/distance for. No feed landmarks -> no
  // line (the [58] no-address protocol stays honest); the ad text already
  // naming the same place also skips the echo.
  if (p.size) {
    s += p.plac
      ? ` Има површина од ${p.size}.`
      : ` Има ${p.size} ${p.business ? 'деловна' : 'станбена'} површина.`;
  }
  // Dedupe exact repeats — the feed lists "гаража" twice for some properties,
  // and "гаража, … и гаража" reads broken.
  const feats = [...new Set(p.features ?? [])];
  const oprema = feats.filter(f => f.includes('наместен'));
  const others = feats.filter(f => !f.includes('наместен'));
  if (others.length) s += ` ${p.plac ? 'На него' : p.house ? 'Во неа' : 'Во него'} има ${joinMk(others)}.`;
  if (oprema.length) {
    const o = oprema[0];
    s += o === 'наместен'
      ? (p.house ? ' Куќата е целосно наместена.' : ' Станот е целосно наместен.')
      : (p.house ? ` Куќата е ${o.replace('наместен', 'наместена')}.` : ` Станот е ${o}.`);
  }
  // A RENTAL's price is MONTHLY — „Цената е 350 евра.“ reads like a sale price.
  // The claim comes from the feed's own figures (monthlyRent): a per-day rent
  // is quoted as the amount alone, never as a monthly price.
  if (p.price !== undefined) s += ` Цената е ${p.price.toLocaleString('mk-MK')} евра${monthlyRent(p) !== undefined ? ' месечно' : ''}.`;
  // The rewritten facts are written out in words — the client reads the
  // property info IN THE CHAT, never on a webpage (no links anywhere).
  if (details) s += ` ${details}`;
  return s;
}

export function buildPropertyCards(properties: Property[], state: State, closerIndex = 0, recent: string[] = [], opts: { anywhere?: boolean; budget?: string; noOpener?: boolean; anchor?: { name: string; lat: number; lon: number }; perCardAnchor?: Array<{ name: string; lat: number; lon: number } | undefined>; perCardAlsoAnchors?: Array<Array<{ name: string; lat: number; lon: number }> | undefined> } = {}): string {
  // A CROSS-PLACE PAIR states each card's OWN distance: the first offer stands
  // near one place the client named, the second near the other («1,2 km од
  // ТЦ Буњаковец»), so one anchor for the whole batch would be a lie for half
  // of it. perCardAnchor wins over the shared anchor, card by card.
  const cards = properties.slice(0, 2)
    .map((p, i) => buildPropertyCard(p, {
      anchor: opts.perCardAnchor?.[i] ?? opts.anchor,
      alsoAnchors: opts.perCardAlsoAnchors?.[i],
    })).join('\n\n');
  const closer = state === 'presentation'
    ? pickCloser(PRESENTATION_CLOSERS_ALL, closerIndex)
    : pickCloser(PROPERTY_QUERY_CLOSERS_ALL, closerIndex);
  // Presentation opener — bank-backed (generated descriptive intros), so the
  // LLM-free path reads like the LLM's structure: opener → cards → closer.
  // "Било каде" searches (anywhere + budget) use the descriptive offering
  // (presentation.open.anywhere, "…до {budget} евра, почнувајќи од најбараните
  // населби…") — the client asked for options ANYWHERE, so the opener names
  // the budget and the popular-neighborhood ordering. property_query describes
  // ONE property — no opener there.
  // noOpener: a type-aware relaxed prefix ("нема гарсоњера, еве мало станче")
  // already introduces the cards — the bank opener after it read as a second,
  // contradictory speaker ("…но има слични опции. / Врз основа на… издвоив").
  const opener = state === 'presentation' && !opts.noOpener
    ? (opts.anywhere && opts.budget
      ? pickVariant('presentation.open.anywhere', { recent, vars: { budget: formatBudget(opts.budget) ?? opts.budget } })
        ?? `Еве избор на станови до ${formatBudget(opts.budget) ?? opts.budget} евра, почнувајќи од најбараните населби:`
      : pickVariant('presentation.open', { recent })
        ?? 'За Вас ги издвоив следните опции што би можеле да Ви одговараат:')
    : undefined;
  return `${opener ? `${opener}\n\n` : ''}${cards}\n\n${closer}`;
}

/** CROSS-PLACE PAIR metadata for a batch: the opener naming the places the
 *  client asked about, each card's OWN anchor (so every card states the
 *  distance to the place IT stands near) and the once-only honest line for a
 *  place with nothing in the criteria.
 *
 *  It lives here, next to the card builders, because every batch builder needs
 *  it — the presentation ladder, the widen serve and the LLM-less fallback.
 *  Absent/one place returns nothing: that serve is the two-nearest-to-one-place
 *  one, which already knows its anchor.
 */
export function pairBatchMeta(session: ChatSession, properties: Property[]): {
  opener?: string;
  emptyLine?: string;
  perCardAnchor?: Array<{ name: string; lat: number; lon: number } | undefined>;
  perCardAlsoAnchors?: Array<Array<{ name: string; lat: number; lon: number }> | undefined>;
} {
  const places = (session.slots.poiPlaces?.length ?? 0) >= 2 ? session.slots.poiPlaces : undefined;
  if (!places) return {};
  const anchors = properties.map(p => session.slots.pairAnchorOf?.[String(p.id)]);
  const alsoOf = properties.map(p => session.slots.pairAlsoNearOf?.[String(p.id)] ?? []);
  // The opener names the places the CARDS WERE DRAWN FOR, in card order — the
  // rotation's own pair (the [18:48] contract: 1/2, then 3/1, then 2/3). A card
  // that merely STANDS near a third place still states that distance (see
  // alsoAnchors) without claiming the batch was drawn for it: naming every
  // radius neighbour made a 3/1 serve read as a three-place answer.
  const names: string[] = [];
  for (const a of anchors) if (a && !names.includes(a.name)) names.push(a.name);
  // EVERY card must be an ANSWER. A batch that also carries an ALTERNATIVE —
  // a row outside every named place's radius, which carries no anchor — must
  // not be introduced as «по една опција до X и до Y» (the [15:36] capture:
  // the second card sat 3,1 km from the nearer place while the opener claimed
  // it answered the pair). Such a batch keeps the ordinary presentation
  // opener and lets each card state only the distances it really has.
  const allAnswered = anchors.every((a, i) => !!a || alsoOf[i].length > 0);
  const said = new Set(session.slots.pairEmptySaid ?? []);
  const empty = (session.slots.pairEmpty ?? []).filter(n => !said.has(n));
  if (empty.length > 0) session.slots.pairEmptySaid = [...said, ...empty];
  return {
    opener: !allAnswered ? undefined
      : names.length >= 2
        ? `Еве по една опција до ${names.map(n => displayPlaceName(n)).join(' и до ')}:`
        : names.length === 1 ? `Еве ја најблиската опција до ${displayPlaceName(names[0])}:`
        : undefined,
    emptyLine: empty
      .map(n => `Околу ${displayPlaceName(n)} во моментов немам ништо што одговара на овие критериуми.`)
      .join(' ') || undefined,
    perCardAnchor: anchors.map(a => a
      ? { name: displayPlaceName(a.name), lat: a.lat, lon: a.lon } : undefined),
    perCardAlsoAnchors: alsoOf.map(list => (list.length > 0
      ? list.map(a => ({ name: displayPlaceName(a.name), lat: a.lat, lon: a.lon }))
      : undefined)),
  };
}

export function buildPropertyContext(properties: Property[]): string {
  if (!properties.length) return '[]';
  return JSON.stringify(properties.map(p => ({
    eb: p.eb,
    // Address PRIVACY: the LLM gets the LANDMARK (approximate location), never
    // the street — it must not be able to leak the exact address either.
    address: p.landmark ?? p.location ?? null,
    // SURROUNDINGS (the [01:29] lesson): the client may ask about the places
    // around the property — "od stranata na trgovskiot ili odkaj pazarceto" —
    // and the model can only answer those from what it is given. With no
    // surroundings in the context it has nothing but the single resolved
    // landmark, so it either ignores the question or invents the geography
    // (the deterministic lane answers the named-place case; this is what the
    // brain sees for every OTHER phrasing). REAL places with their REAL
    // distance from the feed's own ranked public landmarks — the distances are
    // what let the model name the nearest as the side the client means (the
    // feed ranks by prominence, NOT by distance, so order alone proves
    // nothing). The street is still never in the context.
    nearby: (p.landmarks ?? [])
      .filter(l => !!l.landmark && l.landmark !== p.landmark)
      .slice(0, 3)
      .map(l => ({ name: l.landmark, m: l.distance_m ?? null })),
    location: p.location ?? null,
    bedrooms: p.bedrooms ?? null,
    size: p.size ?? null,
    price_eur: p.price ?? null, // ALWAYS euros (feed cena_eur)
    features: p.features ?? null,
    // The ad text is passed ALREADY rewritten (facts only, no marketing copy,
    // no street) so the model can never paste-quote the listing verbatim.
    details: conversationalDetails(p) ?? null,
    gmaps: p.gmaps ?? null,
    // NO url field: the client reads the property info in the chat as words,
    // so the model must never see a link to echo.
  })), null, 2);
}
