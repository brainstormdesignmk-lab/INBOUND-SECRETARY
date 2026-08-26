// LLM-assisted bulk generation of Lina's response variants.
//
// GEMINI ONLY — this script must NEVER use Groq (the Groq daily TPD is shared
// with production traffic and the variants are meant to come from one voice).
// When every Gemini key is exhausted it fails with a clear message; the
// code-built fallbacks in the runtime keep working meanwhile. Run again later.
//
// The funnel logic stays code-built and deterministic; these variants are
// DECORATIVE — they only change wording, never behavior. Each key names a
// situation the FSM already reaches, the "source of truth" sentence(s) the
// runtime uses today, and the constraints that keep generated variants
// meaning-equivalent and safe. The persona's own voice rules (first person,
// formal Вие, Macedonian-only, banned flourishes) are re-applied here so the
// generator speaks the same register the runtime already enforces.
//
// Usage: npm run responses:generate   (reads ~/.lina/lina.env via loadConfig)
// Output: src/data/responses.ts  — GENERATED FILE, do not hand-edit. A human
// review pass is expected after each regeneration (the script prints the bank
// and any rejections for exactly that purpose).
//
// Adding a new key later = one entry in SPEC below + rerun.

import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../config';
import { createLlm } from '../llm/factory';
import { LlmClient, CompleteOpts } from '../llm/types';
import { INITIAL_GREETINGS } from '../data/greetings';
import { FALLBACKS, PATIENCE_LINE, buildFeeAsk, feePersuasion, PRESENTATION_CLOSERS, PROPERTY_QUERY_CLOSERS, OFFTOPIC_REDIRECT, FOLLOWUP_DEFER, PRICE_NEGOTIATE, PROVISION_ANSWER, SCHED_FLEX_ANSWER, ESCALATION_ANSWER, DOCUMENTS_ANSWER, MORTGAGE_ANSWER, NEIGHBORHOOD_ANSWER, COMPARISON_ANSWER, FEATURE_ANSWER } from '../llm/prompts';
import { OFFENSE_WARNINGS, STRIKE_1_RESPONSES, STRIKE_2_RESPONSES } from '../antiabuse/strikes';

interface GenerationKey {
  /** Bank key — matches the situation name the picker will use (see src/data/responses.ts). */
  key: string;
  /** The code-built sentence(s) this key replaces. Meaning is anchored to these. */
  sources: string[];
  /** How many variants to ask for per generation call. */
  count: number;
  /** Key-specific instructions: what meaning must be preserved, what must not appear. */
  instructions: string;
  /** Every accepted variant must match ALL of these (meaning anchors — e.g. the
   *  fee amounts and the "Дали се согласувате" question must never be lost). */
  required: RegExp | RegExp[];
  /** Additional per-key banned tokens on top of the global BANNED list. */
  banned?: RegExp[];
  /** Variants must end with '?'. */
  question: boolean;
  /** Placeholders the key uses, e.g. ['location'] for "{location}" — each must
   *  appear exactly once and no other placeholder is allowed. */
  placeholders?: string[];
}

// --- The persona's voice, restated for the generator -------------------------
const VOICE_SYSTEM = `
Ти генерираш варијанти на пораки за Лина, продажен асистент во агенцијата за недвижности Metropolis.

ГЛАС (СТРОГО):
- САМО прво лице — „Јас“. Никогаш трето лице („Лина ќе...“, „таа ќе...“).
- Секогаш формално обраќање „Вие“ со голема буква: „Вие“, „Ваш“, „Ви“, „Ве“, „Вас“. НИКОГАШ неформално „ти“/„тебе“/„твој“/„твое“.
- ИСКЛУЧИВО македонски јазик — оригинален, точен, без туѓи зборови (не руски, не српски, не бугарски, не англиски), без мешање кирилица и латиница во ист збор.
- Природен, разговорен тон во целосни реченици — без роботски листи, без загради-објаснувања.

ЗАБРАНИ:
- Никогаш не започнувај со „Почит“ или „Почитувани“.
- Никогаш не користи „Супер. Уште неколку прашања.“ или „Одлично, уште последниве информации и завршуваме.“
- Никогаш линкови, никогаш „ID“/„ИД“.
- Никакви факти за имоти, цени или надомести — не измислувај податоци.

ИЗЛЕЗ:
- Одговори ИСКЛУЧИВО со JSON низа од стрингови — без markdown, без коментар, без објаснувања.
- Секоја варијанта: исто значење, иста формалност, природна варијација (различен почеток, различен редослед на зборови, различни синоними). Не заменувај само еден збор во иста реченица.
`.trim();

