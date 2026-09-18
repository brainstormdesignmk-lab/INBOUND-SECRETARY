// THE MENTION RESOLVER — "she must be aware of the current state of the
// options given at that time" (12:33 transcript, made mechanism).
//
// When a client message names a property by ANYTHING OTHER than its EB —
// "stanot kaj Dimitar Miladinov", "garsonjerata", "ovoj od 99000", "28 m2" —
// the runtime had no way to bind it. The where-is family only understood a
// bare EB number, so "KOJA MU E LOKACIJATA NA STANOT KAJ DIMITAR MILADINOV ?"
// found no property and fell into the no-context dead end, and the next push
// ("MORAS DA MI KAZES KADE E") bound whatever was LAST in play — not the one
// he NAMED.
//
// THE CONTRACT: every property ever mentioned in the chat (presented pairs,
// the current pointer, seen-property) is a candidate. Signals extracted from
// the message are scored against each candidate's public-add data (price,
// rooms, m², floor, details, feed landmarks). One clear winner → bind it.
// Several equal positives → the caller asks ONE clarify question naming the
// options — never a silent guess, never a silent wrong property.

import { normalizeMc } from './normalize';

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export interface MentionSignals {
  eb?: number;            // "еб 69" — explicit prefix
  price?: number;         // "od 99000", "99.000 evra"
  garsonjera?: boolean;   // "garsonjerata", "студиото"
  bedrooms?: number;      // "двособен" → 2, "со една спална" → 1
  sqm?: number;           // "28 м2"
  suteren?: boolean;      // "во сутерен"
  descriptor?: string;    // "кај Димитар Миладинов" — matched against candidate text
}

export function extractMentionSignals(text: string): MentionSignals {
  // Cyrillic-canonical: Latin client typing is covered by the transliteration,
  // so every regex below needs only its Cyrillic form.
  const norm = normalizeMc(text);
  const s: MentionSignals = {};

  // EB — explicit prefix only ("еб 69", "еб број 69"). Bare numbers are
  // resolved by the CALLER against the discussed set (EB before price).
  const ebM = norm.match(/(?:^|\s)еб\s*(?:број|№)?\s*(\d{1,5})/);
  if (ebM) s.eb = parseInt(ebM[1], 10);

  // Price: currency-suffixed ("99.000 евра", "99000€", "36.000 ден") or a
  // 4–7-digit number AFTER "од/od" ("stan od 99000"). Currency-less bare
  // numbers never become price on their own — they collide with EBs.
  const priceCur = norm.match(/(\d{1,3}(?:[.,]\d{3})+|\d{4,7})\s*(?:еврата|евра|еур|€|денари|ден)/);
  const priceOd = norm.match(/(?:^|\s)од\s+(\d{4,7})(?:\s|$|[.,!?])/);
  const priceStr = priceCur ? priceCur[1] : priceOd ? priceOd[1] : undefined;
  if (priceStr) {
    const p = parseInt(priceStr.replace(/[.,\s]/g, ''), 10);
    if (Number.isFinite(p) && p >= 1000) s.price = p;
  }

  if (/гарсоњер|студио/.test(norm)) s.garsonjera = true;

  // Room-count words: "еднособен" → 1, "двособен" → 2 …
  const bedWord = norm.match(/(?:едно|дво|три|четири|пет)\s*собен/);
  if (bedWord) {
    const w = bedWord[0].slice(0, bedWord[0].indexOf('собен')).trim();
    s.bedrooms = { 'едно': 1, 'дво': 2, 'три': 3, 'четири': 4, 'пет': 5 }[w] ?? undefined;
  } else {
    // "со една спална" / "so 2 spalni" → спальни соби = bedrooms
    const spalna = norm.match(/(?:^|\s)со\s+(\d|(?:една|еден|едно|две|три))\s*спалн/);
    if (spalna) {
      s.bedrooms = spalna[1].match(/^\d$/)
        ? parseInt(spalna[1], 10)
        : { 'една': 1, 'еден': 1, 'едно': 1, 'две': 2, 'три': 3 }[spalna[1]];
    }
  }

  const sqmM = norm.match(/(\d{2,3})\s*(?:м²|м2|квадрат)/);
  if (sqmM) s.sqm = parseInt(sqmM[1], 10);

  if (/сутерен/.test(norm)) s.suteren = true;

  // Descriptor: the phrase after a proximity preposition — "кај Димитар
  // Миладинов", "до УЈП", "преку УЈП". Longest-allowed fragment; matched
  // against each candidate's public-add text.
  // "до + NUMBER" is the BUDGET sense ("до 250 евра" = up to 250), never a
  // landmark — a digit-led fragment is a search criterion, not a descriptor.
  const descM = norm.match(/(?:^|\s)(?:кај|до|преку|спроти|блиску)\s+(?![\d€])([^,?!.]{4,60})/);
  if (descM && !/^\d/.test(descM[1].trim())) s.descriptor = descM[1].trim();

  return s;
}

