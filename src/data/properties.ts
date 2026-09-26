import '../compat/node16';

import { Service } from '../fsm/machine';
import { LANDLORD_DATA } from './landlords';

// How a property's coordinates were obtained. Determines whether the
// runtime may TRUST them as the search center:
//   stored / google_cached          — trusted (real geocode)
//   osm_building / osm_interpolated — trusted (exact/interpolated building)
//   osm_low_confidence              — NEVER trusted (neighborhood centroid etc.)
export type GeoSource =
  | 'stored' | 'google_cached'
  | 'osm_building' | 'osm_interpolated'
  | 'osm_low_confidence';

// v2: THE IDENTITY IS "evidenten_broj" (EB). The feed's "id" is a UUID and
// must NOT be used for lookups — it only builds deep links.
export interface Property {
  eb: number;              // Евидентен број — THE identity
  id: number;              // alias of eb (kept for existing code)
  uuid?: string;           // feed id (UUID) — only for the deep link
  address: string;
  price?: number;          // cena_eur
  priceLabel?: string;     // optional display label
  location?: string;       // naselba
  // NEW — coordinates now flow through the runtime. public-properties selects
  // lat/lon/geo_source/geocoded_at and the feed mapper copies them here so
  // resolveSearchCenter() can serve a TRUSTED center instead of re-geocoding
  // the address text on every ask.
  lat?: number;
  lon?: number;
  geo_source?: GeoSource | null;
  geocoded_at?: string;
  bedrooms?: number;       // from tip_na_sobi
  sqm?: number;            // povrsina_m2 as a number (business spaces have no bedrooms — size matters)
  size?: string;           // povrsina_m2
  business?: boolean;      // деловен простор/канцеларија/локал — feed marks them by having NO bedroom type
  house?: boolean;         // куќа — the feed marks houses only in the opis text ("Се продава куќа…")
  plac?: boolean;          // плац/земјиште — land plot rows (no bedrooms, opis/address name the land)
  features?: string[];     // garaza, lift, greenje, dvor, parking, opremenost (per feed napomena)
  details?: string;        // opis
  gmaps?: string;
  /** Approximate public location ("во близина на Градежен Факултет") — the
   *  resolver's answer, stamped onto the property before it reaches any reply
   *  builder. The EXACT street must never be shown to the client. */
  landmark?: string;
  /** RANKED approximate-location list, resolved ONCE at ANA's import and stored
   *  next to the property in Supabase (a `landmarks` JSONB column). Each entry
   *  is a PUBLIC place with its distance from the address — the 100m…1000m
   *  rings are just the distances, not separate lookups. Lina picks the
   *  nearest VALID entry (rotating by EB hash for variety) and falls back to
   *  the deterministic table when the field is empty. Never a street name. */
  landmarks?: FeedLandmark[];
  url?: string;
  service?: Service;       // Продава -> buy, Издава -> rent
  landlordName?: string;
  raw?: Record<string, unknown>;
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(String(v).replace(/\s/g, ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** One entry of the feed's ranked landmark list (Supabase `landmarks` JSONB). */
export interface FeedLandmark {
  landmark: string;
  type?: string;
  distance_m?: number;
  maps_url?: string;
}

/** Parse the feed's `landmarks` column defensively — garbage rows are dropped,
 *  not thrown. The street-name guard runs later at pick time (defense in
 *  depth); here we only keep well-shaped entries. */
function parseFeedLandmarks(v: unknown): FeedLandmark[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: FeedLandmark[] = [];
  for (const e of v) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const name = str(o.landmark);
    if (!name || name.length > 80) continue;
    const d = Number(o.distance_m);
    out.push({
      landmark: name,
      type: str(o.type) || undefined,
      distance_m: Number.isFinite(d) && d >= 0 ? d : undefined,
      maps_url: str(o.maps_url) || undefined,
    });
  }
  return out.length > 0 ? out : undefined;
}

function str(v: unknown): string {
  return String(v ?? '').trim();
}

function parseService(raw: unknown): Service | undefined {
  const s = str(raw).toLowerCase();
  if (s.includes('издава') || s.includes('iznajm') || s.includes('rent')) return 'rent';
  if (s.includes('продава') || s.includes('prodaz') || s.includes('buy') || s.includes('sale')) return 'buy';
  return undefined;
}

function parseBedrooms(raw: unknown): number | undefined {
  const m = str(raw).match(/(\d+)(?:[.,](\d+))?/);
  if (!m) return undefined;
  const v = parseFloat(`${m[1]}.${m[2] ?? '0'}`);
  return Math.max(1, Math.round(v));
}

/** A property is COMMERCIAL when it has NO bedroom type — the feed marks
 *  деловен простор/канцеларија/локал exactly this way ("Нема податок"/empty). */
function isBusiness(r: Record<string, unknown>): boolean {
  const tip = str(r.tip_na_sobi).toLowerCase().replace(/\s+/g, ' ');
  return tip === '' || tip === 'нема податок' || tip === 'нема' || tip === 'не е наведено';
}

/** A HOUSE (куќа) — the feed carries houses as ordinary bedroom rows and marks
 *  them only in the opis text ("Се продава куќа…", "Се издава Куќа…"). */
function isHouse(r: Record<string, unknown>): boolean {
  return /(куќ|кука|house|kukja|kuka)/i.test(str(r.opis));
}

/** A LAND PLOT (плац/земјиште) — the feed carries land rows as bedroom-less
 *  rows whose address/title names the land ("Плац за градење…"). Must be
 *  checked BEFORE isBusiness: both are bedroom-less, but a land row is NOT
 *  commercial premises. A land word in the OPIS alone counts only on a
 *  bedroom-less row — "куќа со плац од 500 м²" is a house ad naming its
 *  yard plot, never a land listing. */
function isPlac(r: Record<string, unknown>): boolean {
  const LAND = /(плац|plac|земјишт|zemji[sš]t|zemi[sš]t)/i;
  if (LAND.test(`${str(r.adresa)} ${str(r.naslov)}`)) return true;
  return LAND.test(str(r.opis)) && isBusiness(r);
}

/**
 * Feed features -> clean Macedonian phrases. The feed stores "Лифт: Да",
 * "Греење: Струја" — a bare "Клуч: Вредност" list that reads as noise
 * ("Одлики: Лифт: Да"). We render real phrases instead, so both the
 * code-built cards AND the LLM context get "лифт, греење на струја…".
 */
export function featurePhrases(r: Record<string, unknown>): string[] {
  const out: string[] = [];
  const v = (k: string) => str(r[k]).toLowerCase();
  const yes = (k: string) => {
    const x = v(k);
    return !!x && x !== 'не' && x !== 'нема' && x !== 'не е наведено';
  };
  if (yes('garaza')) out.push('гаража');
  if (yes('lift')) out.push('лифт');
  const g = v('greenje');
  if (yes('greenje')) {
    if (g.includes('струја')) out.push('греење на струја');
    else if (g.includes('парно')) out.push('парно');
    else if (g.includes('дрва')) out.push('греење на дрва');
    else out.push(`греење на ${g}`);
  }
  if (yes('dvor')) out.push('двор');
  const pk = v('parking');
  if (yes('parking')) {
    if (pk.includes('приватен')) out.push('приватен паркинг');
    else if (pk.includes('јавен')) out.push('јавен паркинг');
    else out.push(pk);
  }
  const op = v('opremenost');
  if (yes('opremenost')) out.push(op === 'наместен' ? 'наместен' : op); // keep "делумно наместен" intact
  return out;
}

/** Macedonian-aware title case — the feed stores addresses in ALL CAPS. */
export function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, sp: string, ch: string) => sp + ch.toUpperCase());
}