// First batch: greeting + patience + no-match (both the location and plain form).
// More keys come in later batches — one entry each, then rerun.
const SPEC: GenerationKey[] = [
  {
    key: 'greeting',
    sources: INITIAL_GREETINGS,
    count: 20,
    instructions: 'Поздрав + претставување (Јас сум Лина) + прашање дали клиентот бара купување или изнајмување.',
    required: /(?:куп|изнајм|кириј)/iu,
    question: true,
  },
  {
    key: 'patience.line',
    sources: [PATIENCE_LINE],
    count: 15,
    instructions: 'Клиентот пишува додека Лина го проверува сопственикот — кратко, трпеливо соопштение дека го контактира сопственикот и ќе извести штом добие одговор. БЕЗ прашање, БЕЗ ветување на посета, БЕЗ спомнување на надомест.',
    required: /(?:сопственик|достапност|известам|одговор|контактирам)/iu,
    question: false,
  },
  // availability.ack: the client asks about a KNOWN property's availability
  // ("дали е сеуште достапен?") — he saw the ad on the website, so Lina does
  // NOT re-describe it. She answers that it should still be available / exists
  // in the database and ASKS if the client wants her to contact the owner.
  // The fee is NOT disclosed yet — it comes AFTER the client confirms.
  // Must end with a QUESTION ("Дали сакате…?").
  {
    key: 'availability.ack',
    sources: [
      'Би требало да е сеуште достапен. Дали сакате да Ве поврзам со сопственикот за да ги потврдиме моменталната достапност и цената?',
      'Сеуште постои во нашата база на податоци. Дали би сакале да контактирам со сопственикот за да ја потврдиме достапноста и цената?',
    ],
    count: 12,
    instructions: 'Клиентот прашува дали конкретен имот (чиј Евидентен број го знае од огласот) е сеуште достапен — одговори дека би требало да е достапен / сеуште постои во базата, па ПРАШАЈ дали сакаат да контактираш со сопственикот. Мора да заврши со ПРАШАЊЕ (Дали сакате…? / Дали би сакале…?). БЕЗ износи, БЕЗ надомест, БЕЗ спомнување на стан/куќа/деловен простор, БЕЗ Евидентен броеви. Природен, смирувачки тон. Варирај го воведот (Би требало / Според нашата база / Имотот постои / …) и прашањето (Дали сакате да Ве поврзам / Дали би сакале да контактирам / Дали сакате да стапам во контакт).',
    required: [/(?:достапен|достапна|достапно|постои|база|слободен|слободна|активен|активна|на располагање|понуда)/iu, /\?$/u],
    banned: [/\d/, /Евидентен|ID|ИД/, /евра|денари/, /надомест/, /стан|куќ|деловен|апартман/],
    question: true,
  },
  // property.liked: enthusiasm + visit offer — the client expressed interest
  // in a SPECIFIC property ("mi se svigja 89", "mi fati oko 94", "go sakam")
  // or asked about it by EB. Acknowledge the choice, OFFER a visit. The fee
  // comes LATER (after 'да') — never here.
  {
    key: 'property.liked',
    sources: [
      'Одличен избор! Дали би сакале да организирам посета, за да го погледнете во живо?',
      'Мило ми е што Ви се допаѓа! Дали би сакале да закажеме термин за разгледување?',
    ],
    count: 12,
    instructions: 'Клиентот покажа интерес за КОНКРЕТЕН имот (им го дал Евидентениот број или кажа дека му се допаѓа / го забележал од огласот). ПОТВРДИ го изборот позитивно (Одличен избор / Мило ми е што Ви се допаѓа / Супер избор), па ПРАШАЈ дали сакаат да организираш посета / закажеш термин за разгледување. Мора да заврши со ПРАШАЊЕ. БЕЗ износи, БЕЗ надомест, БЕЗ детали за имотот (квадрати/кат/населба), БЕЗ Евидентен броеви. Топол, ентузијастички но професионален тон.',
    required: [/(?:посета|разгледување|термин|погледнете|видите)/iu, /\?$/u],
    banned: [/\d/, /евра|денари/, /надомест/, /провизи/],
    question: true,
  },
  // address.exact: the client asks for the EXACT street/address ("потoчно која
  // улица?", "точно која адреса?", "на која адреса е?") — address PRIVACY is
  // absolute: the exact address is revealed ONLY 2 hours before the arranged
  // visit (the system sends it), never in chat. Answer WITHOUT the street,
  // WITHOUT a question, WITHOUT a promise of "сега" — just the reveal time.
  {
    key: 'address.exact',
    sources: [
      'Точната адреса ќе ја добиете 2 часа пред посетата.',
      'Точната локација ќе ја дознаете на денот на посетата.',
      'Системот на откривање на точната локација на денот на посетата е правило по кое функционира Агенцијата.',
    ],
    count: 10,
    instructions: 'Клиентот ја бара ТОЧНАТА адреса/улица на имотот — адресата е тајна: откриј САМО кога ќе ја добие (2 часа пред посетата / на денот на посетата / непосредно пред самата посета). Клиентот може да биде упорен ("moram da znam kade e", "moram da znam za da se odlucam") — тогаш објасни дека тоа е ПРАВИЛО НА АГЕНЦИЈАТА. БЕЗ улица, БЕЗ број, БЕЗ населба, БЕЗ прашање, БЕЗ извинување. Варирај го воведот (Точната адреса / Адресата / Прецизната локација / Точната локација / Системот) и изразот (ќе ја добиете / ќе ја дознаете / ќе Ви ја испратам / ќе ја споделам / е правило по кое функционира Агенцијата).',
    required: /(?:адреса|локаци|ulica)/iu,
    banned: [/(?:улица\s+[А-ЯA-Z]|ул\.)/iu, /\d{1,3}\s*[а-яА-Я]?\s*(?:бр|број)/iu, /прашање|дали/i],
    question: false,
  },
  {
    key: 'no.match.location',
    sources: ['За жал, моментално немам слободни имоти во {location} што одговараат на Вашите критериуми. Дали сте отворени за други локации?'],
    count: 15,
    instructions: 'Нема слободни имоти во бараната населба — извинување + прашање дали е отворен за други локации. Задржи го {location} буквално, на истото место во реченицата.',
    required: /(?:жал|немам|слободни)/iu,
    question: true,
    placeholders: ['location'],
  },
  {
    key: 'no.match.plain',
    sources: ['За жал, моментално немам слободни имоти што одговараат на Вашите критериуми. Дали би сакале да разгледаме други опции?'],
    count: 15,
    instructions: 'Нема слободни имоти што одговараат на критериумите — извинување + прашање дали би сакале да разгледаме други опции.',
    required: /(?:жал|немам|слободни)/iu,
    question: true,
  },
  // --- batch 2: more fallback states + fee/closers/warnings -----------------
  {
    key: 'fallback.discovery',
    sources: [FALLBACKS.discovery],
    count: 12,
    instructions: 'Клиентот е во фаза на разјаснување — прашај ги критериумите што недостасуваат (дел од градот, спални соби, буџет). БЕЗ цени, БЕЗ надомест, БЕЗ имот.',
    required: /(?:кој дел|спални|цена|буџет|локаци)/iu,
    question: true,
  },
  {
    key: 'fallback.presentation',
    sources: [FALLBACKS.presentation],
    count: 12,
    instructions: 'Подготвени се предлози што одговараат на критериумите — прашај дали би сакале посета на некој од нив. БЕЗ цени, БЕЗ надомест, БЕЗ конкретни Евидентен броеви.',
    required: /(?:посета|предлози|организираме|одговара)/iu,
    question: true,
  },
  {
    key: 'fee.ask.buy',
    sources: [buildFeeAsk('buy')],
    count: 12,
    instructions: 'Купување — откриј го надоместот за разгледување: 500 денари (10 евра), нагласи дека купувачот НЕ плаќа провизија (0%), и прашај дали се согласува. Задржи ги ТОЧНИТЕ износи.',
    required: [/500\s*денари/i, /(?:не плаќате|0\s*%|провизиј)/i, /Дали се согласувате/],
    question: true,
  },
  {
    key: 'fee.ask.rent',
    sources: [buildFeeAsk('rent')],
    count: 12,
    instructions: 'Изнајмување — откриј го надоместот за разгледување: 300 денари (5 евра), и прашај дали се согласува. Задржи ги ТОЧНИТЕ износи.',
    required: [/300\s*денари/i, /Дали се согласувате/],
    question: true,
  },
  {
    key: 'fee.persuade.1.buy',
    sources: [feePersuasion('buy', 1)],
    count: 10,
    instructions: 'Клиентот го одби надоместот прв пат (купување) — убеди со вредност: 500 денари (10 евра) е единствениот трошок, купувачот НЕ плаќа провизија (0%). Задржи ги ТОЧНИТЕ износи.',
    required: [/500\s*денари/i, /(?:не плаќате|0\s*%|провизиј)/i, /(?:размислите|би можеле|вредност)/i],
    question: true,
  },
  {
    key: 'fee.persuade.1.rent',
    sources: [feePersuasion('rent', 1)],
    count: 10,
    instructions: 'Клиентот го одби надоместот прв пат (изнајмување) — убеди со вредност: 300 денари (5 евра) е симболичен. Задржи ги ТОЧНИТЕ износи.',
    required: [/300\s*денари/i, /(?:размислите|би можеле|вредност)/i],
    question: true,
  },
  {
    key: 'fee.persuade.2.buy',
    sources: [feePersuasion('buy', 2)],
    count: 10,
    instructions: 'Клиентот го одби надоместот ВТОР пат (купување) — престани со продажба, прашај што го загрижува околу 500 денари, потсети на 0% провизија, понуди решение заедно.',
    required: [/500\s*денари/i, /загрижува/, /(?:не плаќате|0\s*%|провизиј)/i],
    question: true,
  },
  {
    key: 'fee.persuade.2.rent',
    sources: [feePersuasion('rent', 2)],
    count: 10,
    instructions: 'Клиентот го одби надоместот ВТОР пат (изнајмување) — престани со продажба, прашај што го загрижува околу 300 денари, понуди решение заедно.',
    required: [/300\s*денари/i, /загрижува/],
    question: true,
  },
  // fee.why: the client asks WHY the visit fee exists ("зошто наплаќате
  // посета?", "зошто надомест?", "никој не го прави тоа") in closing — a
  // QUESTION, not a refusal. Lina ANSWERS with the agency's rationale: the
  // fee is the agency's FILTER that recognizes REAL clients; for a serious
  // client it is symbolic; it enables quality and selective service for
  // genuinely interested clients. Ends with the agreement question so the
  // funnel keeps moving. Deliberately service-agnostic and amount-free: the
  // exact sum (500/300 денари) was already disclosed in the fee.ask — this
  // line explains the WHY, it never re-states the price or the 0% commission.
  {
    key: 'fee.why',
    sources: [
      'Надоместот за посета е филтер на агенцијата со кој ги препознаваме вистинските клиенти. За сериозен клиент тој е симболичен — вака функционира нашата агенција: симболична цена со која се овозможува квалитетна и селективна услуга за навистина заинтересираните клиенти. Дали се согласувате со овој услов за да продолжиме?',
      'Посетата ја наплаќаме затоа што надоместот е филтер со кој ги препознаваме вистинските клиенти. За сериозен клиент тој е чисто симболичен и обезбедува квалитетна, селективна услуга за навистина заинтересираните. Дали се согласувате со овој услов?',
    ],
    count: 10,
    instructions: 'Клиентот прашува ЗОШТО се наплаќа посетата („зошто наплаќате посета?“, „зошто надомест?“, „никој не го прави тоа“) — одговори со образложение: надоместот е филтер на агенцијата со кој се препознаваат вистинските клиенти; за сериозен клиент е симболичен и овозможува квалитетна и селективна услуга за навистина заинтересираните клиенти. Природен, уверлив, неодбранбен тон. Заврши со прашање дали се согласува. БЕЗ износи, БЕЗ провизија, БЕЗ спомнување на стан/куќа/деловен простор, БЕЗ Евидентен броеви.',
    required: [/(?:филтер|филтрираме|филтрира|препознава|препознаеме|препознаваат|препознаваме|издвојуваме|одвојуваме|избираме|одбираме|разликуваме)/iu, /(?:симболич)/iu, /(?:квалитетн|квалитет|селективн|селекци)/iu, /(?:Дали се согласувате|Дали го прифаќате|Дали би прифатиле|Дали ова Ви одговара|Дали Ви одговара|Дали може да се согласиме|Дали сте согласни|Дали се согласуваме)/],
    banned: [/\d/, /евра|денари/, /провизиј/, /купувач|кираџи|станар/, /Евидентен|ID|ИД/],
    question: true,
  },
  // fee.pivot.neighborhood: the client pushes back on the viewing fee
  // ("зошто наплаќате посета?", "никoj не го прави тоа", "не сакам да
  // платам") — instead of pushing the fee, Lina OFFERS the remaining
  // properties in OTHER neighborhoods ("if available"). This is a DECLARATIVE
  // lead-in: it acknowledges the pushback and offers alternatives — the
  // property cards and the pick-closer follow in the NEXT lines (code-built,
  // like every presentation). No question mark (the closer asks), no amounts,
  // no fee rationale, no concrete properties or neighborhoods (the cards
  // carry those).
  {
    key: 'fee.pivot.neighborhood',
    sources: [
      'Разбирам. Доколку сакате, можам да Ви понудам и други имоти во други населби — еве што имам:',
      'Во ред, целосно Ве разбирам. Можам да Ви покажам и други опции во други делови од градот:',
    ],
    count: 10,
    instructions: 'Клиентот се противи на надоместот за посета („зошто наплаќате посета?“, „никој не го прави тоа“) — наместо да инсистираш на надоместот, понуди му други имоти во ДРУГИ населби (самите алтернативи следат во следната порака, НЕ ги именувај тука). Соопштение кое најпрво покажува разбирање (Разбирам / Во ред / Се извинете / Јас Ве разбирам...), па понуда да погледне други опции во друга населба / друг дел од градот. Природен, ненаметлив, топол тон. БЕЗ прашалник — линијата завршува со две точки (:). БЕЗ износи, БЕЗ зборот надомест, БЕЗ провизија, БЕЗ Евидентен броеви, БЕЗ имиња на конкретни населби, БЕЗ конкретни имоти, БЕЗ спомнување на стан/куќа/деловен простор.',
    required: [/(?:друга населба|други населби|друг дел од градот|други делови од градот|друга локаци|други опции|други имоти|други понуди|останатите делови|останати делови|останати населби)/iu, /(?:понудам|покажам|предложам|погледнеме|разгледаме|издвоив|издвојам|подготвив|подготвам|понудив|сподел)/iu],
    banned: [/\d/, /евра|денари/, /надомест/, /провизиј/, /Евидентен|ID|ИД/, /улиц|булевар|бул\./],
    question: false,
  },
  // presentation.open: the LLM-free path's property cards need the SAME
  // descriptive framing the LLM gives ("За Вас ги издвоив…") — a short opener
  // in front of the cards, bank-backed so it varies. Generic on purpose: it
  // must work for ANY batch (the alternatives may span areas), so no
  // {location} and no property facts.
  {
    key: 'presentation.open',
    sources: [
      'За Вас ги издвоив следните опции што би можеле да Ви одговараат:',
      'Ви подготвив неколку предлози кои одговараат на Вашите критериуми:',
    ],
    count: 15,
    instructions: 'КРАТОК вовед во една реченица пред презентацијата на предлози — најави дека си издвоила/подготвила опции што би можеле да одговараат на неговите барања. БЕЗ цени, БЕЗ Евидентен броеви, БЕЗ надомест, БЕЗ имиња на населби, БЕЗ спомнување на стан/куќа/деловен простор. Природен, течен вовед.',
    required: /(?:издвоив|подготвив|понудив|предложив|опции|предлози|понуда)/iu,
    banned: [/\d/, /Евидентен|ID|ИД/, /евра|денари/, /стан|куќ|деловен|апартман/],
    question: false,
  },
  // presentation.open.anywhere: the client searched "било каде" (anywhere)
  // with a budget — the city-wide presentation needs a DESCRIPTIVE opener
  // naming the budget ({budget} placeholder) and the popular-neighborhood
  // ordering, so the LLM-free path reads like a real offering, not a bare
  // card list. The cards and the pick-closer follow in the NEXT lines.
  {
    key: 'presentation.open.anywhere',
    sources: [
      'Еве избор на станови до {budget} евра, почнувајќи од најбараните населби:',
      'Подготвив опции до {budget} евра — почнуваме од најпопуларните населби во Скопје:',
    ],
    count: 12,
    instructions: 'Клиентот бара имот НАСЕКАДЕ („било каде") со буџет {budget} евра — краток вовед пред презентацијата: најави избор на опции до {budget} евра, почнувајќи од најбараните/најпопуларните населби. Задржи го {budget} буквално, на истото место во реченицата. БЕЗ прашалник, БЕЗ цени, БЕЗ Евидентен броеви, БЕЗ надомест, БЕЗ имиња на конкретни населби, БЕЗ спомнување на стан/куќа/деловен простор, БЕЗ улици. Природен, течен вовед.',
    required: [/{budget}/, /(?:најбарани|најпопуларни|популарни|бараните)/iu, /(?:населб|делови од градот|локации)/iu],
    banned: [/\d{2,}/, /Евидентен|ID|ИД/, /денари/, /надомест/, /стан|куќ|деловен|апартман/, /улиц|булевар|бул\./],
    question: false,
    placeholders: ['budget'],
  },
  {
    key: 'closer.presentation',
    sources: PRESENTATION_CLOSERS,
    count: 15,
    instructions: 'Завршно прашање по презентација на предлози — дали некој им се допаѓа и дали да организираме посета. БЕЗ цени, БЕЗ надомест, БЕЗ Евидентен броеви.',
    required: /(?:посета|организираме|одговара|допаѓа)/iu,
    question: true,
  },
  {
    key: 'closer.property_query',
    sources: PROPERTY_QUERY_CLOSERS,
    count: 12,
    instructions: 'Завршно прашање по опис на конкретен имот — дали им одговара и дали да организираме посета. БЕЗ цени, БЕЗ надомест, БЕЗ Евидентен броеви.',
    required: /(?:посета|организираме|одговара|допаѓа|разгледате)/iu,
    question: true,
  },
  {
    key: 'warn.1',
    sources: [...STRIKE_1_RESPONSES, OFFENSE_WARNINGS[1]],
    count: 8,
    instructions: 'ПРВА опомена за навредлив речник — официјален, формален тон, задржи го обраќањето „Господине“ и барањето да останеме професионални/пристојни. БЕЗ прашалник.',
    required: [/господине/i, /(?:професионалн|пристоен|културен|ве молам)/i],
    question: false,
  },
  {
    key: 'warn.2',
    sources: [...STRIKE_2_RESPONSES, OFFENSE_WARNINGS[2]],
    count: 8,
    instructions: 'ВТОРА (последна) опомена — официјален тон, задржи го обраќањето „Господине“, предупреди дека ова е последното предупредување пред прекинување на разговорот. БЕЗ прашалник.',
    required: [/господине/i, /(?:последна опомена|за последен пат|последното предупредување)/i],
    question: false,
  },
  // --- batch 3: deterministic ask builders (discovery intro, contact ask) --
  // greeting.open fires when the client opens with NO criteria at all ("zdravo")
  // — the property type is UNKNOWN, so these must never assume an apartment
  // (banned tokens enforce it) and must not self-introduce.
  {
    key: 'greeting.open',
    sources: [
      'Повелете. Дали Ве интересира купување или изнајмување на имот?',
      'Здраво. Ќе купувате нешто, или сакате да изнајмите?',
    ],
    count: 12,
    instructions: 'Клиентот само се поздрави („здраво“) без никакви критериуми — типот на имот е НЕПОЗНАТ. Поздрав + прашање дали бара купување или изнајмување. БЕЗ спомнување на стан, куќа, деловен простор или апартман; БЕЗ претставување по име. Почни со Здраво / Повелете / Добар ден / Добредојдовте.',
    required: [/^(?:Здраво|Добар ден|Добредојдовте|Повелете)/, /(?:куп|изнајм|кириј)/iu],
    banned: [/стан/, /куќ/, /деловен/, /апартман/],
    question: true,
  },
  {
    key: 'discovery.intro.house',
    sources: ['Здраво! За да Ви најдам најсоодветна куќа, ве молам кажете ми неколку детали.'],
    count: 10,
    instructions: 'Поздрав-вовед (КУЌА) — не прашувај ништо, најави дека ќе најдеш соодветна куќа и побарај неколку детали. БЕЗ прашалник, БЕЗ прашања.',
    required: /куќ/,
    question: false,
  },
  {
    key: 'discovery.intro.business',
    sources: ['Здраво! За да Ви најдам најсоодветен деловен простор, ве молам кажете ми неколку детали.'],
    count: 10,
    instructions: 'Поздрав-вовед (ДЕЛОВЕН ПРОСТОР) — не прашувај ништо, најави дека ќе најдеш соодветен деловен простор и побарај неколку детали. БЕЗ прашалник, БЕЗ прашања.',
    required: /деловен/,
    question: false,
  },
  // --- batch 4: the DISCOVERY QUESTIONS (no recap — just the missing ask, varied)
  // The recap ("Разбрав — барате …") was removed as robotic repetition; each
  // question now varies from the bank. Per-type keys so the wording always
  // carries the right property word (станот/куќата/деловниот) and never leaks
  // the other type (banned tokens enforce it).
  {
    key: 'discovery.ask.service.stan',
    sources: ['Дали станот го барате за купување или за изнајмување?'],
    count: 10,
    instructions: 'Прашај дали СТАНОТ е за купување или за изнајмување. НИКАКО не спомнувај куќа или деловен простор.',
    required: [/стан/, /(?:куп|изнајм|кириј)/iu],
    banned: [/куќ|деловен/],
    question: true,
  },
  {
    key: 'discovery.ask.service.house',
    sources: ['Дали куќата ја барате за купување или за изнајмување?'],
    count: 10,
    instructions: 'Прашај дали КУЌАТА е за купување или за изнајмување. НИКАКО не спомнувај стан или деловен простор.',
    required: [/куќ/, /(?:куп|изнајм|кириј)/iu],
    banned: [/стан|деловен/],
    question: true,
  },
  {
    key: 'discovery.ask.service.business',
    sources: ['Дали го барате за купување или за изнајмување?'],
    count: 10,
    instructions: 'Прашај дали ДЕЛОВНИОТ ПРОСТОР е за купување или за изнајмување. НИКАКО не спомнувај стан или куќа.',
    required: /(?:куп|изнајм|кириј)/iu,
    banned: [/стан|куќ/],
    question: true,
  },
  {
    key: 'discovery.ask.location.stan',
    sources: ['Во кој дел од градот го барате станот?'],
    count: 10,
    instructions: 'Прашај во кој дел од градот го бара СТАНОТ. НИКАКО не спомнувај куќа или деловен простор.',
    required: [/стан/, /(?:дел од градот|населба|локаци)/iu],
    banned: [/куќ|деловен/],
    question: true,
  },
  {
    key: 'discovery.ask.location.house',
    sources: [
      'Во кој дел од градот ја барате куќата?',
      'Дали може да знам во кој дел од градот ја барате куќата?',
      'Кажете ми во кој дел од градот ја барате куќата?',
      'Дали имате дефинирано во која населба да биде куќата?',
    ],
    count: 12,
    instructions: 'Прашај во кој дел од градот / во која населба ја бара КУЌАТА — варирај го воведот (Дали може да знам… / Кажете ми… / Дали имате дефинирано…). НИКАКО не спомнувај стан или деловен простор.',
    required: [/куќ/, /(?:дел од градот|населба|локаци)/iu],
    banned: [/стан|деловен/],
    question: true,
  },
  {
    key: 'discovery.ask.location.business',
    sources: ['Во кој дел од градот го барате?'],
    count: 10,
    instructions: 'Прашај во кој дел од градот го бара ДЕЛОВНИОТ ПРОСТОР. НИКАКО не спомнувај стан или куќа.',
    required: /(?:дел од градот|населба|локаци)/iu,
    banned: [/стан|куќ/],
    question: true,
  },
  {
    key: 'discovery.ask.bedrooms.stan',
    sources: ['Колку спални соби би сакале да има станот?'],
    count: 10,
    instructions: 'Прашај колку спални соби треба да има СТАНОТ. НИКАКО не спомнувај куќа или деловен простор.',
    required: [/спални/, /стан/],
    banned: [/куќ|деловен/],
    question: true,
  },
  {
    key: 'discovery.ask.bedrooms.house',
    sources: ['Колку спални соби би сакале да има куќата?'],
    count: 10,
    instructions: 'Прашај колку спални соби треба да има КУЌАТА. НИКАКО не спомнувај стан или деловен простор.',
    required: [/спални/, /куќ/],
    banned: [/стан|деловен/],
    question: true,
  },
  {
    key: 'discovery.ask.sqm.business',
    sources: ['Која површина (во м²) ја барате?'],
    count: 10,
    instructions: 'Прашај колку квадрати (површина во м²) треба да има ДЕЛОВНИОТ ПРОСТОР. НИКАКО не спомнувај стан или куќа.',
    required: /(?:површина|м²|m²|квадрат)/iu,
    banned: [/стан|куќ|спални/],
    question: true,
  },
  {
    key: 'discovery.ask.budget.stan',
    sources: ['До која цена го барате станот?'],
    count: 10,
    instructions: 'Прашај до која цена го бара СТАНОТ. НИКАКО не спомнувај куќа или деловен простор.',
    required: [/стан/, /(?:цена|евра)/iu],
    banned: [/куќ|деловен/],
    question: true,
  },
  {
    key: 'discovery.ask.budget.house',
    sources: ['До која цена ја барате куќата?'],
    count: 10,
    instructions: 'Прашај до која цена ја бара КУЌАТА. НИКАКО не спомнувај стан или деловен простор.',
    required: [/куќ/, /(?:цена|евра)/iu],
    banned: [/стан|деловен/],
    question: true,
  },
  {
    key: 'discovery.ask.budget.business',
    sources: ['До која цена го барате?'],
    count: 10,
    instructions: 'Прашај до која цена го бара ДЕЛОВНИОТ ПРОСТОР. НИКАКО не спомнувај стан или куќа.',
    required: /(?:цена|евра)/iu,
    banned: [/стан|куќ/],
    question: true,
  },
  {
    key: 'discovery.ask.budget.rent',
    sources: ['До колку евра месечна кирија би Ви одговарала?'],
    count: 10,
    instructions: 'Клиентот бара СТАН ПОД КИРИЈА — прашај до колку евра месечна кирија би му одговарала (месечен износ, не куповна цена). НИКАКО не спомнувај куќа или деловен простор; НИКАКО не прашувај „до која цена" (тоа е за купување).',
    required: [/кириј/, /(?:евра|евро)/iu],
    banned: [/куќ|деловен/, /куп/],
    question: true,
  },
  {
    key: 'contact.ask.name',
    sources: ['За да можам веднаш да стапам во контакт со сопственикот, ве молам да ми го кажете Вашето име и презиме.'],
    count: 10,
    instructions: 'Побарај САМО име и презиме (телефонот на клиентот веќе е познат). НИКАКО не спомнувај телефон, тел., број. БЕЗ прашалник.',
    required: [/име и презиме/],
    banned: [/телефон|тел\.|број/],
    question: false,
  },
  {
    key: 'contact.ask.name.phone',
    sources: ['За да можам веднаш да стапам во контакт со сопственикот, ве молам да ми го кажете Вашето име и презиме, како и телефонски број за контакт.'],
    count: 10,
    instructions: 'Побарај име и презиме И телефонски број за контакт. БЕЗ прашалник.',
    required: [/име и презиме/, /телефон/],
    question: false,
  },
  // --- exhausted.ask: the selected area(s) are DRAINED — every matching
  // property was shown, so Lina ASKS whether to look in a DIFFERENT area (or
  // register the criteria). The client's next pure agreement widens the search
  // (the area lock releases). The line must never name concrete properties.
  // Two forms: {location} (the area that was searched) and plain (no area was
  // ever fixed). Semantics anchored: (1) exhausted meaning, (2) the offer to
  // look in another neighborhood, (3) the register-and-contact alternative.
  {
    key: 'exhausted.location',
    sources: ['Ги исцрпивме сите расположливи имоти што одговараат на Вашите критериуми во {location}. Можам да ги забележам Вашите барања и да Ве контактирам штом се појави соодветен имот, или да погледнеме во друга населба?'],
    count: 12,
    instructions: 'Сите имоти што одговараат на барањата во {location} се веќе прикажани — извести дека ги исцрпивме опциите во таа населба и понуди ДВЕ можности: (1) да ги забележи барањата и да го контактираат штом се појави соодветен имот, ИЛИ (2) да погледне во друга населба / друг дел од градот. Задржи го {location} буквално, на истото место во реченицата. Природен, разговорен тон. БЕЗ Евидентен броеви, БЕЗ цени, БЕЗ надомест, БЕЗ имиња на конкретни имоти, БЕЗ улици, БЕЗ име на населба освен {location}.',
    // The three required tokens are deliberately WIDE: the LLM rephrases
    // naturally ("прегледавме" / "погледнавме" / "искористивме" for the
    // exhausted meaning; "сочувам" / "запишам" / "известам" for the
    // register-and-contact offer) — a narrow list rejects 9/12 good variants.
    required: [/(?:исцрпивме|исцрпени|исцрпани|немаме|нема повеќе|прикажавме|прегледавме|погледнавме|изгледавме|искористивме|искористени|поминавме|покажавме|изложивме|изложени|разгледавме)/iu, /(?:друга населба|друг дел од градот|друга локаци|други населби|некаде на друго место)/iu, /(?:забележам|запишам|зачувам|сочувам|евидентирам|регистрирам|контактирам|известам|бележам)/iu],
    banned: [/\d/, /Евидентен|ID|ИД/, /евра|денари/, /надомест/, /улиц|булевар|бул\./, /стан|куќ|деловен|апартман/],
    question: true,
    placeholders: ['location'],
  },
  {
    key: 'exhausted.plain',
    sources: ['Ги исцрпивме сите расположливи имоти што одговараат на Вашите критериуми. Можам да ги забележам Вашите барања и да Ве контактирам штом се појави соодветен имот, или да погледнеме во друга населба?'],
    count: 12,
    instructions: 'Сите имоти што одговараат на барањата се веќе прикажани (без спомнување на населба) — извести дека ги исцрпивме опциите и понуди ДВЕ можности: (1) да ги забележи барањата и да го контактираат штом се појави соодветен имот, ИЛИ (2) да погледне во друга населба / друг дел од градот. Природен, разговорен тон. БЕЗ Евидентен броеви, БЕЗ цени, БЕЗ надомест, БЕЗ имиња на конкретни имоти, БЕЗ улици, БЕЗ имиња на населби.',
    required: [/(?:исцрпивме|исцрпени|исцрпани|немаме|нема повеќе|прикажавме|прегледавме|погледнавме|изгледавме|искористивме|искористени|поминавме|покажавме|изложивме|изложени|разгледавме)/iu, /(?:друга населба|друг дел од градот|друга локаци|други населби|некаде на друго место)/iu, /(?:забележам|запишам|зачувам|сочувам|евидентирам|регистрирам|контактирам|известам|бележам)/iu],
    banned: [/\d/, /Евидентен|ID|ИД/, /евра|денари/, /надомест/, /улиц|булевар|бул\./, /стан|куќ|деловен|апартман/],
    question: true,
  },
  // --- batch 5: new scenario responders ----------------------------------------
  {
    key: 'offtopic.redirect',
    sources: [OFFTOPIC_REDIRECT],
    count: 10,
    instructions: 'Клиентот прашува за Лина, за времето, за нешто што НЕ е поврзано со имоти — пренасочи го кон темата: концентрирана си на имоти, кажи му дали бара купување или изнајмување. Природен, топол тон. БЕЗ прашалник за „кој си ти?" — одговори и пренасочи.',
    required: [/(?:имот|купување|изнајмување|недвижност|помош|а?генци)/iu, /(?:концентри|фокусиран|посветен|сосредоточен|专注于)/iu],
    banned: [/\d/, /Евидентен|ID|ИД/, /евра|денари/, /надомест/],
    question: true,
  },
  {
    key: 'followup.defer',
    sources: [FOLLOWUP_DEFER],
    count: 10,
    instructions: 'Клиентот вели ќе размисли, ќе се јави подоцна, не сега — потврди разбирање и понуди евидентирање на барањата за подоцнежен контакт. Природен, ненаметлив тон. БЕЗ притисок, БЕЗ повторување на понудата.',
    required: [/(?:разбира|разбирам|вас|ќе\s+контактирам|ќе\s+вас|евидентира|запишам|барања)/iu],
    banned: [/\d/, /Евидентен|ID|ИД/, /надомест/, /провизиј/],
    question: false,
  },
  {
    key: 'price.negotiate',
    sources: [PRICE_NEGOTIATE],
    count: 10,
    instructions: 'Клиентот бара помала цена, попуст, пополошка — цената ја одредува сопственикот, понуди да го контактираш за да го пренесеш прашањето. Природен, ненаметлив тон. БЕЗ конкретни бројки, БЕЗ ветување дека ќе намали.',
    required: [/(?:сопственик|одредува|контактирам|прашам|пренесам|проверам)/iu],
    banned: [/\d/, /Евидентен|ID|ИД/, /надомест/, /провизиј/],
    question: true,
  },
  {
    key: 'provision.ask',
    sources: [PROVISION_ANSWER],
    count: 10,
    instructions: 'Клиентот прашува за провизија / комисиона / надомест за агенција — објасни дека провизијата за купувачот е 0% и дека единствен трошок е надоместот за посета (500 денари купување, 300 изнајмување). Задржи ги ТОЧНИТЕ износи.',
    required: [/0\s*%|нула\s+процент/i, /500\s*денари/i, /300\s*денари/i],
    banned: [/Евидентен|ID|ИД/],
    question: false,
  },
  {
    key: 'scheduling.flex',
    sources: [SCHED_FLEX_ANSWER],
    count: 10,
    instructions: 'Клиентот бара викенд, само попладне,утро — потврди дека ќе провериш и побарај конкретен ден и час. Природен, флексибилен тон. БЕЗ ветување дека е можно — само „ќе проверам".',
    required: [/(?:проверам|проверка|можност|термин|ден|час)/iu],
    banned: [/\d{4,}/, /Евидентен|ID|ИД/, /надомест/],
    question: true,
  },
  {
    key: 'escalation.polite',
    sources: [ESCALATION_ANSWER],
    count: 10,
    instructions: 'Клиентот бара менаџер / управител / шеф — потврди дека ќе го поврзиш со менаџерот кој ќе контактира. Природен, смирувачки тон. БЕЗ оправдување, БЕЗ објаснување зошто.',
    required: [/(?:менаџер|управител|предпоставен|контактира|поврзам)/iu],
    banned: [/\d/, /Евидентен|ID|ИД/, /надомест/],
    question: false,
  },
  {
    key: 'documents.info',
    sources: [DOCUMENTS_ANSWER],
    count: 10,
    instructions: 'Клиентот прашува за документи потребни за купување / изнајмување — наброј ги основните: лична карта, преддоговор, потврда од банка (за кредит), уплата резервација. За изнајмување: лична карта + потврда примања. БЕЗ правни совети, БЕЗ конкретни износи.',
    required: [/(?:лична\s+карта|пасош|преддоговор|банка|резервац)/iu],
    banned: [/Евидентен|ID|ИД/],
    question: false,
  },
  {
    key: 'mortgage.info',
    sources: [MORTGAGE_ANSWER],
    count: 10,
    instructions: 'Клиентот спомнува кредит / хипотека / банка — упати го на банка за услови и одобрување, нагласи дека агенцијата обезбедува документи за имотот. БЕЗ финансиски совети, БЕЗ конкретни износи.',
    required: [/(?:банка|кредит|документи|имот|консулти)/iu],
    banned: [/Евидентен|ID|ИД/, /надомест/, /провизиј/],
    question: false,
  },
  {
    key: 'neighborhood.general',
    sources: [NEIGHBORHOOD_ANSWER],
    count: 10,
    instructions: 'Клиентот прашува за населби — одговори неутрално дека сите имаат предности и пренасочи кон критериуми: близина до центар, тивко, пристапна цена. БЕЗ конкретни населби во одговорот (освен во прашањето), БЕЗ цени.',
    required: [/(?:населб|локаци|дел|град|бараете|барате|дом|имот|критериум|живеење|место)/iu],
    banned: [/\d/, /Евидентен|ID|ИД/, /надомест/, /евра|денари/],
    question: true,
  },
  {
    key: 'comparison.help',
    sources: [COMPARISON_ANSWER],
    count: 10,
    instructions: 'Клиентот бара споредба на имоти — прашај што му е поважно (локација, цена, големина) и понуди помош при избор. БЕЗ конкретни имоти, БЕЗ Евидентен броеви, БЕЗ цени.',
    required: [/(?:споредб|помош|избор|поважно|критериум|локаци|цена|големина)/iu],
    banned: [/\d/, /Евидентен|ID|ИД/, /надомест/],
    question: true,
  },
  {
    key: 'feature.after.show',
    sources: [FEATURE_ANSWER],
    count: 10,
    instructions: 'Клиентот прашува за конкретна карактеристика на имотот (паркинг, лифт, реновиран, кујна...) — вети дека ќе провериш кај сопственикот и прашај кои карактеристики му се најважни. БЕЗ конкретни одговори (немаш податоци), БЕЗ Евидентен броеви.',
    required: [/(?:проверам|сопственик|карактеристик|важни| карактеристик| information)/iu],
    banned: [/\d/, /Евидентен|ID|ИД/, /надомест/],
    question: true,
  },
];

