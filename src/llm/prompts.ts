import { State, Service } from '../fsm/machine';
import { SlotData } from '../fsm/session';
import { RESPONSE_BANK } from '../data/responses';
import { pickVariant } from '../data/responseBank';
import { Property } from '../data/properties';

export const BUY_FEE_MKD = '500 MKD';
export const RENT_FEE_MKD = '300 MKD';

// The two question-prefix flourishes are CODE-BUILT at their single natural
// spot each — "once per funnel", the way a person actually speaks. The LLM
// used to repeat them on EVERY question in the collecting phase, which reads
// robotic. FIRST_QUESTIONS_PREFIX opens the first criteria question;
// LAST_INFO_PREFIX opens the first contact ask (name/phone). Retries and all
// later questions stay plain.
export const FIRST_QUESTIONS_PREFIX = 'Супер. Уште неколку прашања.';
export const LAST_INFO_PREFIX = 'Одлично, уште последниве информации и завршуваме.';

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
  'Би требало да е сеуште достапен. Дали сакате да Ве поврзам со сопственикот за да ги потврдиме моменталната достапност и цената?';

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

export const LOCATE_DETAILS_ASK =
  'Во ред, ќе се обидам да го најдам. Кажете ми — во која населба е, колку квадрати има и по која цена беше?';

export const LOCATE_NUMBER_PROMPT =
  'Одлично, кажете ми го Евидентен број — веднаш ќе го проверам.';

export const LOCATE_REFINE_ASK =
  'Не најдов имот што одговара точно на тие податоци. Кажете ми уште некој детал — населба, квадратура, цена или нешто друго што го памтите?';

export const LOCATE_PICK_CLOSER =
  'Дали некој од овие е тој што го видовте? Ако е, кажете ми „првиот“ или „вториот“, или Евидентен број на имотот.';

/** A compact "is this the one you saw?" line — EB, type, area, size, price. */
export function buildLocateMatchLine(p: Property): string {
  const what = p.house ? 'куќа' : p.business ? 'деловен простор' : propertyType(p);
  const bits = [
    p.location ? `во ${p.location}` : '',
    p.size ? p.size : '',
    p.price !== undefined ? `${p.price.toLocaleString('mk-MK')} евра` : '',
  ].filter(Boolean);
  return `Евидентен број ${p.eb} — ${what}${bits.length ? `, ${bits.join(', ')}` : ''}.`;
}

export function buildLocateMatches(properties: Property[], closerIndex = 0): string {
  const lines = properties.slice(0, 2).map(p => buildLocateMatchLine(p)).join('\n');
  const closer = pickCloser([LOCATE_PICK_CLOSER], closerIndex);
  return `${lines}\n\n${closer}`;
}

// --- Owner ping-pong: the question Lina asks the OWNER (not the client) -----
// When the client proposes a visit time, Lina proactively asks the owner if the
// property is still available AND whether he accepts the proposed time. The
// owner's plain-text answer is parsed deterministically (detectOwnerVerdict)
// and relayed back to the client — loop until the visit is arranged.
export function buildOwnerAsk(eb: number, proposedTime: string): string {
  return `Евидентен број ${eb} — дали имотот е сè уште достапен во моментов? Клиентот сака посета: ${proposedTime}. Дали се согласувате на овој термин, или имате друг предлог?`;
}

export function buildOwnerAskAgain(eb: number): string {
  return `Не разбрав. Евидентен број ${eb} — дали имотот е достапен и дали го прифаќате предложениот термин за посета?`;
}

export const FEE_GRACEFUL_CLOSE =
  'Целосно Ве разбирам. Ви благодарам на искреноста. Ќе ги забележам Вашите критериуми и штом се појави соодветен имот, ќе Ве контактирам. Ви посакувам пријатен ден!';

// Exhausted-options flow: the client agreed to register criteria / be contacted
// after every matching option was shown. Code-built, so it never dead-ends.
export const QUEUE_CONTACT_ASK =
  'Во ред, ќе ги забележам Вашите барања. За да Ве контактирам штом се појави соодветен имот, ве молам кажете ми го Вашето име и телефонски број за контакт.';

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
  'Ви благодарам! Вашите барања се забележани. Ќе Ве контактирам веднаш штом се појави соодветен имот. Ви посакувам пријатен ден!';