// The agency feed was typed in lossy Latin (ž->z, č->c, š->s, ќ->k) and then
// converted back to Cyrillic with a naive per-letter map, producing corrupted
// words: "ziveese"->"зивеесе", "cist"->"цист", "masina"->"масина",
// "moznost"->"мозност". The corruption is NOT invertible per letter (з/ц/с
// are legitimately common), so we fix the KNOWN garbled words word-level —
// valid words like "за"/"соба"/"одлична" are never touched.
const MK_GARBLED: Array<[string, string]> = [
  // longer first — "авионцето" before the standalone "авионце"
  ['авионцето', 'авиончето'],
  ['авионце', 'авионче'],
  ['зивеесе', 'живееше'],
  ['одлицна', 'одлична'],
  ['фризидер', 'фрижидер'],
  ['земјистето', 'земјиштето'],
  ['игралиста', 'игралишта'],
  ['југосвовенска', 'југословенска'],
  ['масина', 'машина'],
  ['комсии', 'комшии'],
  ['сематски', 'шематски'],
  ['наплака', 'наплаќа'],
  ['мозност', 'можност'],
  ['месеца', 'месеци'],
  ['мњсеци', 'месеци'],
  ['спаизи', 'спални'],
  ['маџери', 'маџари'],
  ['усте', 'уште'],
  ['цист', 'чист'],
  ['ке', 'ќе'],
  // Acronyms the agency typed lowercase — always re-uppercased.
  ['асном', 'АСНОМ'],
  ['дупот', 'ДУП-от'],
];