// --- Deterministic validation (mirrors the runtime guard's own rules) -------
// Anything the runtime's guardText would strip or block is rejected HERE, so
// generated variants arrive pre-clean and pre-legal.
const STRIP_FOREIGN = /[^\p{Script=Cyrillic}\p{Script=Latin}\p{N}\p{P}\p{Z}\p{Sc}\n\r\t{}]/gu;
const BANNED: RegExp[] = [
  /Супер[.,!]?\s*Уште неколку прашањ/iu,                       // code-built flourish #1
  /[Уу]ште последниве информации и завршуваме/,                 // code-built flourish #2
  /(?:^|[^\p{L}])ИД(?:[^\p{L}]|$)/u,                            // "ИД" — must be Евидентен број
  /(?:^|[^\p{L}])ID(?:[^\p{L}]|$)/iu,                           // "ID"
  /https?:\/\//i,                                               // links — never
  /(?:^|[^\p{L}])(?:ти|тебе|твој|твоја|твои|твое)(?:[^\p{L}]|$)/iu, // informal form — never
  /(?:использу|пожалуйста|спасибо|очень|конечно)/iu,            // Russian intrusion
];

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[.,!?;:„“"'()]/g, '').trim();
}

function tokenJaccard(a: string, b: string): number {
  const ta = new Set(a.split(' '));
  const tb = new Set(b.split(' '));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

interface Rejection {
  variant: string;
  reasons: string[];
}

function validateVariant(v: string, key: GenerationKey, reject: Rejection[]): string | null {
  const reasons: string[] = [];
  const t = v.trim();
  if (t.length < 10) reasons.push('too short');
  if (t.length > 400) reasons.push('too long');
  if (key.placeholders) {
    for (const ph of key.placeholders) {
      const hits = t.match(new RegExp(`\\{${ph}\\}`, 'g'))?.length ?? 0;
      if (hits !== 1) reasons.push(`{${ph}} must appear exactly once (got ${hits})`);
    }
    if (t.replace(/\{[a-z]+\}/g, '').includes('{')) reasons.push('unknown placeholder');
  } else if (/[{}]/.test(t)) {
    reasons.push('unexpected placeholder');
  }
  if (key.question && !t.endsWith('?')) reasons.push('must end with a question mark');
  if (!key.question && t.endsWith('?')) reasons.push('must NOT end with a question mark');
  const reqs = Array.isArray(key.required) ? key.required : [key.required];
  if (!reqs.every(r => r.test(t))) reasons.push('missing required meaning token');
  for (const b of [...BANNED, ...(key.banned ?? [])]) {
    if (b.test(t)) {
      reasons.push(`banned token (${b.source.slice(0, 40)})`);
      break;
    }
  }
  const stripped = t.replace(STRIP_FOREIGN, '');
  if (stripped !== t) reasons.push('foreign/garbage characters');
  if (reasons.length > 0) {
    reject.push({ variant: t, reasons });
    return null;
  }
  return t;
}

/** Dedupe: exact (normalized) dupes, dupes of the sources, and near-dupes. */
function dedupe(variants: string[], sources: string[]): string[] {
  const seen = new Set<string>(sources.map(normalize));
  const out: string[] = [];
  for (const v of variants) {
    const norm = normalize(v);
    if (seen.has(norm)) continue;
    if (out.some(a => tokenJaccard(norm, normalize(a)) >= 0.85)) continue;
    seen.add(norm);
    out.push(v);
  }
  return out;
}

// --- Generation -------------------------------------------------------------

function extractJsonArray(raw: string): string[] {
  const s = raw.trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error('no JSON array in response');
  const parsed = JSON.parse(s.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('response is not an array');
  return parsed.filter((x): x is string => typeof x === 'string');
}

async function generateKey(llm: LlmClient, key: GenerationKey, attempt: number): Promise<string[]> {
  const numbered = key.sources.map((s, i) => `${i + 1}. "${s}"`).join('\n');
  const user = [
    `Клуч: ${key.key}`,
    `Генерирај ${key.count} РАЗЛИЧНИ варијанти на оваа порака (прво лице, формално Вие, македонски):`,
    numbered,
    '',
    `Задолжително значење: ${key.instructions}`,
    key.question
      ? 'Секоја варијанта мора да завршува со прашалник.'
      : 'Ниту една варијанта не смее да завршува со прашалник.',
    attempt > 1 ? 'Повеќе варијации — не ги повторувај веќе дадените реченици.' : '',
    'Одговори ИСКЛУЧИВО со JSON низа од стрингови.',
  ].filter(Boolean).join('\n');
  const opts: CompleteOpts = {
    role: 'generate',
    messages: [
      { role: 'system', content: VOICE_SYSTEM },
      { role: 'user', content: user },
    ],
    // 10-15 variants of ~60 tokens each fit well under this; 4096 wasted
    // ~25% of the free-tier daily token budget (Gemini free keys are small and
    // windowed, and the generator must not touch the production Groq quota).
    temperature: 0.9,
    maxTokens: 3072,
    topP: 0.95,
  };
  const raw = await llm.complete(opts);
  return extractJsonArray(raw);
}

// --- Output -----------------------------------------------------------------

/** Read the existing bank file (if any) so a quota-exhausted run that yields 0
 *  variants for a key never WIPES the variants already there — it keeps them. */
function readExistingBank(outPath: string): Record<string, string[]> {
  if (!fs.existsSync(outPath)) return {};
  const src = fs.readFileSync(outPath, 'utf8');
  const bank: Record<string, string[]> = {};
  const re = /^\s{2}"([^"]+)": \[([\s\S]*?)\]\s*,?$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    try {
      // The writer emits a trailing comma after the last variant ("…",) —
      // strip it before parsing, or JSON.parse rejects the array.
      bank[m[1]] = JSON.parse(`[${m[2].replace(/,\s*$/, '')}]`);
    } catch {
      // unparseable block — skip (never crash the generator on a stray edit)
    }
  }
  return bank;
}