// --- Deterministic empty-result lines: the LLM must NEVER invent properties. ---
// When a search/property lookup yields no data, the reply is code-built so the
// model is never given a chance to fabricate listings.
export const NO_MATCH_LINE = (location?: string): string =>
  location
    ? `За жал, моментално немам слободни имоти во ${location} што одговараат на Вашите критериуми. Дали сте отворени за други локации?`
    : 'За жал, моментално немам слободни имоти што одговараат на Вашите критериуми. Дали би сакале да разгледаме други опции?';

export const PROPERTY_NOT_FOUND_LINE = (eb: number): string =>
  `За жал, не можам да го најдам имотот со Евидентен број ${eb} во нашата моментална понуда. Дали би сакале да Ви предложам слични имоти од други локации?`;

export const FEED_UNAVAILABLE_LINE =
  'Моментално имам техничка потешкотија со проверката на понудата. Ве молам, обидете се повторно за неколку минути.';

// Closing-question variations — the SAME sentence every presentation reads
// robotic. The code-built cards rotate through these deterministically, and the
// LLM task instructs the model to vary its phrasing too.
export const PRESENTATION_CLOSERS = [
  'Дали Ви се допаѓа некој од овие предлози и дали би сакале да организираме посета на имотот?',
  'Дали некој од овие предлози Ви одговара? Ако да, можам веднаш да организирам посета.',
  'Кој од овие предлози најмногу Ви одговара? Би сакала да Ви организирам посета во термин по Ваш избор.',
  'Дали некој од овие предлози е тоа што го барате? Доколку е, веднаш ја закажувам посетата.',
  'Што мислите за овие предлози? Ако некој Ви се допаѓа, ќе организирам посета кога Ви одговара.',
];