// Unicode-aware word boundaries (JS \b only knows ASCII).
const MK_GARBLED_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${MK_GARBLED.map(([g]) => g).join('|')})(?![\\p{L}\\p{N}])`,
  'giu',
);

/** Fix feed-text corruption (lossy Latin->Cyrillic) word by word, keeping the
 *  matched token's casing (ЦИСТ -> ЧИСТ, Цист -> Чист, цист -> чист).
 *  Acronym entries (АСНОМ, ДУП-от) always render in their fixed case. */
export function cleanMacedonian(text: string): string {
  if (!text) return text;
  return text.replace(MK_GARBLED_RE, (m) => {
    const entry = MK_GARBLED.find(([g]) => g === m.toLowerCase());
    if (!entry) return m;
    const fix = entry[1];
    if (fix !== fix.toLowerCase()) return fix; // АСНОМ / ДУП-от — fixed case
    const allCaps = m === m.toUpperCase() && m !== m.toLowerCase();
    if (allCaps) return fix.toUpperCase();
    const first = m.charAt(0);
    if (first !== first.toLowerCase() && first === first.toUpperCase()) {
      return fix.charAt(0).toUpperCase() + fix.slice(1);
    }
    return fix;
  });
}

const GEO_SOURCES = new Set(['stored', 'google_cached', 'osm_building', 'osm_interpolated', 'osm_low_confidence']);

// Exported for tests — the feed→Property contract (0 м² = missing) is pinned.
export function mapRow(r: Record<string, unknown>): Property | null {
  const eb = Math.floor(Number(str(r.evidenten_broj)));
  if (!Number.isFinite(eb) || eb <= 0) return null;
  const lat = num(r.lat);
  const lon = num(r.lon);
  const geoRaw = str(r.geo_source).trim();
  const prop: Property = {
    eb,
    id: eb,
    uuid: typeof r.id === 'string' ? r.id : undefined,
    address: cleanMacedonian(titleCase(str(r.adresa) || str(r.naslov))) || `Имот ЕБ ${eb}`,
    price: num(r.cena_eur),
    priceLabel: str(r.cena_label) || undefined,
    location: str(r.naselba) || undefined,
    lat: lat !== undefined ? lat : undefined,
    lon: lon !== undefined ? lon : undefined,
    geo_source: lat !== undefined && lon !== undefined && GEO_SOURCES.has(geoRaw)
      ? geoRaw as GeoSource : undefined,
    geocoded_at: str(r.geocoded_at) || undefined,
    bedrooms: isBusiness(r) ? undefined : parseBedrooms(r.tip_na_sobi),
    // povrsina_m2 = 0 means MISSING (the scraper writes 0 when the ad has no
    // area). A 0 m² property does not exist — treat as absent so the card
    // never prints "Има 0 м² деловна површина" (the EB 57 transcript bug).
    sqm: num(r.povrsina_m2) || undefined,
    business: isBusiness(r) && !isPlac(r),
    house: isHouse(r) && !isPlac(r),
    plac: isPlac(r),
    size: (num(r.povrsina_m2) ?? 0) > 0 ? `${r.povrsina_m2} м²` : undefined,
    features: featurePhrases(r),
    details: cleanMacedonian(str(r.opis)) || undefined,
    gmaps: str(r.gmaps) || undefined,
    landmarks: parseFeedLandmarks(r.landmarks),
    url: str(r.url) || undefined,
    service: parseService(r.servis),
    raw: r,
  };
  const li = LANDLORD_DATA.get(prop.eb);
  if (li) prop.landlordName = li.name;
  return prop;
}

// --- Macedonian Latin<->Cyrillic location matching ---------------------------
// Clients write in Latin script ("CENTAR", "KAPISTEC", "DEBAR MAALO") while the
// feed stores Cyrillic ("Центар", "Капиштец"). A plain substring compare fails
// across scripts — the reason searches returned 0 despite matching offers.
// We compare canonical KEYS: the raw string plus its transliterations.

const MK_LAT2CYR: Array<[string, string]> = [
  ['lj', 'љ'], ['nj', 'њ'], ['dj', 'ѓ'], ['gj', 'ѓ'], ['kj', 'ќ'],
  ['zh', 'ж'], ['ch', 'ч'], ['dz', 'џ'], ['sh', 'ш'],
  ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'], ['e', 'е'],
  ['z', 'з'], ['i', 'и'], ['j', 'ј'], ['k', 'к'], ['l', 'л'], ['m', 'м'],
  ['n', 'н'], ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'],
  ['u', 'у'], ['f', 'ф'], ['h', 'х'], ['c', 'ц'], ['y', 'ј'],
];

// Loose Latin→Cyrillic: "dj" → "џ" (Skopje informal Latin uses "dj" for both ѓ
// and џ — "madjari" = Маџари, not Маѓари). Used alongside MK_LAT2CYR in
// locKeys so both interpretations are tried.
const MK_LAT2CYR_LOOSE: Array<[string, string]> = [
  ['lj', 'љ'], ['nj', 'њ'], ['dj', 'џ'], ['gj', 'ѓ'], ['kj', 'ќ'],
  ['zh', 'ж'], ['ch', 'ч'], ['dz', 'џ'], ['sh', 'ш'],
  ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'], ['e', 'е'],
  ['z', 'з'], ['i', 'и'], ['j', 'ј'], ['k', 'к'], ['l', 'л'], ['m', 'м'],
  ['n', 'н'], ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'],
  ['u', 'у'], ['f', 'ф'], ['h', 'х'], ['c', 'ц'], ['y', 'ј'],
];

const MK_CYR2LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ѓ: 'gj', е: 'e', ж: 'zh', з: 'z',
  ѕ: 'dz', и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', ќ: 'kj', у: 'u', ф: 'f', х: 'h',
  ц: 'c', ч: 'ch', џ: 'dz', ш: 'sh',
};

// Informal Skopje Latin: ш->s ("kapistec" for Капиштец), ќ->k, ѓ->g, ч->c.
const MK_LOOSE: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ѓ: 'g', е: 'e', ж: 'z', з: 'z',
  ѕ: 'dz', и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', ќ: 'k', у: 'u', ф: 'f', х: 'h',
  ц: 'c', ч: 'c', џ: 'dz', ш: 's',
};

function latToCyr(s: string, table: Array<[string, string]> = MK_LAT2CYR): string {
  const low = s.toLowerCase();
  let out = '';
  let i = 0;
  while (i < low.length) {
    const pair = low.slice(i, i + 2);
    const hit = table.find(([k]) => k === pair);
    if (hit) { out += hit[1]; i += 2; continue; }
    const single = table.find(([k]) => k === low[i]);
    out += single ? single[1] : low[i];
    i += 1;
  }
  return out;
}

function cyrToLat(s: string, table: Record<string, string>): string {
  let out = '';
  for (const ch of s.toLowerCase()) out += table[ch] ?? ch;
  return out;
}

// Common Latin misspellings / Skopje typing confusions → canonical Cyrillic.
// "u" vs "v" (у/в), "dj" vs "dz" (ѓ/џ), informal abbreviations.
// Comprehensive Latin → Cyrillic aliases for ALL Skopje neighborhoods.
// Covers: standard transliteration, informal variants, u/v confusion, dj/dz confusion,
// short forms, common misspellings, and TYPED TYPOS (missing/extra/wrong letters).
// Comprehensive Latin → Cyrillic aliases for ALL Skopje neighborhoods.
// Covers: standard transliteration, informal variants, u/v confusion, dj/dz confusion,
// short forms, common misspellings, and TYPED TYPOS (missing/extra/wrong letters).
const LAT_ALIASES: Record<string, string> = {
  'centar': 'центар', 'tsentar': 'центар', 'center': 'центар',
  'cenar': 'центар', 'cntar': 'центар', 'cnetar': 'центар',
  'cenatar': 'центар', 'sentar': 'центар', 'zentar': 'центар',
  'karpos': 'карпош', 'karposh': 'карпош', 'karpossh': 'карпош',
  'karpos III': 'карпош iii', 'karpos3': 'карпош iii', 'karpos ii': 'карпош ii',
  'karps': 'карпош', 'karpoo': 'карпош', 'karpso': 'карпош',
  'karposhe': 'карпош', 'krapos': 'карпош', 'karpossho': 'карпош',
  'aerodrom': 'аеродром', 'aerodrom skopje': 'аеродром', 'aerdrom': 'аеродром',
  'aerodr': 'аеродром', 'aerodromm': 'аеродром', 'aerodroom': 'аеродром',
  'kisela voda': 'кисела вода', 'kisela': 'кисела вода', 'kisela-voda': 'кисела вода',
  'kiselavoda': 'кисела вода', 'kisla voda': 'кисела вода', 'kisela vod': 'кисела вода',
  'kissela': 'кисела вода', 'kisella': 'кисела вода', 'kapishtec': 'капиштец',
  'kapistec': 'капиштец', 'kapishtets': 'капиштец', 'kapistets': 'капиштец',
  'kapishtez': 'капиштец', 'kapistez': 'капиштец', 'kapishtezc': 'капиштец',
  'kappishtec': 'капиштец', 'cair': 'чаир', 'chair': 'чаир',
  'chayir': 'чаир', 'cahir': 'чаир', 'chayr': 'чаир',
  'cairr': 'чаир', 'chayri': 'чаир', 'caeri': 'чаир',
  'taftalidze': 'тафталиџе', 'taftalidje': 'тафталиџе', 'taftalidge': 'тафталиџе',
  'taftaldze': 'тафталиџе', 'taftalide': 'тафталиџе', 'taftalizhe': 'тафталиџе',
  'taftalidzhe': 'тафталиџе', 'madjari': 'маџари', 'madzhari': 'маџари',
  'madzari': 'маџари', 'majiari': 'маџари', 'madari': 'маџари',
  'madiari': 'маџари', 'madjri': 'маџари', 'majari': 'маџари',
  'madjarii': 'маџари', 'mdjari': 'маџари', 'vlae': 'влае',
  'vlae skopje': 'влае', 'vlaje': 'влае', 'vlajе': 'влае',
  'vlaj': 'влае', 'vlaee': 'влае', 'novo lisice': 'ново лисиче',
  'novo lisitche': 'ново лисиче', 'novo-lisice': 'ново лисиче', 'novo lisiche': 'ново лисиче',
  'novo lissice': 'ново лисиче', 'lisice': 'лисиче', 'lisitche': 'лисиче',
  'lisiche': 'лисиче', 'lissice': 'лисиче', 'lisicee': 'лисиче',
  'vodno': 'водно', 'vodno skopje': 'водно', 'vodnoo': 'водно',
  'vodnno': 'водно', 'kozle': 'козле', 'kozle skopje': 'козле',
  'kozzle': 'козле', 'kozlee': 'козле', 'kozlе': 'козле',
  'skopje sever': 'скопје север', 'skopje-sever': 'скопје север', 'sever': 'скопје север',
  'skopje severr': 'скопје север', 'skopjee sever': 'скопје север', 'skopje svr': 'скопје север',
  'debar maalo': 'дебар маало', 'debar-maalo': 'дебар маало', 'debar': 'дебар маало',
  'debaar': 'дебар маало', 'debar malo': 'дебар маало', 'debar maallo': 'дебар маало',
  'debar maalо': 'дебар маало', 'debar maao': 'дебар маало', 'gazi baba': 'гази баба',
  'gazi-baba': 'гази баба', 'gazii baba': 'гази баба', 'gazi babа': 'гази баба',
  'gazibaba': 'гази баба', 'gazi babbа': 'гази баба', 'butel': 'бутел',
  'butel skopje': 'бутел', 'buutel': 'бутел', 'butell': 'бутел',
  'buttel': 'бутел', 'ilinden': 'илинден', 'ilindenn': 'илинден',
  'ilindan': 'илинден', 'iliden': 'илинден', 'saraj': 'сарай',
  'saray': 'сарай', 'sarrai': 'сарай', 'saraaj': 'сарай',
  'saraji': 'сарай', 'djorce petrov': 'ѓорче петров', 'gorce petrov': 'ѓорче петров',
  'dorce petrov': 'ѓорче петров', 'djorce': 'ѓорче петров', 'gorce': 'ѓорче петров',
  'djorcepetrov': 'ѓорче петров', 'djorcee petrov': 'ѓорче петров', 'djorche petrov': 'ѓорче петров',
  'gorche petrov': 'ѓорче петров', 'djorce petrovv': 'ѓорче петров', 'dordje petrov': 'ѓорче петров',
  'dorce petrovv': 'ѓорче петров', 'djorce pertov': 'ѓорче петров', 'djorcee': 'ѓорче петров',
  'gorche': 'ѓорче петров', 'dorce': 'ѓорче петров', 'autokomanda': 'автокоманда',
  'autokomnada': 'автокоманда', 'avtokomanda': 'автокоманда', 'auto komanda': 'автокоманда',
  'avtokmmanda': 'автокоманда', 'avtokomannda': 'автокоманда', 'autokomanada': 'автокоманда',
  'avtokmanda': 'автокоманда', 'autokomandaa': 'автокоманда', 'avtokomandaa': 'автокоманда',
  'auto-komanda': 'автокоманда', 'autokkomanda': 'автокоманда', 'crnice': 'црниче',
  'crnise': 'црниче', 'crnishe': 'црниче', 'crnicee': 'црниче',
  'crnnice': 'црниче', 'crnisee': 'црниче', 'crniche': 'црниче',
  'crniice': 'црниче', 'radishani': 'радишани', 'radisani': 'радишани',
  'radishanii': 'радишани', 'radishany': 'радишани', 'hrom': 'хром',
  'hroom': 'хром', 'hromm': 'хром', 'hrom skopje': 'хром',
  'zelezara': 'железара', 'zelezara skopje': 'железара', 'zelezarra': 'железара',
  'zeleezara': 'железара', 'zelezaraa': 'железара', 'zelezzara': 'железара',
  'shuto orizari': 'шуто оризари', 'shuto-orizari': 'шуто оризари', 'shuto': 'шуто оризари',
  'shuto orizarii': 'шуто оризари', 'shuto orizarri': 'шуто оризари', 'shutoo orizari': 'шуто оризари',
  'przhino': 'пржино', 'przino': 'пржино', 'przhno': 'пржино',
  'przhinno': 'пржино', 'momin potok': 'момин поток', 'momin-potok': 'момин поток',
  'momin potokk': 'момин поток', 'momin pootok': 'момин поток', 'mominn potok': 'момин поток',
  'beg': 'бег', 'beg skopje': 'бег', 'beeg': 'бег',
  'begg': 'бег', 'zlokukani': 'злокуќани', 'zlokutcani': 'злокуќани',
  'zlokuqani': 'злокуќани', 'vizbegovo': 'визбегово', 'vizbeg': 'визбегово',
  'vizbeegovo': 'визбегово', 'vizbeggovo': 'визбегово', 'dracevo': 'драчево',
  'drachevo': 'драчево', 'drachevо': 'драчево', 'draceevо': 'драчево',
  'dracevо': 'драчево', 'drachevoo': 'драчево', 'dracevvo': 'драчево',
  'dracevoo': 'драчево', 'singelik': 'сингелиќ', 'singelic': 'сингелиќ',
  'singelik skopje': 'сингелиќ', 'singellik': 'сингелиќ', 'singelikk': 'сингелиќ',
  'novo madjari': 'ново маџари', 'novo madzhari': 'ново маџари', 'novo-madjari': 'ново маџари',
  'novo madari': 'ново маџари', 'novo madjri': 'ново маџари', 'novo madjarii': 'ново маџари',
  'novo majari': 'ново маџари',
};

/** Canonical matching keys: raw + transliterations, lowercased, single-spaced. */
function locKeys(s: string): Set<string> {
  const low = s.toLowerCase().trim().replace(/\s+/g, ' ');
  const keys = new Set<string>([low]);
  keys.add(cyrToLat(low, MK_CYR2LAT));   // "капиштец" -> "kapishtec"
  keys.add(cyrToLat(low, MK_LOOSE));     // "капиштец" -> "kapistec"
  const fromLat = latToCyr(low);              // "centar" -> "центар"
  if (fromLat !== low) keys.add(fromLat);
  const fromLatLoose = latToCyr(low, MK_LAT2CYR_LOOSE); // "madjari" -> "маџари"
  if (fromLatLoose !== low && fromLatLoose !== fromLat) keys.add(fromLatLoose);
  // Explicit alias: "autokomanda" → "автокоманда" (u/v confusion)
  // Check both the full string AND individual words ("madjari ili autokomanda")
  const alias = LAT_ALIASES[low]
    // Also try the alias with a leading preposition stripped — a QUERY like
    // 'vo novo madjari' must reach the compound alias ('novo madjari' →
    // 'ново маџари') or it can never match its own neighborhood.
    ?? LAT_ALIASES[low.replace(/^(?:vo|во|во|na|на)\s+/iu, '')];
  if (alias) keys.add(alias);
  for (const word of low.split(/\s+/)) {
    const wAlias = LAT_ALIASES[word];
    if (!wAlias) continue;
    // Sibling-settlement guard: 'novo lisice' must not gain the bare-base key
    // ('lisice' → 'лисиче') — that would merge Ново Лисиче with Лисиче, two
    // DIFFERENT municipalities. When every OTHER word of the query (leading
    // prepositions stripped) is a settlement modifier, the word IS the
    // compound's base — skip the alias. Bare 'lisice' and 'karpos 3' still
    // get theirs.
    const rest = low.split(/\s+/).filter(w => w !== word && !PREP_TOKENS.has(w));
    if (rest.length > 0 && rest.every(w => SETTLEMENT_MOD_WORDS.has(w))) continue;
    keys.add(wAlias);
  }
  return keys;
}

// CITY ≠ DISTRICT: a feed location that is a SUB-DISTRICT of the city
// ("Скопје Север") must NOT be matched by a bare city mention ("skopje",
// "во Скопје", "sakam stan vo skopje") — the city word is embedded in every
// such district name, so it carries no district identity. Enforced at the
// WORD-overlap stage below by excluding city tokens; a real district ask
// ("skopje sever", alias "sever") still matches at the KEY level via the
// alias map, and a feed location that IS the bare city matches there too.
const CITY_TOKEN_RE = /^(?:скопје|skopje|skapje)$/iu;
const _stripCityWords = (ws: string[]): string[] => ws.filter(w => !CITY_TOKEN_RE.test(w));

// SIBLING SETTLEMENTS: 'Ново Лисиче' is NOT a superset of 'Лисиче' — they are
// adjacent but distinct municipalities (same for 'Ново Маџари' vs 'Маџари',
// and any старо/горно/долно pair). Two keys that become EQUAL after stripping
// a leading/trailing modifier denote DIFFERENT places, so the containment and
// word-overlap stages below must never merge them. (A sub-district like
// 'Карпош III' inside 'Карпош' still matches — the modifier rule does not
// fire because the strings differ by the NUMBER, not by a modifier.)
const SETTLEMENT_MODIFIER_RE = /^(?:ново|старо|горно|долно|novo|staro|gorno|dolno)\s+|\s+(?:ново|старо|горно|долно|novo|staro|gorno|dolno)$/iu;
const _stripSettlementModifier = (s: string): string => s.replace(SETTLEMENT_MODIFIER_RE, '');
const _siblingSettlements = (a: string, b: string): boolean => {
  const sa = _stripSettlementModifier(a);
  const sb = _stripSettlementModifier(b);
  return (sa !== a || sb !== b) && sa === sb;
};
// Modifier words, used word-wise: a token flanked by one of these belongs to a
// COMPOUND name ('novo lisice'), so the bare token must not independently
// match a feed location ('Лисиче') in the word-overlap stage. Modifier tokens
// themselves are never place names and never match either.
const SETTLEMENT_MOD_WORDS = new Set(['ново', 'старо', 'горно', 'долно', 'novo', 'staro', 'gorno', 'dolno']);
// Leading prepositions are stripped before alias/modifier logic — 'vo' is
// grammar, not geography.
const PREP_TOKENS = new Set(['vo', 'во', 'во', 'na', 'на', 'u', 'у']);
const _modAdjacent = (ws: string[], i: number): boolean =>
  (i > 0 && SETTLEMENT_MOD_WORDS.has(ws[i - 1])) || (i < ws.length - 1 && SETTLEMENT_MOD_WORDS.has(ws[i + 1]));
/** Word-boundary containment that rejects mid-word overlaps ('novo lisice'
 *  does NOT contain 'vo lisice' — the match starts inside 'novo') and overlaps
 *  preceded by a settlement modifier ('novo lisice, karpos' does not contain
 *  bare 'lisice' — that token names the SIBLING settlement). */
function _containsLoc(small: string, big: string): boolean {
  if (!small || small.length > big.length) return false;
  const isWordCh = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
  let from = 0;
  for (;;) {
    const i = big.indexOf(small, from);
    if (i === -1) return false;
    const j = i + small.length;
    const beforeOk = i === 0 || !isWordCh(big[i - 1]);
    const afterOk = j === big.length || !isWordCh(big[j]);
    if (beforeOk && afterOk) {
      // Which word precedes the match? If it is a settlement modifier, the
      // contained name is a compound's base — not the same place.
      const head = big.slice(0, i).trim().split(/\s+/).filter(Boolean);
      const prev = head.length > 0 ? head[head.length - 1] : '';
      if (!prev || !SETTLEMENT_MOD_WORDS.has(prev)) return true;
    }
    from = i + 1;
  }
}

export function locMatches(query: string, feedLoc: string): boolean {
  const qk = [...locKeys(query)].filter(k => k.length >= 2);
  const lk = [...locKeys(feedLoc)].filter(k => k.length >= 2);
  if (!qk.length || !lk.length) return false; // a property with NO location never matches a location query
  for (const a of qk) {
    for (const b of lk) {
      // City ≠ district at KEY level: a bare city key ("skopje") must not be
      // swallowed by a multi-word district key that merely embeds the city
      // word ("skopje sever"). The reverse (district ask → bare-city feed)
      // stays a match: the district IS inside the city.
      const aw0 = a.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      const bw0 = b.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      if (aw0.length === 1 && CITY_TOKEN_RE.test(aw0[0]) && bw0.length > 1) continue;
      // Identical keys always match — MUST be checked before the sibling
      // guard, which fires on any compound vs itself ('ново лисиче' strips to
      // 'лисиче' on both sides).
      if (a === b) return true;
      // Sibling settlements (Ново Лисиче vs Лисиче) are distinct places —
      // neither containment nor word-overlap may merge them.
      if (_siblingSettlements(a, b)) continue;
      if (_containsLoc(a, b) || _containsLoc(b, a)) return true;
      // Word-level: "sto imas vo karpos" contains the word "karpos", which is
      // a transliterated word of "Карпош III" — a client naming just the base
      // neighborhood must still match a multi-word feed location. Only words
      // >= 5 chars participate (short words like "вода"/"влае" would collide;
      // short EXACT names already match via the containment check above).
      // Split on punctuation too: "centar, kisela voda" must yield the word
      // "centar" (a trailing comma used to break the match entirely).
      // MODIFIER-ADJACENT tokens ("lisice" inside "novo lisice") and modifier
      // words themselves are excluded — the compound names a DIFFERENT
      // settlement than the bare token.
      const bare = (toks: string[]) => toks.map((w, i) => ({ w, mod: _modAdjacent(toks, i) }))
        .filter(x => x.w.length >= 5 && !CITY_TOKEN_RE.test(x.w) && !x.mod && !SETTLEMENT_MOD_WORDS.has(x.w))
        .map(x => x.w);
      const aw = bare(aw0);
      const bw = bare(bw0);
      if (aw.some(w => bw.includes(w))) return true;
    }
  }
  return false;
}

/** Display form: Latin-typed locations are transliterated to canonical Cyrillic.
 *  Only when the string has NO Cyrillic at all — "Карпош III" must never become
 *  "Карпош иии" (the roman numeral is latin, not a latin spelling of the name). */
/** Display form for TIME phrases ("utre vo 16:00" → "Утре во 16:00"):
 *  Latin → Cyrillic, first letter capitalized — never titleCase (mid-phrase
 *  "во" is grammar, not a place name) and never alias canonicalization.
 *  Used by the owner ping-pong relay; normalizeLocation is for PLACES. */
export function normalizeTimePhrase(s: string): string {
  const src = s.trim();
  const hasCyr = /[\u0400-\u04FF]/u.test(src);
  if (!hasCyr) {
    // English day slips ("Friday vo 10") must become Macedonian BEFORE the
    // Latin→Cyrillic transliteration — after it the day is a Cyrillic word
    // ("Фридај") that no display fix can recognize (sweep owner-fixed-clock).
    let pre = src;
    for (const [en, mk] of Object.entries(EN_DAY_TO_MK)) {
      pre = pre.replace(new RegExp(`\\b${en}\\b`, 'gi'), mk);
    }
    const cyr = latToCyr(pre);
    return cyr.charAt(0).toUpperCase() + cyr.slice(1);
  }
  return src.charAt(0).toUpperCase() + src.slice(1);
}

/** English day names the LLM classify leg sometimes canonizes visit times
 *  into ("Friday 18:00" instead of "Петок во 18:00"). The relays and the
 *  owner ask echo the slot VERBATIM — an English day in a Macedonian
 *  client-facing sentence reads as a different language mid-conversation. */
const EN_DAY_TO_MK: Record<string, string> = {
  monday: 'понеделник', tuesday: 'вторник', wednesday: 'среда',
  thursday: 'четврток', friday: 'петок', saturday: 'сабота', sunday: 'недела',
};
/** Known owner day misspellings (Gemini sweep owner-whole-day): display
 *  canonicalization for both scripts — the owner's words are parsed as-is
 *  but the client-facing relay reads proper Macedonian. */
const MK_DAY_FIX: Array<[RegExp, string]> = [
  [/(?<![\p{L}])средота|(?<![\p{L}])сретта|(?<![\p{L}])срета|(?<![\p{L}])средта/giu, 'среда'],
  [/(?<![\p{L}])цетврток/giu, 'четврток'],
  [/(?<![\p{L}])втрик|(?<![\p{L}])вторик/giu, 'вторник'],
  [/(?<![\p{L}])сабта|(?<![\p{L}])субота/giu, 'сабота'],
  [/(?<![\p{L}])петк/giu, 'петок'],
  [/(?<![a-z])sredta|(?<![a-z])sreta/gi, 'среда'],
  [/(?<![a-z])cetvrtok|(?<![a-z])četvrtok/gi, 'четврток'], // c→ц translit ambiguity: the word needs ч
  [/(?<![a-z])vtorik|(?<![a-z])vtrik/gi, 'вторник'],
  [/(?<![a-z])sabta|(?<![a-z])subota/gi, 'сабота'],
  [/(?<![a-z])petk/gi, 'петок'],
  [/(?<![a-z])vikendov|(?<![a-z])vikendo/gi, 'викенд'],
  [/(?<![a-z])nedella/gi, 'недела'],
];
/** Mixed-script guard: a phrase that already carries Cyrillic (client's own
 *  words like "VO NEDELA RABOTITE ?") is displayed untouched by the Latin
 *  map — but known day misspellings are fixed in BOTH scripts. */
export function mkTimePhrase(s: string): string {
  const raw = (s ?? '').trim();
  let src = raw;
  // Day fixes run FIRST and in BOTH scripts (case-insensitive — owners
  // capitalize "Средота"). Latin mapping below runs only when the ORIGINAL
  // text carried no Cyrillic: the client's own mixed-script words are
  // preserved, a fixed misspelling never blocks the display path.
  for (const [re, fix] of MK_DAY_FIX) src = src.replace(re, fix);
  if (!src) return src;
  const hadCyr = /[\u0400-\u04FF]/u.test(raw);
  if (!hadCyr) {
    for (const [en, mk] of Object.entries(EN_DAY_TO_MK)) {
      src = src.replace(new RegExp(`\\b${en}\\b`, 'gi'), mk);
    }
  }
  return src.charAt(0).toUpperCase() + src.slice(1);
}

/**
 * Areas that take НА instead of ВО in Macedonian: mountain/height locations.
 * Водно is a mountain (Водно — планина) — "на Водно", like "на планина".
 * Every other neighborhood uses во. The article form is ГТО-annotated:
 * "на Водното" when the definite suffix fuses (amplitude: во→во / на→на).
 */
export const NA_LOCATIONS = new Set(['водно', 'vodno']);

/** Definite-suffix areas needing special preposition agreement — reserved. */
export const NA_LOCATION_DEFINITE: Record<string, string> = {};

/**
 * The correct Macedonian preposition for a location: "на Водно" (mountain
 * area) but "во Центар" everywhere else. Used by every code-built sentence
 * that places a property in its neighborhood.
 */
export function locPrep(loc: string): 'во' | 'на' {
  return NA_LOCATIONS.has(loc.trim().toLowerCase()) ? 'на' : 'во';
}

export function normalizeLocation(s: string): string {
  const src = s.trim();
  const hasCyr = /[\u0400-\u04FF]/u.test(src);
  const cyr = hasCyr ? src : latToCyr(src);
  // Canonicalize to the FEED spelling when an alias maps to it ('novo lisice'
  // → 'Ново Лисиче', never the raw transliteration 'Ново лисице') — slots
  // echo in recaps and no-match lines, so the display form must be a real
  // neighborhood name. Try the original string first (Latin aliases are keyed
  // by their Latin spellings), then the transliterated form. titleCase
  // restores the feed's per-word capitals ('ново лисиче' → 'Ново Лисиче');
  // roman numerals stay uppercase ('карпош iii' → 'Карпош III').
  const canon = LAT_ALIASES[src.toLowerCase()] ?? LAT_ALIASES[cyr.toLowerCase()];
  const shown = canon ?? cyr;
  return titleCase(shown).replace(/\b(?:i{1,3}|iv|vi{1,3})\b/gi, m => m.toUpperCase());
}

/**
 * Full public URL for a property listing. The feed stores only the relative
 * path ("/property/<uuid>") — customers need a clickable full link, so we
 * prepend the public site (currently the Lovable app; Cloudflare later — see
 * PUBLIC_SITE_URL). Already-absolute URLs pass through untouched.
 */
export function publicPropertyUrl(url: string | undefined, base: string): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `${base.replace(/\/+$/, '')}${url}`;
  return undefined;
}

/**
 * "Garsonjera" — the STUDIO category: a small residential unit (≤ 35 м²),
 * described as one in the ad text or simply small. The 19:34 bug mapped
 * "garsonjera mi treba" to bedrooms=1 and the no-match layer invented
 * "стан со една спална" nobody asked for — the category is a TYPE, not a
 * спални count. Ad-text matching deliberately EXCLUDES bare "студио":
 * listings say "модно студио"/"фото студио" (a fashion/photo studio IN the
 * apartment) — the live feed's EB 50 (74 м²) sneaked through that way.
 */
export function isSmallUnit(p: Property): boolean {
  if (/гарсоњер|garsonjer/i.test(p.details ?? '')) return true;
  const m = p.size?.match(/(\d+)/);
  const sqm = m ? parseInt(m[1], 10) : p.sqm;
  return Number.isFinite(sqm) && (sqm as number) > 0 && (sqm as number) <= 35;
}

/**
 * TRUE when the feed address is a non-answer — the agency never learned it.
 * The CRM carries rows imported without a real street: the literal
 * "НЕПОЗНАТА"/"Непозната" (EB 58's manual entry), its Latin spelling, or an
 * empty field. A keyboard-mash address ("Фгхфгхфгхфгх") is NOT included:
 * mash is a data-entry bug to delete upstream, not a state to answer around.
 * (Test row EB 39 was deleted from the CRM on 2026-09-12 for exactly that.)
 *
 * Where this gate leads: every location-claiming reply (where-is landmark,
 * nearby rotation, exact-address line) must serve the honest
 * location.unknown protocol instead of inventing geography from nothing.
 * Downstream the runtime also caps what these rows can claim — coords on an
 * addressless row are neighborhood-context, never building truth.
 */
export function isAddressUnknown(p: Property): boolean {
  return !p.address || p.address === `Имот ЕБ ${p.eb}` || /непозната|nepoznata/i.test(p.address);
}

/** Parse a budget string to its maximum euros: "до 80.000" -> 80000, "80-100" -> 100. */
function parseBudgetMax(s: string): number | undefined {
  const nums: number[] = [];
  const re = /(\d[\d\s.]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const cleaned = m[1].replace(/[\s.]/g, '');
    const n = Number(cleaned);
    if (Number.isFinite(n) && n > 0) nums.push(n);
  }
  if (!nums.length) return undefined;
  return Math.max(...nums);
}

// The most-sought neighborhoods, in the order the agency presents city-wide
// ("било каде") searches: Центар, Капиштец, Карпош, Аеродром, Кисела Вода,
// Влае, Ѓорче Петров — then everything else. Matched against each property's
// feed location ("Карпош III" → Карпош) with the same containment-aware
// matcher as the search.
export const NEIGHBORHOOD_POPULARITY = [
  'Центар', 'Капиштец', 'Карпош', 'Аеродром', 'Кисела Вода', 'Влае', 'Ѓорче Петров',
];

function popularityRank(loc: string | undefined): number {
  if (!loc) return NEIGHBORHOOD_POPULARITY.length;
  for (let i = 0; i < NEIGHBORHOOD_POPULARITY.length; i++) {
    if (locMatches(NEIGHBORHOOD_POPULARITY[i], loc)) return i;
  }
  return NEIGHBORHOOD_POPULARITY.length;
}

export class PropertyService {
  private cache: { at: number; data: Property[] } | null = null;
  private ok = false;

  constructor(private url: string, private ttlMs = 5 * 60_000) {}

  /** Whether we have trustworthy feed data. False after a failed fetch with no cache
   *  — callers must NOT claim "no matching properties" when the feed is simply down. */
  get healthy(): boolean {
    return this.ok;
  }

  /** The set of valid Евидентен броеви — for validating EBs the client
   *  mentioned (recommendation flow). Cheap: reuses the feed cache. */
  async getAllEbs(): Promise<Set<number>> {
    const all = await this.getAll();
    return new Set(all.map(p => p.eb));
  }

  async getAll(): Promise<Property[]> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.data;
    // TWO attempts, fresh 8s budget each: the feed is a Supabase edge function
    // whose cold starts occasionally blow one 8s window ("This operation was
    // aborted" in production). A single retry absorbs that without ever
    // doubling a real 4xx — only network/timeout/5xx classes are retried.
    const FETCH_TIMEOUT_MS = 8_000;
    const ATTEMPTS = 2;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(this.url, { signal: ctrl.signal });
        if (!res.ok && res.status < 500) throw new Error(`HTTP ${res.status}`); // no retry for 4xx
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { properties?: Record<string, unknown>[] };
        const rows = Array.isArray(body) ? body : (body.properties ?? []);
        const data = rows.map(mapRow).filter((p): p is Property => p !== null);
        this.cache = { at: Date.now(), data };
        this.ok = true;
        return data;
      } catch (e) {
        const msg = (e as Error).message;
        const retryable = attempt < ATTEMPTS && (msg.includes('aborted') || msg.includes('fetch failed') || /HTTP 5\d\d/.test(msg));
        if (retryable) {
          console.error(`[properties] fetch attempt ${attempt} failed (${msg}) — retrying once`);
          continue;
        }
        console.error('[properties] fetch failed:', msg);
        if (!this.cache) this.ok = false; // stale cache is still real data; only distrust an empty hand
        return this.cache?.data ?? [];
      } finally {
        clearTimeout(timer);
      }
    }
    return this.cache?.data ?? []; // unreachable — the loop always returns/throws
  }

  /** Lookup by Евидентен број — the only correct identity. */
  async getByEb(eb: number): Promise<Property | undefined> {
    const all = await this.getAll();
    return all.find(p => p.eb === eb);
  }

  async getById(id: number): Promise<Property | undefined> {
    return this.getByEb(id);
  }

  /** Unique non-empty locations present in the feed, longest first (most specific wins). */
  async locations(): Promise<string[]> {
    const all = await this.getAll();
    const set = new Set<string>();
    for (const p of all) {
      const loc = (p.location ?? '').trim();
      if (loc) set.add(loc);
    }
    return [...set].sort((a, b) => b.length - a.length);
  }

  async search(opts: { location?: string; bedrooms?: number; sqm?: number; business?: boolean; house?: boolean; service?: Service; budget?: string }): Promise<Property[]> {
    const all = await this.getAll();
    let out = all;
    if (opts.service) out = out.filter(p => !p.service || p.service === opts.service);
    if (opts.business === true) out = out.filter(p => p.business === true);
    else if (opts.business === false) out = out.filter(p => !p.business); // a "стан" search never shows offices
    if (opts.house === true) out = out.filter(p => p.house === true);
    else if (opts.house === false) out = out.filter(p => !p.house); // a "стан" search never shows houses
    if (opts.location) {
      out = out.filter(p => {
        const loc = (p.location ?? '').trim();
        return loc && locMatches(opts.location as string, loc);
      });
    }
    if (opts.bedrooms) out = out.filter(p => !p.bedrooms || p.bedrooms >= (opts.bedrooms as number));
    if (opts.sqm) out = out.filter(p => !p.sqm || p.sqm >= (opts.sqm as number)); // commercial spaces: size instead of bedrooms
    // Budget is a hard filter — the LLM must never be handed above-budget
    // offers (it correctly "finds nothing" and misreports availability).
    if (opts.budget) {
      const max = parseBudgetMax(opts.budget);
      if (max) out = out.filter(p => p.price === undefined || p.price <= max);
    }
    return out;
  }

  /**
   * Closest matches for a SEEN property the client can't number: ranked by
   * how close each property is to what the client REMEMBERS (населба, цена,
   * квадрати) — approximate, never hard filters ("околу 70.000 евра" must not
   * exclude a 72.000 match). Same-area first, then price distance, then sqm
   * distance; within ties by EB. Excludes already-shown EBs so every round
   * presents fresh candidates.
   */
  async closestMatches(opts: {
    location?: string; price?: number; sqm?: number;
    business?: boolean; house?: boolean; service?: Service; exclude?: number[];
    plac?: boolean; yard?: boolean;
  }): Promise<Property[]> {
    const all = await this.getAll();
    const exclude = new Set(opts.exclude ?? []);
    const inLoc = (p: Property): boolean =>
      opts.location ? locMatches(opts.location, p.location ?? '') : true;
    const priceDist = (p: Property): number =>
      opts.price !== undefined && p.price !== undefined ? Math.abs(p.price - opts.price) : 0;
    const sqmDist = (p: Property): number =>
      opts.sqm !== undefined && p.sqm !== undefined ? Math.abs(p.sqm - opts.sqm) : 0;
    return all
      .filter(p => !exclude.has(p.eb))
      .filter(p => !opts.service || !p.service || p.service === opts.service)
      .filter(p => opts.business === true ? p.business === true : opts.business === false ? !p.business : true)
      .filter(p => opts.house === true ? p.house === true : opts.house === false ? !p.house : true)
      .filter(p => opts.plac ? p.plac === true : true)
      .map(p => ({
        p,
        score: (inLoc(p) ? 0 : 1_000_000) + priceDist(p) + sqmDist(p) * 500, // м² → €-ish weight
      }))
      .sort((a, b) => a.score - b.score || a.p.eb - b.p.eb)
      .map(s => s.p);
  }

  /**
   * Ordered alternative candidates: requested location FIRST, then within it by
   * price-proximity to the budget (cheapest first when no budget). Excludes
   * already-shown EBs so every batch is new.
   *
   * AREA INTEGRITY: an area-naming request NEVER spills to other areas — the
   * offers stay inside the selected area(s), and an area with nothing returns []
   * so the funnel ASKS whether to look elsewhere before presenting anything
   * else ("Ги исцрпивме… или да погледнеме во друга населба?"). A "во Карпош?"
   * request is never answered with a Маџари property to fill a slot.
   */
  async candidates(opts: {
    location?: string; bedrooms?: number; sqm?: number; business?: boolean; house?: boolean;
    garsonjera?: boolean; plac?: boolean; yard?: boolean; service?: Service; budget?: string; exclude?: number[]; sortBySqm?: boolean;
    bedroomsMin?: number; bedroomsMax?: number; // bedroom RANGE ([09:17]): exact-category pool, both ends REQUIRED
    sortBySqmDesc?: boolean; // "nebitno" (size waived): BIGGEST м² first — the money buys space
    sortByPopularity?: boolean; // "било каде" — most popular neighborhoods first
  }): Promise<Property[]> {
    const all = await this.getAll();
    const exclude = new Set(opts.exclude ?? []);
    const max = opts.budget ? parseBudgetMax(opts.budget) : undefined;
    const inLoc = (p: Property): boolean =>
      opts.location ? locMatches(opts.location, p.location ?? '') : true;
    const base = all
      .filter(p => !exclude.has(p.eb))
      .filter(p => !opts.service || !p.service || p.service === opts.service)
      .filter(p => opts.business === true ? p.business === true : opts.business === false ? !p.business : true)
      .filter(p => opts.house === true ? p.house === true : opts.house === false ? !p.house : true)
      // PLAC / YARD (the 22:53 sweep, exhausted-pivot family): a land-plot ask
      // filters to plac rows ONLY (a плac is never answered with flats); when
      // the feed has none the yard/pivot flow releases downstream (the wide
      // retry clears the location, never the category — a плац stays a плац).
      // A yard need rides on house ("a kukuca so sopstven dvor" → house rows;
      // the dvor feature check then leads the houses that actually HAVE one).
      // The absence branch is category-neutral: a plain стан/населба search
      // keeps seeing business rows (pre-existing behavior), and a house ask
      // (house=true) keeps seeing yard-less houses.
      .filter(p => opts.plac ? p.plac === true
        : opts.house === true
          ? (opts.yard ? p.house === true && (p.features?.some(f => /двор|градин/i.test(f)) ?? false) : p.house === true)
          : true)
      .filter(p => opts.garsonjera ? !p.business && !p.house && isSmallUnit(p) : true)      .filter(p => max === undefined || p.price === undefined || p.price <= max);
    // Bedroom filter: try exact match first; if no results in the TARGET
    // LOCATION, fall back to >= so the client sees alternatives (bigger/smaller)
    // instead of nothing. The fallback must happen BEFORE the location filter
    // so that exact matches in OTHER areas don't block the >= fallback for
    // the requested area.
    // RANGE ([09:17]): "edna ili dve" → EXACT 2…3 rooms, BOTH ends required —
    // a range is a bounded choice, not a minimum; rows with unknown bedrooms
    // stay in the pool so an untagged row can still serve.
    const withBedrooms = opts.bedroomsMin !== undefined && opts.bedroomsMax !== undefined
      ? base.filter(p => !p.bedrooms || (p.bedrooms >= (opts.bedroomsMin as number) && p.bedrooms <= (opts.bedroomsMax as number)))
      : opts.bedrooms
        ? base.filter(p => !p.bedrooms || p.bedrooms === opts.bedrooms)
        : base;
    // Check if exact matches exist in the target location
    const exactInLoc = opts.location ? withBedrooms.filter(inLoc) : withBedrooms;
    let baseFiltered: typeof base;
    let relaxedBedrooms = false;
    if (exactInLoc.length > 0 || !opts.location) {
      // Exact matches in target area (or no location filter) — use them
      baseFiltered = withBedrooms;
    } else {
      // No exact matches in target area — fall back to >= for the WHOLE pool,
      // then apply location filter so the client sees bigger/smaller options
      baseFiltered = base.filter(p => !opts.bedrooms || !p.bedrooms || p.bedrooms >= (opts.bedrooms as number));
      relaxedBedrooms = !!(opts.bedrooms && baseFiltered.length > 0);
    }
    const sqmFiltered = opts.sqm ? baseFiltered.filter(p => !p.sqm || p.sqm >= (opts.sqm as number)) : baseFiltered;
    const relaxedSqm = opts.sqm && sqmFiltered.length === 0 && baseFiltered.length > 0;
    const finalBase = relaxedSqm ? baseFiltered : sqmFiltered;
    const sameArea = finalBase.filter(inLoc);
    // No spill: with a location, the pool IS the area (possibly empty); without
    // one, the whole city. The funnel decides what to do when the area is empty.
    const pool = opts.location ? sameArea : finalBase;
    return pool
      .map(p => ({ p, inLoc: inLoc(p), dist: p.price !== undefined ? Math.abs(p.price - (max ?? 0)) : 0, rank: popularityRank(p.location) }))
      // sortBySqm: "помало нешто" mid-discovery — SMALLEST м² first, going up
      // (undefined-sqm rows last, then by price like the default).
      // sortByPopularity: "било каде" — most popular neighborhoods FIRST
      // (Центар, Капиштец, Карпош, Аеродром, Кисела Вода, Влае, Ѓорче Петров,
      // then the rest), within each neighborhood by price.
      .sort((a, b) => opts.sortBySqmDesc
        ? (Number(b.inLoc) - Number(a.inLoc))
          || ((b.p.sqm ?? -1) - (a.p.sqm ?? -1))
          || (a.dist - b.dist)
          || (a.p.eb - b.p.eb)
        : opts.sortBySqm
        ? (Number(b.inLoc) - Number(a.inLoc))
          || ((a.p.sqm ?? Infinity) - (b.p.sqm ?? Infinity))
          || (a.dist - b.dist)
          || (a.p.eb - b.p.eb)
        : (Number(b.inLoc) - Number(a.inLoc))
          || (opts.sortByPopularity ? (a.rank - b.rank) : 0)
          || (a.dist - b.dist)
          || (a.p.eb - b.p.eb))
      .map(s => s.p);
  }
}
