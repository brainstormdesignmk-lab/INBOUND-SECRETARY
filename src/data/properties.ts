import { Service } from '../fsm/machine';
import { LANDLORD_DATA } from './landlords';

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
  bedrooms?: number;       // from tip_na_sobi
  size?: string;           // povrsina_m2
  features?: string[];     // garaza, lift, greenje, dvor, parking, opremenost (per feed napomena)
  details?: string;        // opis
  gmaps?: string;
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

function mapRow(r: Record<string, unknown>): Property | null {
  const eb = Math.floor(Number(str(r.evidenten_broj)));
  if (!Number.isFinite(eb) || eb <= 0) return null;
  const prop: Property = {
    eb,
    id: eb,
    uuid: typeof r.id === 'string' ? r.id : undefined,
    address: titleCase(str(r.adresa) || str(r.naslov)) || `Имот ЕБ ${eb}`,
    price: num(r.cena_eur),
    priceLabel: str(r.cena_label) || undefined,
    location: str(r.naselba) || undefined,
    bedrooms: parseBedrooms(r.tip_na_sobi),
    size: r.povrsina_m2 !== undefined && r.povrsina_m2 !== null && r.povrsina_m2 !== ''
      ? `${r.povrsina_m2} м²` : undefined,
    features: featurePhrases(r),
    details: str(r.opis) || undefined,
    gmaps: str(r.gmaps) || undefined,
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

function latToCyr(s: string): string {
  const low = s.toLowerCase();
  let out = '';
  let i = 0;
  while (i < low.length) {
    const pair = low.slice(i, i + 2);
    const hit = MK_LAT2CYR.find(([k]) => k === pair);
    if (hit) { out += hit[1]; i += 2; continue; }
    const single = MK_LAT2CYR.find(([k]) => k === low[i]);
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

/** Canonical matching keys: raw + transliterations, lowercased, single-spaced. */
function locKeys(s: string): Set<string> {
  const low = s.toLowerCase().trim().replace(/\s+/g, ' ');
  const keys = new Set<string>([low]);
  keys.add(cyrToLat(low, MK_CYR2LAT));   // "капиштец" -> "kapishtec"
  keys.add(cyrToLat(low, MK_LOOSE));     // "капиштец" -> "kapistec"
  const fromLat = latToCyr(low);         // "centar" -> "центар"
  if (fromLat !== low) keys.add(fromLat);
  return keys;
}

export function locMatches(query: string, feedLoc: string): boolean {
  const qk = [...locKeys(query)].filter(k => k.length >= 2);
  const lk = [...locKeys(feedLoc)].filter(k => k.length >= 2);
  if (!qk.length || !lk.length) return false; // a property with NO location never matches a location query
  for (const a of qk) {
    for (const b of lk) {
      if (b.includes(a) || a.includes(b)) return true;
    }
  }
  return false;
}

/** Display form: Latin-typed locations are transliterated to canonical Cyrillic. */
export function normalizeLocation(s: string): string {
  const src = s.trim();
  const cyr = /[a-z]/i.test(src) ? latToCyr(src) : src;
  return cyr.charAt(0).toUpperCase() + cyr.slice(1);
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

export class PropertyService {
  private cache: { at: number; data: Property[] } | null = null;
  private ok = false;

  constructor(private url: string, private ttlMs = 5 * 60_000) {}

  /** Whether we have trustworthy feed data. False after a failed fetch with no cache
   *  — callers must NOT claim "no matching properties" when the feed is simply down. */
  get healthy(): boolean {
    return this.ok;
  }

  async getAll(): Promise<Property[]> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.data;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(this.url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { properties?: Record<string, unknown>[] };
      const rows = Array.isArray(body) ? body : (body.properties ?? []);
      const data = rows.map(mapRow).filter((p): p is Property => p !== null);
      this.cache = { at: Date.now(), data };
      this.ok = true;
      return data;
    } catch (e) {
      console.error('[properties] fetch failed:', (e as Error).message);
      if (!this.cache) this.ok = false; // stale cache is still real data; only distrust an empty hand
      return this.cache?.data ?? [];
    } finally {
      clearTimeout(timer);
    }
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

  async search(opts: { location?: string; bedrooms?: number; service?: Service; budget?: string }): Promise<Property[]> {
    const all = await this.getAll();
    let out = all;
    if (opts.service) out = out.filter(p => !p.service || p.service === opts.service);
    if (opts.location) {
      out = out.filter(p => {
        const loc = (p.location ?? '').trim();
        return loc && locMatches(opts.location as string, loc);
      });
    }
    if (opts.bedrooms) out = out.filter(p => !p.bedrooms || p.bedrooms >= (opts.bedrooms as number));
    // Budget is a hard filter — the LLM must never be handed above-budget
    // offers (it correctly "finds nothing" and misreports availability).
    if (opts.budget) {
      const max = parseBudgetMax(opts.budget);
      if (max) out = out.filter(p => p.price === undefined || p.price <= max);
    }
    return out;
  }

  /**
   * Ordered alternative candidates: requested location FIRST, then the rest of
   * the city; within each group by price-proximity to the budget (cheapest
   * first when no budget). Excludes already-shown EBs so every batch is new.
   * Never returns "nothing" while the feed has matching offers elsewhere.
   */
  async candidates(opts: {
    location?: string; bedrooms?: number; service?: Service; budget?: string; exclude?: number[];
  }): Promise<Property[]> {
    const all = await this.getAll();
    const exclude = new Set(opts.exclude ?? []);
    const max = opts.budget ? parseBudgetMax(opts.budget) : undefined;
    const scored = all
      .filter(p => !exclude.has(p.eb))
      .filter(p => !opts.service || !p.service || p.service === opts.service)
      .filter(p => !opts.bedrooms || !p.bedrooms || p.bedrooms >= (opts.bedrooms as number))
      .filter(p => max === undefined || p.price === undefined || p.price <= max)
      .map(p => {
        const inLoc = opts.location ? locMatches(opts.location, p.location ?? '') : true;
        const dist = p.price !== undefined ? Math.abs(p.price - (max ?? 0)) : 0;
        return { p, inLoc, dist };
      })
      .sort((a, b) => (Number(b.inLoc) - Number(a.inLoc)) || (a.dist - b.dist) || (a.p.eb - b.p.eb));
    return scored.map(s => s.p);
  }
}