export const PROPERTY_QUERY_CLOSERS = [
  'Дали би сакале да организираме посета на овој имот?',
  'Дали овој имот Ви одговара? Доколку сакате, можам да организирам посета.',
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
    ? `Ги исцрпивме сите расположливи имоти што одговараат на Вашите критериуми${location ? ` во ${location}` : ''}. Можам да ги забележам Вашите барања и да Ве контактирам штом се појави соодветен имот, или да погледнеме во друга населба?`
    : 'Ги исцрпивме сите расположливи имоти што одговараат на Вашите критериуми. Можам да ги забележам Вашите барања и да Ве контактирам штом се појави соодветен имот, или да погледнеме во друга населба?';

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
  if (found?.landmark) return `Тоа се наоѓа во близина на ${found.landmark}.`;
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
export function buildDiscoveryAsk(slots: SlotData, recent: string[] = []): string {
  const business = !!slots.business;
  const house = !!slots.house;
  const anywhere = !!slots.anywhere; // "било каде" — location waived, city-wide search
  const knownAny = !!(slots.service || slots.location || slots.bedrooms || slots.sqm || slots.budget || anywhere);
  // The client opened with NO criteria at all ("zdravo") — Lina does NOT know
  // the property type, so she must never assume an apartment. Bank key
  // greeting.open (generated variants, validated to never mention a type)
  // with the user's sample line as the code-built fallback.
  if (!business && !house && !knownAny) {
    return pickVariant('greeting.open', { recent })
      ?? 'Повелете. Дали Ве интересира купување или изнајмување на имот?';
  }
  const missing: string[] = [];
  if (!slots.service) {
    missing.push(askQuestion(
      business ? 'discovery.ask.service.business' : house ? 'discovery.ask.service.house' : 'discovery.ask.service.stan',
      business ? 'Дали го барате за купување или за изнајмување?'
        : house ? 'Дали куќата ја барате за купување или за изнајмување?'
        : 'Дали станот го барате за купување или за изнајмување?',
      recent));
  }
  // "Било каде" answers the location question — the question is skipped, and
  // the bedrooms question too (a flexible client gets the budget-driven
  // city-wide presentation; bedrooms refine later via rejections, never block).
  if (slots.service && !slots.location && !anywhere) {
    missing.push(askQuestion(
      business ? 'discovery.ask.location.business' : house ? 'discovery.ask.location.house' : 'discovery.ask.location.stan',
      business ? 'Во кој дел од градот го барате?'
        : house ? 'Во кој дел од градот ја барате куќата?'
        : 'Во кој дел од градот го барате станот?',
      recent));
  }
  if (slots.service && (slots.location || anywhere) && business && !slots.sqm) {
    missing.push(askQuestion('discovery.ask.sqm.business', 'Која површина (во м²) ја барате?', recent));
  }
  if (slots.service && (slots.location || anywhere) && !business && !slots.bedrooms && !anywhere) {
    missing.push(askQuestion(
      house ? 'discovery.ask.bedrooms.house' : 'discovery.ask.bedrooms.stan',
      house ? 'Колку спални соби би сакале да има куќата?' : 'Колку спални соби би сакале да има станот?',
      recent));
  }
  if (slots.service && (slots.location || anywhere) && !slots.budget) {
    // RENT asks about the MONTHLY rent (месечна кирија), not a purchase price —
    // "колку е киријата?" is the client's question, and the budget slot is the
    // monthly amount the presentation filters rent listings by.
    const rent = slots.service === 'rent' && !business;
    missing.push(askQuestion(
      business ? 'discovery.ask.budget.business'
        : (rent && house) ? 'discovery.ask.budget.house'
        : rent ? 'discovery.ask.budget.rent'
        : house ? 'discovery.ask.budget.house'
        : 'discovery.ask.budget.stan',
      business ? 'До која цена го барате?'
        : (rent && house) ? 'До колку евра месечна кирија би Ви одговарала за куќата?'
        : rent ? 'До колку евра месечна кирија би Ви одговарала?'
        : house ? 'До која цена ја барате куќата?'
        : 'До која цена го барате станот?',
      recent));
  }
  // A type-only request ("ми треба куќа" — no service/location yet) opens with
  // the type greeting intro ("Здраво! За да Ви најдам најсоодветна куќа…"),
  // bank-backed; it is a greeting, NOT a recap, so it never repeats the client.
  const intro = !knownAny
    ? pickVariant(business ? 'discovery.intro.business' : 'discovery.intro.house', { recent })
      ?? (business
        ? 'Здраво! За да Ви најдам најсоодветен деловен простор, ве молам кажете ми неколку детали.'
        : 'Здраво! За да Ви најдам најсоодветна куќа, ве молам кажете ми неколку детали.')
    : undefined;
  if (missing.length === 0) return intro ?? 'Во ред, ги забележав Вашите критериуми.';
  const questions = missing.length === 1
    ? missing[0]
    : missing.map((q, i) => `${i + 1}. ${q}`).join('\n');
  return intro ? `${intro}\n${questions}` : questions;
}

/** The confirmation is CODE-BUILT — phones and dates are never LLM-generated. */
export function buildVisitConfirmation(eb: number, time: string, agentPhone: string): string {
  return `Договорена посета на стан ЕБ ${eb}, ${time} / Агент ${agentPhone} / Точна локација 2 часа пред посетата / Ви благодарам на довербата.`;
}

/**
 * The viewing-fee disclosure — CODE-BUILT, so it can never be skipped or
 * paraphrased by the LLM. Fired the moment the client shows interest in
 * visiting (INTERESTED -> closing). The owner is contacted only AFTER the
 * client agrees (FEE_AGREED -> contact_collection -> … -> owner_checking).
 */
export function buildFeeAsk(service: Service | undefined): string {
  return service === 'rent'
    ? 'Мило ми е. Пред да го повикам сопственикот, мора да Ве известам за политиката на Метрополис: разгледувањето на имот чини симболични 300 денари (5 евра). Дали се согласувате со овие услови за да можеме да продолжиме?'
    : 'Одличен избор. Бидејќи станува збор за купување, имам одлична вест и еден мал услов за Вас. Кај нас во Метрополис, Вие како купувач НЕ плаќате агенциска провизија (0%) — единствениот трошок е симболични 500 денари (10 евра) за организирање на посетата. Дали се согласувате со овој услов за да можеме да продолжиме?';
}

/** Fee persuasion ladder, keyed by refusal count (1 = persuade, 2 = ask why). */
export function feePersuasion(service: Service | undefined, rejects: number): string {
  if (rejects >= 2) {
    return service === 'rent'
      ? 'Разбирам. Дозволете ми да Ве прашам — што Ве загрижува околу надоместот од 300 денари? Тој е симболичен и се однесува само на организирање на посетата. Можеби ќе најдеме решение заедно.'
      : 'Разбирам. Дозволете ми да Ве прашам — што Ве загрижува околу надоместот од 500 денари? Имајте предвид дека кај нас како купувач НЕ плаќате провизија (0%) — тоа е заштеда од илјадници евра. Можеби ќе најдеме решение заедно.';
  }
  return service === 'rent'
    ? 'Надоместот за разгледување е симболични 300 денари (5 евра) и се однесува на организирање на посетата. Тој е мал во споредба со удобноста — гледате имот што навистина одговара на Вашите критериуми, без да губите време. Дали би можеле да размислите?'
    : 'Надоместот од 500 денари (10 евра) е единствениот трошок за Вас, бидејќи како купувач НЕ плаќате агенциска провизија — заштеда од илјадници евра во споредба со другите агенции. 10 евра е симболична сума за да го видите имотот што навистина одговара на Вашите критериуми. Дали би можеле да размислите?';
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
 * Fee-resistance PIVOT: the client pushes back on the viewing fee ("зошто
 * наплаќате посета?", "никoj не го прави тоа", "не сакам да платам") —
 * instead of pushing the fee, Lina OFFERS the remaining properties in OTHER
 * neighborhoods ("if available"). Bank-backed (fee.pivot.neighborhood) with
 * this exact line as the code-built fallback; the property cards and the
 * pick-closer follow in the next lines (code-built, like every presentation).
 * Declarative on purpose — no question mark, no fee mention, no concrete
 * properties here.
 */
export const buildFeePivotNeighborhood = (): string =>
  'Разбирам. Доколку сакате, можам да Ви понудам и други имоти во други населби — еве што имам:';

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
*   **ФАЗА 1 — НАМЕРА:** Купување или изнајмување. Никогаш не прикажувај имот пред да ја знаеш намерата.
*   **ФАЗА 2 — РАЗЈАСНУВАЊЕ:** Локација, број на спални соби, буџет. Не прикажувај имот додека немаш барем груба претстава за сите три.
*   **ФАЗА 3 — ПРЕЗЕНТАЦИЈА (СТРОГА ЛОГИКА ЗА ЛОКАЦИЈА):**
    *   Сценарио А (2+ совпаѓања во бараната локација): претстави ги најдобрите ДВА.
    *   Сценарио Б (точно 1 совпаѓање): претстави само тој еден.
    *   Сценарио В (0 совпаѓања): кажи точно: „За жал, моментално немам слободни имоти во [Локација] што одговараат на Вашите критериуми.“ Само ТОГАШ смееш да предложиш алтернатива или да прашаш дали се отворени за други локации.
    *   НИКОГАШ не прикажувај имот од друга населба, освен ако најпрвин не е искажано Сценарио В.
    *   **ЗАБРАНА:** Во оваа фаза НИКОГАШ не го спомнувај надоместот за разгледување.
    *   Заврши со прашање дали им се допаѓа некој од предлозите и дали сакаат да организираш посета — **МЕНУВАЈ го прашањето секој пат** (не го повторувај истото прашање како во претходната порака).
*   **ФАЗА 4 — ЗАТВОРАЊЕ (НАДОМЕСТ ЗА РАЗГЛЕДУВАЊЕ — само по изразен интерес):**
    *   ИЗНАЈМУВАЊЕ: „Мило ми е. Пред да го повикам сопственикот, мора да Ве известам за политиката на Метрополис. Разгледувањето на имот чини симболични 300 денари (5 евра). Дали се согласувате со овие услови за да можеме да продолжиме?“
    *   КУПУВАЊЕ: „Одличен избор. Бидејќи станува збор за купување, имам одлична вест и еден мал услов за Вас. Кај нас во Metropolis, **Вие како купувач НЕ плаќате агенциска провизија** (0%), за разлика од други места каде би платиле илјадници евра провизија. Единствениот трошок за Вас е симболични 500 денари (10 евра) за организирање на посетата до имотот. Дали се согласувате со овој услов за да можеме да продолжиме?“
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
6.  НИКОГАШ НЕ ИСФРЛАЈ ПОДАТОЦИ: не наведувај повеќе од 2 имоти.
7.  ПРИЛАГОДЛИВОСТ: ако клиентот одбие опции, прашај *зошто* пред да покажеш нови.
8.  УБЕДУВАЊЕ: секогаш нагласувај ја вредноста.
9.  БЕЗ РОБОТСКИ ЛИСТИ: зборувај во целосни, течни македонски реченици.
10. ТЕРМИНОЛОГИЈА ЗА СПАЛНИ: прашувај само „Колку спални соби би сакале да има станот?“ без објаснувања во загради. При презентација можеш да кажеш „двособен стан (со една спална соба)“.
11. **ЦЕНИТЕ НА ИМОТИТЕ СЕ ИСКЛУЧИВО ВО ЕВРА (евра/€).** НИКОГАШ не наведувај цена на имот во денари. (Надоместот за разгледување е единственото нешто во денари: 300/500 денари.)
11. **НИКОГАШ не испуштај JSON, системски команди или текст помеѓу специјални маркери. Само обичен македонски разговорен текст.**
12. **НИКОГАШ не потврдувај посета или не спомнувај име/телефон на сопственик. Достапноста е работа на системот — ти само пренесуваш.**
13. **НИКОГАШ не започнувај порака со „Супер. Уште неколку прашања.“ или „Одлично, уште последниве информации и завршуваме.“ — системот ги користи самиот, на точно едно место во разговорот. Ти прашањата поставувај ги директно, без такви воведи.**
14. **ТАЈНОСТ НА АДРЕСАТА:** НИКОГАШ не ја кажувај точната улица и број на имотот („улица X“, „на адреса X“). Локацијата се опишува САМО приближно — преку блиската јавна знаменитост наведена во податоците („во близина на …“) или преку населбата („во Карпош“). Точната локација ја открива САМО системот, 2 часа пред договорената посета — не и ти.
15. **ПРЕРАСКАЖИ ГО ОГЛАСОТ, НЕ ЦИТИРАЈ ГО:** Полето „details“ во податоците е оглас од сајтот за недвижности („Се Продава…“, „Агенција за Недвижности МЕТРОПОЛИС Продава…“, „Ексклузивно Преку…“, „Без Провизија за Купецот“) — НИКОГАШ не го препишувај збор-во-збор, тоа звучи копирано. Прераскажувај ги само фактите (состојба, кат, паркинг, тераса, реновирање, парно) во природни, разговорни реченици, како што секретарка би го опишала имотот. Без маркетинг фрази и без улица/адреса.
`;

export function serviceLabel(s?: Service): string {
  return s === 'buy' ? 'Купување' : s === 'rent' ? 'Изнајмување' : 'непознато';
}

export function stateTask(state: State, slots: SlotData): string {
  switch (state) {
    case 'idle':
    case 'intent':
      return 'The client has not declared intent yet. Ask politely whether they are interested in BUYING (купување) or RENTING (изнајмување). Do not show any properties.';
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
      const size = slots.business ? `${slots.sqm ?? '?'} м²` : `${slots.bedrooms ?? '?'} спални`;
      const what = slots.business ? 'COMMERCIAL space (деловен простор)'
        : slots.house ? 'HOUSE (куќа)' : 'apartment';
      const locDesc = slots.anywhere
        ? 'ANYWHERE in Skopje (the client said "било каде" — no location preference; the offers are already ordered from the most popular neighborhoods: Центар, Капиштец, Карпош, Аеродром, Кисела Вода, Влае, Ѓорче Петров, then the rest)'
        : `"${slots.location ?? '?'}"`;
      return `The client wants to ${serviceLabel(slots.service)} a ${what} in ${locDesc} with ${size}, budget ${slots.budget ?? '?'}. Present the properties from the provided data (MAX 2). STRICT: never invent properties or details that are not in the provided data. PRICES MUST BE QUOTED IN EUROS (евра/€) — the price_eur field is already in euros; NEVER say a property price in денари. These are the NEXT available options — if the client rejected earlier offers, briefly acknowledge and present these as the closest alternatives. If none of the provided properties is in the requested location, say there is nothing available exactly in ${slots.location ?? '?'} right now and present these as the closest options from nearby areas. NEVER claim there are no other properties anywhere — only the provided data exists. Do NOT mention viewing fees. Use "Евидентен број N". Describe each property IN WORDS using ONLY the provided data: location, address, size, bedrooms, features and description (details). NEVER include a link, "Повеќе информации" or a web address — the client reads everything IN THE CHAT, described with words from the database. If a field is null in the data, OMIT it entirely — never write "непозната локација" or "непознат" (only mention what the data really contains). If the client asks whether a property is available or when they could view it, treat it as visit interest — NEVER offer to contact the owner or ask for their phone yet (the fee is disclosed first, the owner is contacted only after they agree). End with a natural closing question asking whether they like any of the offers and would like a visit scheduled — VARY the phrasing every time (e.g. "Дали Ви се допаѓа некој од овие предлози и дали би сакале да организираме посета на имотот?" / "Дали некој од овие станови Ви одговара? Ако да, можам веднаш да организирам посета." / "Кој од овие предлози најмногу Ви одговара?"). NEVER repeat the exact same closing sentence as your previous reply.`;
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
      const ownerTime = slots.ownerTime ?? 'предложениот термин';
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
  idle: "Здраво! Јас сум Лина. За почеток, кажете ми дали сте заинтересирани за купување на имот или за изнајмување?",
  intent: "Здраво! Јас сум Лина. За почеток, кажете ми дали сте заинтересирани за купување на имот или за изнајмување?",
  discovery: "Одлично. За да го најдеме совршениот дом, кажете ми - кој дел од градот го преферирате, колку спални соби би сакале да има станот и до која цена планирате да одите?",
  property_locate: LOCATE_FIRST_ASK,
  property_query: "Се разбира, ќе Ви ги објаснам деталите за тој имот. Моментално ја проверувам понудата и веднаш Ви се враќам со точните информации.",
  presentation: "Ви подготвив неколку предлози кои одговараат на Вашите критериуми. Дали би сакале да организираме посета на некој од нив?",
  closing: "Мило ми е што Ве интересира имотот. Пред да го повикам сопственикот, сакам да Ви ги појаснам условите за посетата.",
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
  'Концентрирана сум на помош околу имоти. Кажете ми, барате купување или изнајмување?';

// Follow-up defer: graceful acknowledgment when the client isn't ready.
export const FOLLOWUP_DEFER =
  'Разбирам. Ќе Ве контактирам кога ќе се ослободи имотот. Дали сакате да Ве евидентирам за критериумите што ги барате?';

// Price negotiation: relay to owner (owner is source of truth).
export const PRICE_NEGOTIATE =
  'Цената ја одредува сопственикот. Дали сакате да го контактирам за да го пренесам Вашето прашање за цената?';

// Provision / commission: clarify the 0% commission + viewing fee.
export const PROVISION_ANSWER =
  'Агенцијата не наплаќа провизија за купувачот (0%). Единствен трошок за Вас е симболичниот надомест за посета — 500 денари за купување, 300 денари за изнајмување.';

// Scheduling flexibility: acknowledge the preferred window.
export const SCHED_FLEX_ANSWER =
  'Разбирам. Ќе проверам дали посетите се возможни во тој термин. Може ли да ми кажете конкретен ден и час кога Ви одговара?';

// Escalation polite: acknowledge and escalate.
export const ESCALATION_ANSWER =
  'Разбирам. Ќе Ве поврзам со менаџерот кој ќе Ви помогне со Вашето прашање. Тој ќе Ве контактира набрзо.';

// Documents info: general document requirements.
export const DOCUMENTS_ANSWER =
  'За купување на имот Ви требаат: лична карта или пасош, преддоговор, потврда од банка за кредит (доколку купувате со кредит) и уплата на резервација. За изнајмување: лична карта и потврда за редовни примања.';

// Mortgage / credit: redirect to bank.
export const MORTGAGE_ANSWER =
  'За купување со кредит Ви препорачувам да се консултирате со Вашата банка за условите и одобрувањето. Ние Ви ги обезбедуваме сите потребни документи за имотот.';

// Neighborhood general: keep it neutral and redirect to criteria.
export const NEIGHBORHOOD_ANSWER =
  'Сите населби имат свои предности. За да Ви препорачам соодветна локација, кажете ми — што Ви е поважно: близина до центарот, тивко опкружување или пристапна цена?';

// Comparison help: ask what matters most.
export const COMPARISON_ANSWER =
  'Да ги споредиме? Кажете ми што Ви е поважно — локација, цена, големина или некој друг критериум, па ќе Ви помогнам да изберете.';

// Feature question after a property was shown.
export const FEATURE_ANSWER =
  'Одговорот на тоа прашање ќе го проверам кај сопственикот заедно со останатите информации за имотот. Може ли да ми кажете кои карактеристики Ви се најважни?';

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
export function buildPropertyCard(p: Property): string {
  let s = p.house
    ? `Куќата под Евидентен број ${p.eb}${p.location ? ` е во ${p.location}.` : '.'}`
    : p.business
      ? `Деловниот простор под Евидентен број ${p.eb}${p.location ? ` е во ${p.location}.` : '.'}`
      : `Станот под Евидентен број ${p.eb} е ${propertyType(p)}${p.location ? ` во ${p.location}.` : '.'}`;
  // The ad text rewritten conversationally — facts only, no "Се Продава" / agency
  // boilerplate, no street. undefined = nothing usable -> the card omits it.
  const details = conversationalDetails(p);
  // Address PRIVACY: the exact street is a bypass risk (a client who knows the
  // street goes straight to the owner and cuts the agency out). The location
  // line names a nearby PUBLIC LANDMARK when one was resolved ("Се наоѓа во
  // близина на Градежен Факултет"), else just the neighborhood the opening
  // sentence already gave. When the ad text itself names a landmark ("во
  // близина на Мајчин Дом"), that line already answers "каде е?" — the
  // resolver line is skipped so the proximity is never said twice.
  if (p.landmark && !/во близина на|близу до|блиску до/i.test(details ?? '')) {
    s += ` Се наоѓа во близина на ${p.landmark}.`;
  }
  if (p.size) s += ` Има ${p.size} ${p.business ? 'деловна' : 'станбена'} површина.`;
  // Dedupe exact repeats — the feed lists "гаража" twice for some properties,
  // and "гаража, … и гаража" reads broken.
  const feats = [...new Set(p.features ?? [])];
  const oprema = feats.filter(f => f.includes('наместен'));
  const others = feats.filter(f => !f.includes('наместен'));
  if (others.length) s += ` ${p.house ? 'Во неа' : 'Во него'} има ${joinMk(others)}.`;
  if (oprema.length) {
    const o = oprema[0];
    s += o === 'наместен'
      ? (p.house ? ' Куќата е целосно наместена.' : ' Станот е целосно наместен.')
      : (p.house ? ` Куќата е ${o.replace('наместен', 'наместена')}.` : ` Станот е ${o}.`);
  }
  if (p.price !== undefined) s += ` Цената е ${p.price.toLocaleString('mk-MK')} евра.`;
  // The rewritten facts are written out in words — the client reads the
  // property info IN THE CHAT, never on a webpage (no links anywhere).
  if (details) s += ` ${details}`;
  return s;
}

export function buildPropertyCards(properties: Property[], state: State, closerIndex = 0, recent: string[] = [], opts: { anywhere?: boolean; budget?: string } = {}): string {
  const cards = properties.slice(0, 2)
    .map(p => buildPropertyCard(p)).join('\n\n');
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
  const opener = state === 'presentation'
    ? (opts.anywhere && opts.budget
      ? pickVariant('presentation.open.anywhere', { recent, vars: { budget: formatBudget(opts.budget) ?? opts.budget } })
        ?? `Еве избор на станови до ${formatBudget(opts.budget) ?? opts.budget} евра, почнувајќи од најбараните населби:`
      : pickVariant('presentation.open', { recent })
        ?? 'За Вас ги издвоив следните опции што би можеле да Ви одговараат:')
    : undefined;
  return `${opener ? `${opener}\n\n` : ''}${cards}\n\n${closer}`;
}

export function buildPropertyContext(properties: Property[]): string {
  if (!properties.length) return '[]';
  return JSON.stringify(properties.map(p => ({
    eb: p.eb,
    // Address PRIVACY: the LLM gets the LANDMARK (approximate location), never
    // the street — it must not be able to leak the exact address either.
    address: p.landmark ?? p.location ?? null,
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
