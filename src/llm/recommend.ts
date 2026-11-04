// Grammar-based recommendation ask + code-built recommendation answer.
//
// THE BUG: "me interesira stanot 89" / "i stanot 94" / "koj bi mi go
// preporacale?" — the client names TWO properties and asks which one Lina
// recommends. No deterministic detector fired, the LLM misread it as
// SEEN_PROPERTY, and the client got "Дали го знаете Евидентен број на тој
// стан?" — asking for the numbers they had JUST given.
//
// The fix, as written:
//  1. detectRecommendAsk — grammar word classes (Macedonian verb предлог-…
//     family + English recommend) so recognition grows by grammar, not by
//     appending phrases.
//  2. collectMentionedEbs — the EBs the client named in RECENT MESSAGES
//     (the session history carries them), validated against the DB.
//  3. buildRecommendation — one card per mentioned property (DB facts only)
//     + the frozen professional close: "Секоја недвижнина има своја
//     клиентела… Дали да се обидам да договарам посета?"

import type { Property } from '../data/properties';
import { pricePerM2, sqmOfRow } from '../data/properties';
import { buildPropertyCard } from './prompts';
import { normalizeMc } from './normalize';
import { ebNumbersInText } from './ebNumber';

/** Word classes for the recommendation ask. The verb family: preporac-/препорач-
 *  (all conjugations), izber-/избира-/избор- (choose), suggest/recommend. */
const RECO_VERB_RE =
  /(?:препорач|препорац|preporac|preporaka|preporaci|preporach|препорака|избер|избира|izber|izbira)/iu;
// NOTE: the bare NOUN «избор/izbor» is deliberately NOT in the verb class. It
// is an option noun, not a request for a judgment — «ОДЛИЧЕН ИЗБОР, ми се
// допаѓа овој» is a client praising the flat she just offered, and matching it
// sent that praise down the recommendation path instead of the visit offer.
// The noun lives in RECO_OPTION_RE below, where an interrogative anchor is
// required, and the choice VERBS (избер-/избр-/izbr-) cover «koja da ja
// odberam».

/** Comparative-judgment word classes — "KOJ OD OVIE DVA E PODOBAR SPORED
 *  VAS?" is the SAME question as "koj da go preporacate?": the client asks
 *  Lina to judge between properties. Stems cover all genders/numbers
 *  (podobr→podobar/podobra/podobri/podobro; pogod→pogoden/pogodna;
 *  pobar→pobaran/pobaranа; posakuv→posakuvan). Interrogative anchor required
 *  (koj/shto/sto/dali) so "sakam podobar stan" (a search) never matches.
 *  Stems written in BOTH scripts: the raw test hits Latin, the normalized
 *  test (normalizeMc folds Latin→Cyrillic) hits Cyrillic. */
const RECO_COMPARATIVE_RE =
  /(?:koj|koja|koe|koji|shto|sto|dali|кој|која|кое|кои|што|сто|дали)[^\n]{0,40}?(?:podob|подоб|pogod|погод|pobar|побар|posakuv|посакув|poiskren|поискрен)/iu;

/** "spored vas / според вас" (according to you) — an opinion ask by itself
 *  when paired with an interrogative. */
const RECO_OPINION_RE =
  /(?:koj|koja|koe|shto|sto|кој|која|кое|што|сто)[^\n]{0,30}?(?:spored\s+vas|според\s+вас|mislite\s+vi|мислите\s+ви)/iu;

/** CHOICE verb family — "koe bi go ODBRALE?", "ne znam koja da ja ODBERAM"
 *  (the [02:16] capture's own preceding message), "shto da IZBERAM?". The
 *  stems cover the prefixed aorist forms (od-ber/od-br-, iz-ber/iz-br-,
 *  iz-ab-) that the unprefixed „ber“ would never reach. An interrogative
 *  anchor is REQUIRED: „избегав од тоа“ (I avoided it) must not match.
 *  Latin 'choose'/'pick' ride in the same class — English and Macedonian
 *  clients are the same ask. */
