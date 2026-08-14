import { State, Service } from '../fsm/machine';
import { SlotData } from '../fsm/session';
import { Property } from '../data/properties';

export const BUY_FEE_MKD = '600 MKD';
export const RENT_FEE_MKD = '300 MKD';

// --- Visit sub-funnel: exact phrases (code-built, never LLM-invented) --------
export const VISIT_TIME_QUESTION =
  'Кој термин би Ви одговарал за посета? Да се обидам да договорам со сопственикот во тоа време.';

export const OWNER_CHECK_ACK =
  'Во ред, ќе Ве известам штом потврдам.';

export const PATIENCE_LINE =
  'Моментално го контактирам сопственикот за достапноста. Ќе Ве известам веднаш штом добијам одговор.';

export const FEE_GRACEFUL_CLOSE =
  'Целосно Ве разбирам. Ви благодарам на искреноста. Ќе ги забележам Вашите критериуми и штом се појави соодветен имот, ќе Ве контактирам. Ви посакувам пријатен ден!';

// Exhausted-options flow: the client agreed to register criteria / be contacted
// after every matching option was shown. Code-built, so it never dead-ends.
export const QUEUE_CONTACT_ASK =
  'Во ред, ќе ги забележам Вашите барања. За да Ве контактирам штом се појави соодветен имот, ве молам кажете ми го Вашето име и телефонски број за контакт.';

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
  'Дали некој од овие станови Ви одговара? Ако да, можам веднаш да организирам посета.',
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