function writeBank(bank: Record<string, string[]>): { outPath: string; kept: string[] } {
  const outDir = path.join(__dirname, '..', 'data');
  const outPath = path.join(outDir, 'responses.ts');
  const existing = readExistingBank(outPath);
  // Start from the existing bank: a targeted (--only) or quota-partial run must
  // never drop the keys it did not regenerate.
  const merged: Record<string, string[]> = { ...existing };
  const kept: string[] = [];
  for (const [key, arr] of Object.entries(bank)) {
    if (arr.length === 0 && existing[key]?.length) {
      kept.push(key); // keep the good variants from a previous run
    } else if (arr.length > 0) {
      merged[key] = arr;
    }
    // keys with zero variants are omitted entirely — never an empty array
  }
  const lines: string[] = [
    '// GENERATED FILE — DO NOT EDIT BY HAND.',
    '// Regenerate with: npm run responses:generate  (src/scripts/generateResponses.ts).',
    '// Variants are DECORATIVE: the funnel logic stays code-built and deterministic.',
    '// A human review pass is expected after each regeneration — see the script output.',
    '',
    'export const RESPONSE_BANK: Record<string, string[]> = {',
  ];
  for (const [key, arr] of Object.entries(merged)) {
    lines.push(`  ${JSON.stringify(key)}: [`);
    for (const v of arr) lines.push(`    ${JSON.stringify(v)},`);
    lines.push('  ],');
  }
  lines.push('};', '');
  fs.writeFileSync(outPath, lines.join('\n'));
  return { outPath, kept };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  // Gemini ONLY — never Groq: the generator consumes its own quota and Groq's
  // daily TPD is reserved for production traffic. No Gemini key = hard fail,
  // so an exhausted quota can never silently burn Groq.
  if (!(cfg.geminiApiKey || cfg.geminiApiKey2 || cfg.geminiApiKey3)) {
    console.error('[generateResponses] This script is Gemini-only, but no GEMINI_API_KEY (or GEMINI_API_KEY_2/_3) was found in ~/.lina/lina.env. Refusing to fall back to Groq — nothing generated.');
    process.exit(1);
  }
  // force llmProvider 'gemini' — createLlm would otherwise build a HybridClient
  // (Gemini -> Groq failover) and an exhausted Gemini would burn the Groq quota.
  cfg.llmProvider = 'gemini';
  // Targeted runs keep quota low: --only=greeting.open,discovery.ask.location.house
  // regenerates JUST those keys (others stay untouched in the file).
  const onlyArg = process.argv.find(a => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean) : [];
  if (only.length > 0) {
    const missing = only.filter(k => !SPEC.some(s => s.key === k));
    if (missing.length > 0) {
      console.error(`[generateResponses] unknown --only keys: ${missing.join(', ')}`);
      process.exit(1);
    }
  }
  const spec = only.length > 0 ? SPEC.filter(k => only.includes(k.key)) : SPEC;
  // llmProvider was forced to 'gemini' above: createLlm returns the Gemini pool
  // (rotating across the three keys) and never touches GroqClient/HybridClient.
  const llm = createLlm(cfg);
  const bank: Record<string, string[]> = {};
  let totalAccepted = 0;

  for (const key of spec) {
    const allRejected: Rejection[] = [];
    let accepted: string[] = [];
    for (let attempt = 1; attempt <= 2 && accepted.length < key.count; attempt++) {
      try {
        const raw = await generateKey(llm, key, attempt);
        const validated = raw
          .map(v => validateVariant(v, key, allRejected))
          .filter((v): v is string => v !== null);
        accepted = dedupe([...accepted, ...validated], key.sources);
        if (accepted.length < key.count) {
          console.warn(`[${key.key}] attempt ${attempt} yielded ${accepted.length}/${key.count} — retrying…`);
        }
      } catch (e) {
        console.error(`[${key.key}] attempt ${attempt} failed:`, (e as Error).message);
      }
    }
    bank[key.key] = accepted;
    totalAccepted += accepted.length;

    console.log(`\n=== ${key.key}: ${accepted.length} variants accepted ===`);
    accepted.forEach((v, i) => console.log(`  ${i + 1}. ${v}`));
    if (allRejected.length > 0) {
      console.log(`  -- rejected: ${allRejected.length} (showing first 5) --`);
      for (const r of allRejected.slice(0, 5)) {
        console.log(`  ✗ "${r.variant}" → ${r.reasons.join(', ')}`);
      }
    }
    if (accepted.length < key.count) {
      console.warn(`  ⚠ only ${accepted.length}/${key.count} — consider rerunning or loosening constraints`);
    }
  }

  if (totalAccepted === 0) {
    console.error('[generateResponses] Nothing generated — check the LLM keys and retry.');
    process.exit(1);
  }
  const { outPath, kept } = writeBank(bank);
  if (kept.length > 0) {
    console.warn(`\n[generateResponses] kept EXISTING variants for keys that yielded 0 this run (quota?): ${kept.join(', ')}`);
  }
  console.log(`\n[generateResponses] wrote ${totalAccepted} new variants to ${outPath}`);
}

main().catch(e => {
  console.error('[generateResponses] fatal:', (e as Error).message);
  process.exit(1);
});