const RECO_CHOICE_RE =
  /(?:koj|koja|koe|koi|shto|sto|kako|dali|кој|која|кое|кои|што|сто|како|дали)[^\n]{0,40}?(?:odber|одбер|odbr|одбр|izbr|избр|izab|изаб|izbe|избе|izbor|избор|choose|pick)/iu;

/** OPTION-NOUN class — "KOJA OPCIJA bi mi ja preporacale?", "koja varijanta e
 *  podobra?", "koe e podobro od dvete opcii?". The ask does not need a verb at
 *  all: naming the OPTIONS and asking about them IS the recommendation
 *  question. Interrogative + option noun within a short window; the nouns
 *  cover opcija / varijanta / alternativa / izbor in both scripts and both
 *  numbers. */
const RECO_OPTION_RE =
  /(?:koj|koja|koe|koi|shto|sto|dali|кој|која|кое|кои|што|сто|дали)[^\n]{0,30}?(?:opcij|опциј|varijant|варијант|alternativ|алтернатив|izbor|избор)/iu;

/** Every word class that expresses the SAME client question: "judge these for
 *  me". Recognising by class (not by phrase) is the point — any new conjugation
 *  or synonym inside a class is covered without touching this list. */
const RECO_CLASSES: RegExp[] = [
  RECO_VERB_RE,        // „preporacale / препорачале"
  RECO_CHOICE_RE,      // „koja da ja odberam"
  RECO_OPTION_RE,      // „koja opcija"
  RECO_COMPARATIVE_RE, // „koj e podobar"
  RECO_OPINION_RE,     // „shto mislite spored vas"
];

/** True when the client asks for a recommendation between/for properties.
 *  Tested raw AND normalized: normalizeMc folds Latin→Cyrillic ('c'→'ц'),
 *  so the raw test catches Latin 'preporac…' and the normalized test catches
 *  its Cyrillic form 'препорац…'. Every class is tried in both scripts. */
export function detectRecommendAsk(text: string): boolean {
  const forms = [text, normalizeMc(text)];
  return forms.some(f => RECO_CLASSES.some(re => re.test(f)));
}

/** VALUE word class — "koja e PODOBRA VREDNOST?", "shto e IZPLATLIVO?", "koj e
 *  POEVTIN po kvadrat?", "kade e isplati", "best value", "worth it". These
 *  are choice questions with a PRICE yardstick: the client does not want the
 *  marketing close alone, he wants the numbers compared. The class covers the
 *  yardstick itself (vrednost/исплати/цена за квадрат) so the ranking is
 *  served whenever the ask is about worth rather than about feel. No
 *  interrogative anchor: „shto e isplatlivo?", „iskreno, vrednost" and
 *  „koe e podobra vrednost" are the same request in different moods. */
const VALUE_CLASSES: RegExp[] = [
  /(?:isplati|исплати|isplatl|исплатлив|vrednost|вредност|vredno|вредно)/iu,
  /(?:(?:cena|цена)\p{L}*[^.\n]{0,15}(?:m2|м2|м²|kvadrat|квадрат)|(?:m2|м²|m2|м²|kvadrat|квадрат)[^.\n]{0,15}(?:cena|цена)|(?:po|za|за|по)\s*(?:m2|m²|м2|м²|kvadrat|квадрат))/iu,
  /(?:best\s+value|value\s+for\s+money|worth\s+it|per\s+square\s+met(?:er|re))/iu,
];

/** The CHEAPER-COMPARATIVE class — „poevtino", „najevtino", „podobra cena".
 *  It is a value word only when the client is JUDGING what he already saw.
 *  The very same word inside a STOCK REQUEST („DAJ MI NESTO POEFTINO VO TOJ
 *  REON" — the [14:46] capture) is a cheaper SEARCH: the cheaper-search lane
 *  owns it and must serve a same-characteristics cheaper pool, never the
 *  clientela close. This class is therefore consulted only when the message
 *  carries no search verb (see VALUE_SEARCH_RE below). */
const VALUE_CHEAPER_RE =
  /(?:poevtin|поевтин|poeftin|поeftin|najevtin|најевтин|podobra\s+cena|подобра\s+цена|povolna\s+cena|поволна\s+цена)/iu;