function pickCloser(list: string[], index: number): string {
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
export function buildWhereIsAnswer(place: string, found?: { address?: string; location?: string; eb?: number; business?: boolean }): string {
  const addr = found?.address;
  const loc = found?.location;
  const eb = found?.eb;
  const realAddr = addr && (!eb || addr !== `Имот ЕБ ${eb}`) ? addr : undefined;
  if (realAddr && loc) return `Тоа се наоѓа на адресата ${realAddr}, во населбата ${loc}.`;
  if (realAddr) {
    const what = found?.business ? 'деловниот простор' : 'станот';
    return `Тоа е адресата на ${what} под Евидентен број ${eb ?? '?'}. За точната локација, можам да Ви организирам посета — сакате ли?`;
  }
  if (loc && eb) return `Тоа се наоѓа во населбата ${loc}.`;
  if (loc) return `${place || 'Тоа'} е населба во Скопје.`;
  if (place) return `Тоа место не ми е познато во нашата база. Ако сакате, можам да Ви организирам посета за да го погледнете на лице место.`;
  return 'За точната локација, можам да Ви организирам посета — сакате ли?';
}

function bedroomWord(n: number): string {
  if (n === 1) return 'една спална соба';
  if (n === 2) return 'две спални соби';
  if (n === 3) return 'три спални соби';
  return `${n} спални соби`;
}

function formatBudget(b: string): string {
  const n = Number(b.replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n.toLocaleString('mk-MK') : b;
}

/**
 * The discovery ask is CODE-BUILT: it only ever asks for what is still
 * missing (intent -> location -> size -> price) and NEVER re-asks what the
 * client already gave. Commercial spaces (деловен простор) complete with
 * square meters instead of bedrooms — a "деловен простор" request must never
 * be asked "колку спални?". Grammar is hand-written, so it is always correct.
 */
export function buildDiscoveryAsk(slots: SlotData): string {
  const business = !!slots.business;
  const known: string[] = [];
  if (business) known.push('деловен простор');
  if (slots.service) known.push(slots.service === 'buy' ? 'за купување' : 'за изнајмување');
  if (slots.location) known.push(`во ${slots.location}`);
  if (business) {
    if (slots.sqm) known.push(`со ${slots.sqm} м²`);
  } else if (slots.bedrooms) {
    known.push(`со ${bedroomWord(slots.bedrooms)}`);
  }
  if (slots.budget) known.push(`до ${formatBudget(slots.budget)} евра`);
  const missing: string[] = [];
  if (!slots.service) missing.push(business ? 'Дали го барате за купување или за изнајмување?' : 'Дали станот го барате за купување или за изнајмување?');
  if (slots.service && !slots.location) missing.push(business ? 'Во кој дел од градот го барате?' : 'Во кој дел од градот го барате станот?');
  if (slots.service && slots.location && business && !slots.sqm) missing.push('Која површина (во м²) ја барате?');
  if (slots.service && slots.location && !business && !slots.bedrooms) missing.push('Колку спални соби би сакале да има станот?');
  if (slots.service && slots.location && !slots.budget) {
    missing.push(business ? 'До која цена го барате?' : 'До која цена го барате станот?');
  }
  const intro = known.length
    ? `Разбрав — барате ${business ? '' : 'стан '}${known.join(', ')}.`
    : business
      ? 'Здраво! За да Ви најдам најсоодветен деловен простор, ве молам кажете ми неколку детали.'
      : 'Здраво! За да Ви најдам најсоодветни станови, ве молам кажете ми неколку детали.';
  if (missing.length === 0) return intro;
  const questions = missing.length === 1
    ? missing[0]
    : missing.map((q, i) => `${i + 1}. ${q}`).join('\n');
  return `${intro}\n${questions}`;
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
    : 'Одличен избор. Бидејќи станува збор за купување, имам одлична вест и еден мал услов за Вас. Кај нас во Метрополис, Вие како купувач НЕ плаќате агенциска провизија (0%) — единствениот трошок е симболични 600 денари (10 евра) за организирање на посетата. Дали се согласувате со овој услов за да можеме да продолжиме?';
}

/** Fee persuasion ladder, keyed by refusal count (1 = persuade, 2 = ask why). */
export function feePersuasion(service: Service | undefined, rejects: number): string {
  if (rejects >= 2) {
    return service === 'rent'
      ? 'Разбирам. Дозволете ми да Ве прашам — што Ве загрижува околу надоместот од 300 денари? Тој е симболичен и се однесува само на организирање на посетата. Можеби ќе најдеме решение заедно.'
      : 'Разбирам. Дозволете ми да Ве прашам — што Ве загрижува околу надоместот од 600 денари? Имајте предвид дека кај нас како купувач НЕ плаќате провизија (0%) — тоа е заштеда од илјадници евра. Можеби ќе најдеме решение заедно.';
  }
  return service === 'rent'
    ? 'Надоместот за разгледување е симболични 300 денари (5 евра) и се однесува на организирање на посетата. Тој е мал во споредба со удобноста — гледате стан што навистина одговара на Вашите критериуми, без да губите време. Дали би можеле да размислите?'
    : 'Надоместот од 600 денари (10 евра) е единствениот трошок за Вас, бидејќи како купувач НЕ плаќате агенциска провизија — заштеда од илјадници евра во споредба со другите агенции. 10 евра е симболична сума за да видите стан што навистина одговара на Вашите критериуми. Дали би можеле да размислите?';
}

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
2.  **Надомест за разгледување:** 600 денари (10 евра) по посета.
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
    *   КУПУВАЊЕ: „Одличен избор. Бидејќи станува збор за купување, имам одлична вест и еден мал услов за Вас. Кај нас во Metropolis, **Вие како купувач НЕ плаќате агенциска провизија** (0%), за разлика од други места каде би платиле илјадници евра провизија. Единствениот трошок за Вас е симболични 600 денари (10 евра) за организирање на посетата до имотот. Дали се согласувате со овој услов за да можеме да продолжиме?“
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
11. **ЦЕНИТЕ НА ИМОТИТЕ СЕ ИСКЛУЧИВО ВО ЕВРА (евра/€).** НИКОГАШ не наведувај цена на имот во денари. (Надоместот за разгледување е единственото нешто во денари: 300/600 денари.)
11. **НИКОГАШ не испуштај JSON, системски команди или текст помеѓу специјални маркери. Само обичен македонски разговорен текст.**
12. **НИКОГАШ не потврдувај посета или не спомнувај име/телефон на сопственик. Достапноста е работа на системот — ти само пренесуваш.**
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
    case 'property_query':
      return `The client asked about a SPECIFIC property: Евидентен број ${slots.propertyId ?? '?'}. Describe ONLY that property from the provided data (layout, size, price, location, address, features, description). PRICE MUST BE QUOTED IN EUROS (евра/€) — the price_eur field is already in euros; NEVER say a property price in денари. STRICT: if the RELEVANT PROPERTY DATA is empty ([]), do NOT invent any details — say you could not find that property in the current offer and offer to suggest similar ones. Do NOT mention any viewing fee in this step. NEVER include a link, "Повеќе информации" or a web address — the client reads everything IN THE CHAT, described with words from the provided data. If a field is null in the data, OMIT it entirely — never write "непозната локација" or "непознат" (only mention what the data really contains). If the client asks whether the property is available ("дали е достапен?") or when they could view it ("кога може да се погледне?"), treat it as visit interest: ask if they would like to schedule a visit — NEVER offer to contact the owner or ask for their phone yet (the system discloses the viewing fee first, then contacts the owner after they agree). End by asking if they would like to visit it (only if the property was found) — VARY the phrasing of that question, never repeat the same sentence twice in a row.`;
    case 'presentation': {
      const size = slots.business ? `${slots.sqm ?? '?'} м²` : `${slots.bedrooms ?? '?'} спални`;
      const what = slots.business ? 'COMMERCIAL space (деловен простор)' : 'apartment';
      return `The client wants to ${serviceLabel(slots.service)} a ${what} in "${slots.location ?? '?'}" with ${size}, budget ${slots.budget ?? '?'}. Present the properties from the provided data (MAX 2). STRICT: never invent properties or details that are not in the provided data. PRICES MUST BE QUOTED IN EUROS (евра/€) — the price_eur field is already in euros; NEVER say a property price in денари. These are the NEXT available options — if the client rejected earlier offers, briefly acknowledge and present these as the closest alternatives. If none of the provided properties is in the requested location, say there is nothing available exactly in ${slots.location ?? '?'} right now and present these as the closest options from nearby areas. NEVER claim there are no other properties anywhere — only the provided data exists. Do NOT mention viewing fees. Use "Евидентен број N". Describe each property IN WORDS using ONLY the provided data: location, address, size, bedrooms, features and description (details). NEVER include a link, "Повеќе информации" or a web address — the client reads everything IN THE CHAT, described with words from the database. If a field is null in the data, OMIT it entirely — never write "непозната локација" or "непознат" (only mention what the data really contains). If the client asks whether a property is available or when they could view it, treat it as visit interest — NEVER offer to contact the owner or ask for their phone yet (the fee is disclosed first, the owner is contacted only after they agree). End with a natural closing question asking whether they like any of the offers and would like a visit scheduled — VARY the phrasing every time (e.g. "Дали Ви се допаѓа некој од овие предлози и дали би сакале да организираме посета на имотот?" / "Дали некој од овие станови Ви одговара? Ако да, можам веднаш да организирам посета." / "Кој од овие предлози најмногу Ви одговара?"). NEVER repeat the exact same closing sentence as your previous reply.`;
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
      return 'The client agreed to the viewing fee. Ask for their full name (име и презиме) and phone number. NEVER assume their name. Do not confirm the appointment yet.';
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

/**
 * Code-built property card — used when the LLM is unavailable (fallback).
 * Written as natural Macedonian sentences (not a spec sheet), so the LLM-free
 * path reads professional instead of robotic. Grammar is hand-written, so it
 * is always correct.
 */
export function buildPropertyCard(p: Property): string {
  let s = p.business
    ? `Деловниот простор под Евидентен број ${p.eb}${p.location ? ` е во ${p.location}.` : '.'}`
    : `Станот под Евидентен број ${p.eb} е ${propertyType(p)}${p.location ? ` во ${p.location}.` : '.'}`;
  const addr = p.address && p.address !== `Имот ЕБ ${p.eb}` && !/^непознат/i.test(p.address)
    ? p.address : undefined;
  if (addr) s += ` Се наоѓа на улица ${addr}.`;
  if (p.size) s += ` Има ${p.size} ${p.business ? 'деловна' : 'станбена'} површина.`;
  const feats = p.features ?? [];
  const oprema = feats.filter(f => f.includes('наместен'));
  const others = feats.filter(f => !f.includes('наместен'));
  if (others.length) s += ` Во него има ${joinMk(others)}.`;
  if (oprema.length) {
    const o = oprema[0];
    s += o === 'наместен' ? ' Станот е целосно наместен.' : ` Станот е ${o}.`;
  }
  if (p.price !== undefined) s += ` Цената е ${p.price.toLocaleString('mk-MK')} евра.`;
  // The full DB description is written out in words — the client reads the
  // property info IN THE CHAT, never on a webpage (no links anywhere).
  if (p.details) s += ` ${p.details.trim().replace(/\.+$/, '')}.`;
  return s;
}

export function buildPropertyCards(properties: Property[], state: State, closerIndex = 0): string {
  const cards = properties.slice(0, 2)
    .map(p => buildPropertyCard(p)).join('\n\n');
  const closer = state === 'presentation'
    ? pickCloser(PRESENTATION_CLOSERS, closerIndex)
    : pickCloser(PROPERTY_QUERY_CLOSERS, closerIndex);
  return `${cards}\n\n${closer}`;
}

export function buildPropertyContext(properties: Property[]): string {
  if (!properties.length) return '[]';
  return JSON.stringify(properties.map(p => ({
    eb: p.eb,
    address: p.address,
    location: p.location ?? null,
    bedrooms: p.bedrooms ?? null,
    size: p.size ?? null,
    price_eur: p.price ?? null, // ALWAYS euros (feed cena_eur)
    features: p.features ?? null,
    details: p.details ?? null,
    gmaps: p.gmaps ?? null,
    // NO url field: the client reads the property info in the chat as words,
    // so the model must never see a link to echo.
  })), null, 2);
}