// ---------------------------------------------------------------------------
// Candidates — the properties the chat has put on the table
// ---------------------------------------------------------------------------

export interface MentionCandidate {
  eb: number;
  price?: number;
  bedrooms?: number;
  sqm?: number;
  business?: boolean;
  house?: boolean;
  location?: string;      // населба
  details?: string;       // feed opis — descriptor source
  landmark?: string;      // "во близина на X"
  landmarks?: { landmark: string }[];  // feed ranked list
  nearby?: string[];      // nearby-rotation names this property already served
  lat?: number;           // trusted coords — the map-descriptor distance match
  lon?: number;
}

/** A map-resolved place, injected by the caller so this module stays pure.
 *  The client says "Црногорска амбасада", the data says "Embassy of
 *  Montenegro" — the offline MAP is the translation layer (same role as the
 *  Latin→Cyrillic script bridge in findPoiByName). */
export interface MentionPoi {
  name: string;
  lat: number;
  lon: number;
}

export interface MentionOpts {
  /** Map resolution of the message's descriptor, if the map knows it. */
  poi?: MentionPoi;
}

/** Descriptors within this radius of a candidate's trusted coords count as
 *  naming it ("кај Црногорска амбасада" ↔ the property near that embassy).
 *  600 m: the two Центар pairs in the 12:33 chat are ~1.1 km apart, so a
 *  600 m match never confuses them. */
export const DESCRIPTOR_MATCH_M = 600;

function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const la = a.lat * Math.PI / 180;
  const lb = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function hasMentionSignals(s: MentionSignals): boolean {
  return s.eb !== undefined || s.price !== undefined || s.garsonjera
    || s.bedrooms !== undefined || s.sqm !== undefined || s.suteren || s.descriptor !== undefined;
}

/** Identity-flavored signals — EB, descriptor landmark, type noun, floor.
 *  Quantitative signals (price, м², спални) are SEARCH CRITERIA: they may
 *  UNIQUELY bind ("овој од 99000"), but an ambiguous quantitative match is
 *  meaningless — "до 250 евра" matching both presented rents is the client's
 *  budget, never a property reference. Only identity signals may ask back. */
export function hasIdentitySignals(s: MentionSignals): boolean {
  return s.eb !== undefined || s.descriptor !== undefined || s.garsonjera === true || s.suteren === true;
}

export interface MentionMatch {
  kind: 'unique' | 'ambiguous';
  eb?: number;                       // kind === 'unique'
  candidates?: MentionCandidate[];   // kind === 'ambiguous' — for the clarify line
  signals: MentionSignals;
}

// ---------------------------------------------------------------------------
// Scoring — signals against each candidate's public-add data
// ---------------------------------------------------------------------------

function haystack(c: MentionCandidate): string {
  const parts = [
    c.location, c.landmark, c.details,
    ...(c.landmarks ?? []).map(l => l.landmark),
    ...(c.nearby ?? []),
  ];
  return normalizeMc(parts.filter(Boolean).join(' · '));
}