/** Stock-request shape — the client asks to be GIVEN something („daj mi",
 *  „sakam", „baram", „treba mi", „imate", „pokazi mi", „najdi mi", „nesto").
 *  With one of these present the cheaper word is a search criterion. */
const VALUE_SEARCH_RE =
  /(?:daj\s+mi|dajte\s+mi|дај\s+ми|дајте\s+ми|sakam|сакам|baram|барам|treba\s+mi|треба\s+ми|imate|имате|imas|имаш|najdi|најди|pokazi\s+mi|покажи\s+ми|nesto|нешто|ponudi|понуди)/iu;

/** True when the client asks which of the options is better VALUE — the
 *  choice question with a price-per-m² yardstick. Tested raw AND normalized
 *  for the same reason as detectRecommendAsk: Latin input folds to Cyrillic. */
export function detectValueAsk(text: string): boolean {
  const forms = [text, normalizeMc(text)];
  return forms.some(f =>
    VALUE_CLASSES.some(re => re.test(f))
    // „poevtino" counts only as a JUDGMENT, never as a stock request —
    // otherwise a cheaper search would be answered with the visit close
    // instead of the cheaper pool (the [14:46] capture).
    || (VALUE_CHEAPER_RE.test(f) && !VALUE_SEARCH_RE.test(f)));
}

/** Extract EB numbers the client mentioned in their messages. */
export function collectMentionedEbs(
  userTexts: string[],
  validEbs: Set<number>,
  window = 6,
): number[] {
  const found: number[] = [];
  for (const raw of userTexts.slice(-window)) {
    // "stanot 89", "i stanot 94", "EB 89", "евидентен број 94", bare "89".
    // Lookahead guards: a number followed by a thousands separator ("100.000",
    // "110 000") is a PRICE, never an EB — the tail group gets filtered by
    // validEbs anyway, but the head group must not fire.
    //
    // A CRITERION NUMBER IS NOT AN EB (the [09:24] Дебар Маало capture):
    // «NAD 50 M2» bound EB 50 — a rental house across town — because a bare
    // «50» that happens to collide with a feed EB was read as a mention. The
    // funnel then carried propertyId 50 into the next turn and answered a
    // completed search with the contact ask. A number carrying a size, money,
    // time or floor UNIT belongs to the criteria ("50 m²", "120 000 evra",
    // "6 saat", "3 kat"), and a number behind a comparison word ("nad 50",
    // "do 120", "preku 60") is a limit, not a reference to a listing.
    //
    // ONE READER (src/llm/ebNumber.ts): the same grammar backs
    // inferPropertyId, so the market lane's "a named property owns its lane"
    // guard and this binder can never disagree — the [20:11] capture lost the
    // 53 in «CENA PO KVADRAT ZA 53» only because two copies of this rule
    // disagreed about the word «kvadrat».
    for (const n of ebNumbersInText(raw)) {
      if (validEbs.has(n) && !found.includes(n)) found.push(n);
    }
  }
  return found;
}

/** Build the recommendation answer from DB facts ONLY — one card per
 *  property, then the frozen professional close. No LLM at reply time. */
export function buildRecommendation(props: Property[], closeVariant: string): string {
  const cards = props.map(p => buildPropertyCard(p)).join('\n\n');
  return `${cards}\n\n${closeVariant}`;
}

/** One comparable row of the value ranking. `perM2` is the ONLY number the
 *  ranking reads — the raw price and the size are shown beside it so the
 *  client can check the arithmetic herself. `kind` names the row's category
 *  so a HOUSE / BUSINESS SPACE / LAND PLOT comparison reads as what it is and
 *  a mixed pair never looks like two flats. */
export interface ValueRow {
  eb: number;
  price: number;
  sqm: number;
  perM2: number;
  kind: string;
}

/** The row's own category noun — the same precedence buildPropertyCard uses
 *  (плац → кућа → деловен простор → стан), so the ranking and the cards can
 *  never disagree about what a row IS. */
export function kindNoun(p: Property): string {
  return p.plac ? 'плац' : p.house ? 'куќа' : p.business ? 'деловен простор' : 'стан';
}

/** The comparable rows, cheapest per square metre first. Rows without a
 *  usable price or size are DROPPED rather than guessed — a ranking that
 *  invents a size is worse than no ranking (the same data rule as the rest of
 *  the funnel).
 *
 *  THE SIZE COMES FROM sqmOfRow, not from `p.sqm` alone: this feed writes the
 *  surface as a STRING for many rows („84 м²") and leaves the numeric column
 *  empty, so reading only the number silently dropped every house, plot and
 *  business space whose area lived in the text — the ranking then looked like
 *  a flats-only feature. sqmOfRow is the funnel's one size reader; the type is
 *  never a filter, only the price band inside pricePerM2 is. */
export function valueRows(props: Property[]): ValueRow[] {
  const rows: ValueRow[] = [];
  for (const p of props) {
    if (typeof p.price !== 'number') continue;
    const sqm = sqmOfRow(p);
    if (sqm === undefined) continue;
    // pricePerM2 owns the sanity band (a 3 м² row for 90.000 € is refused) —
    // it is handed the size that was actually found.
    const perM2 = pricePerM2({ ...p, sqm });
    if (perM2 === undefined) continue;
    rows.push({ eb: p.eb, price: p.price, sqm, perM2, kind: kindNoun(p) });
  }
  return rows.sort((a, b) => a.perM2 - b.perM2 || a.eb - b.eb);
}

/** What the €/m² arithmetic leaves out — WORDED FOR THE ROWS ON THE TABLE.
 *  „спратот" and „состојбата" mean nothing for a land plot, and a plot's own
 *  qualifiers (access, shape) are what a buyer weighs. One mixed pair gets the
 *  shared pair of facts instead of a category that would fit only one of them. */
function outsideTheNumbers(props: Property[]): string {
  const kinds = new Set(props.map(p => (p.plac ? 'land' : p.house ? 'house' : p.business ? 'business' : 'flat')));
  if (kinds.size > 1) return 'состојбата и локацијата';
  const kind = [...kinds][0];
  return kind === 'land' ? 'пристапот, формата и локацијата на плацот'
    : kind === 'house' ? 'состојбата, дворот и локацијата'
    : 'состојбата, спратот и локацијата';
}

/** The value comparison itself — pure arithmetic on the feed's own numbers.
 *
 *  THE CONTRACT: Lina never picks a flat. She compares the price per square
 *  metre (a fact), names which one is cheaper on that measure (a fact), and
 *  leaves the choice with the client — the dictated close then offers the
 *  visit. „Подобро“ is never a verdict on the property: it is the arithmetic
 *  of €/m², stated with the two figures it came from.
 *
 *  Returns undefined when fewer than two rows are comparable, so the caller
 *  falls back to the ordinary recommendation answer instead of ranking one
 *  number against nothing. */
export function buildValueRanking(props: Property[]): string | undefined {
  const rows = valueRows(props);
  if (rows.length < 2) return undefined;
  const fmt = (n: number): string => n.toLocaleString('mk-MK');
  const lines = rows.map((r, i) => {
    const head = `• Евидентен број ${r.eb} — ${fmt(r.perM2)} евра за квадрат`;
    const behind = ` (${r.kind}, ${fmt(r.sqm)} м² за ${fmt(r.price)} евра)`;
    return `${head}${behind}${i === 0 ? ' — најниска цена за квадрат' : ''}`;
  });
  const best = rows[0]!;
  const rest = rows.slice(1);
  const gap = rest.reduce((min, r) => Math.min(min, r.perM2 - best.perM2), Number.POSITIVE_INFINITY);
  return [
    'Гледано по цена за квадрат:',
    '',
    ...lines,
    '',
    `Најмалку по квадрат излегува Евидентен број ${best.eb}${Number.isFinite(gap) ? `, со ${fmt(gap)} евра разлика по квадрат` : ''}. Цената по квадрат е само еден дел од сликата — ${outsideTheNumbers(props)} не се гледаат во бројки.`,
  ].join('\n');
}