function scoreCandidate(sig: MentionSignals, c: MentionCandidate, poi: MentionPoi | undefined): number {
  let score = 0;
  if (sig.eb !== undefined && c.eb === sig.eb) score += 10; // decisive
  if (sig.price !== undefined && c.price !== undefined && Math.abs(c.price - sig.price) <= 1) score += 4;
  const cGarsonjera = c.bedrooms === 1 && !c.business && !c.house;
  if (sig.garsonjera) score += cGarsonjera ? 3 : -3;
  if (sig.bedrooms !== undefined) score += c.bedrooms === sig.bedrooms ? 3 : (c.bedrooms !== undefined ? -3 : 0);
  if (sig.sqm !== undefined && c.sqm !== undefined) score += c.sqm === sig.sqm ? 3 : -2;
  if (sig.suteren) {
    if (c.details && /сутерен/.test(normalizeMc(c.details))) score += 2;
    else score -= 1;
  }
  if (sig.descriptor) {
    const d = normalizeMc(sig.descriptor);
    if (d.length >= 4 && haystack(c).includes(d)) score += 3;            // text evidence (feed opis / landmark names)
    else if (poi && c.lat !== undefined && c.lon !== undefined
      && haversineM(poi, { lat: c.lat, lon: c.lon }) <= DESCRIPTOR_MATCH_M) score += 3; // map evidence (name-language bridge)
  }
  return score;
}

/** Resolve a client mention against the candidate set.
 *  - exactly one positive-scoring candidate → unique bind
 *  - several positives with no decisive margin → ambiguous (caller asks back once)
 *  - no signals, or signals that match NOTHING → undefined (caller keeps its
 *    current behavior — a false signal never hijacks the conversation). */
export function resolveMention(text: string, candidates: MentionCandidate[], opts?: MentionOpts): MentionMatch | undefined {
  if (candidates.length === 0) return undefined;
  const sig = extractMentionSignals(text);

  // Bare-number binding (no prefix): a number that IS a discussed EB is the
  // EB; only when it matches nothing discussed may it read as a price.
  // BEFORE the signal gate — "kaj 69 kolku kvadrati" carries no extractable
  // signal except the number itself; gating first would starve the bind.
  if (sig.eb === undefined) {
    const bare = text.match(/(?:^|\s)(\d{1,5})(?:\s|$|[.?!,])/);
    if (bare) {
      const n = parseInt(bare[1], 10);
      if (candidates.some(c => c.eb === n)) sig.eb = n;
      else if (candidates.some(c => c.price !== undefined && c.price === n)) sig.price = n;
    }
  }

  if (!hasMentionSignals(sig)) return undefined;

  const scored = candidates
    .map(c => ({ c, score: scoreCandidate(sig, c, opts?.poi) }))
    .sort((a, b) => b.score - a.score);

  const positives = scored.filter(x => x.score > 0);
  if (positives.length === 0) return undefined;
  if (positives.length === 1 && positives[0].score >= 2) {
    return { kind: 'unique', eb: positives[0].c.eb, signals: sig };
  }
  if (positives.length >= 2 && positives[0].score >= positives[1].score + 4) {
    // A clear winner by margin (EB always; price+type over type alone).
    return { kind: 'unique', eb: positives[0].c.eb, signals: sig };
  }
  // Ambiguous → the caller asks back ONCE — but only when the message
  // carries an IDENTITY signal. "гарсоњерата" over two studios is a real
  // "which one?"; "до 250 евра" over two 250-евра rents is just the budget.
  if (!hasIdentitySignals(sig)) return undefined;
  return { kind: 'ambiguous', candidates: positives.map(x => x.c), signals: sig };
}

// ---------------------------------------------------------------------------
// Clarify labels — short honest names for the ask-back line
// ---------------------------------------------------------------------------

/** "гарсоњерата во Центар" / "станот кај Димитар Миладинов" / "деловниот простор во Аеродром". */
export function describeCandidate(c: MentionCandidate): string {
  const type = c.bedrooms === 1 && !c.business && !c.house ? 'гарсоњерата'
    : c.house ? 'куќата'
    : c.business ? 'деловниот простор'
    : 'станот';
  const loc = c.location ? ` во ${c.location}` : '';
  const anchor = firstAnchor(c);
  if (anchor) return `${type}${loc} кај ${anchor}`;
  return `${type}${loc}`;
}

function firstAnchor(c: MentionCandidate): string | undefined {
  const lm = c.landmarks?.[0]?.landmark ?? c.nearby?.[0]
    ?? c.landmark?.replace(/^во близина на\s*/i, '');
  return lm && lm.trim().length >= 4 ? lm.trim() : undefined;
}
