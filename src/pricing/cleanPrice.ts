// THE CLEAN PRICE — the owner's own figure, and the ONLY price Lina may ask an
// owner about.
//
// The public price (the feed's `cena_eur`, what the client saw on the website
// or in an ad) is the FINAL price: the owner's clean price plus the agency
// commission, rounded UP to 500 €. Ana's import pipeline computes it
// (`outbound_final/property-intelligence.js`, `calculateSellingPrice`):
//
//   commission = Math.round(clean * agencyPercent / 100)   // agencyPercent default 2
//   finalPrice = clean + commission
//   selling    = Math.ceil(finalPrice / 500) * 500          // round UP to 500 €
//
// When an owner corrects the clean price, the final price MUST be recomputed
// with that same arithmetic — a second, "close enough" formula would put two
// different prices on one appliance. `roundUpTo500` and `computeFinalFromClean`
// are the single implementation here, and the tests pin them against Ana's
// worked examples (126 001 → 126 500, 126 501 → 127 000).
//
// RENT is not marked up at all: the monthly rent IS the price the client sees,
// and the rent commission (50 % under 1.000 €, one month at 1.000 €+) is the
// separate fee ladder, never a price bump. A corrected clean rent therefore
// becomes the new monthly rent unchanged.
//
// Owner-only discipline: the clean price appears ONLY in owner copy. It must
// never reach a client sentence — a client sees the final/agency price and the
// provision ladder, nothing else.

/** Ana's default agency percentage when the property carries none. */
export const DEFAULT_AGENCY_PERCENT = 2;

/** Round UP to the nearest 500 € — Ana's `roundUpTo500` (126 001 → 126 500). */
export function roundUpTo500(n: number): number {
  return Math.ceil(n / 500) * 500;
}

export interface FinalPrice {
  /** The agency commission in €, as Ana computes it. */
  commission: number;
  /** clean + commission (before the 500 € rounding). */
  finalPrice: number;
  /** What the client sees: the final price rounded UP to 500 €. */
  sellingPrice: number;
  agencyPercent: number;
}

/** The FINAL (client-facing) price from an owner's clean price — Ana's logic. */
export function computeFinalFromClean(
  cleanPrice: number,
  agencyPercent: number = DEFAULT_AGENCY_PERCENT,
): FinalPrice | undefined {
  const clean = Number(cleanPrice);
  if (!Number.isFinite(clean) || clean <= 0) return undefined;
  const pct = Number.isFinite(Number(agencyPercent)) && Number(agencyPercent) >= 0
    ? Number(agencyPercent)
    : DEFAULT_AGENCY_PERCENT;
  const commission = Math.round(clean * (pct / 100));
  const finalPrice = clean + commission;
  return { commission, finalPrice, sellingPrice: roundUpTo500(finalPrice), agencyPercent: pct };
}

const eur = (n: number): string => n.toLocaleString('mk-MK');

/** The owner-ask half that confirms the clean price. Appended to the FIRST
 *  availability ask only — a second/third turn already asked it. Empty when the
 *  property has no clean price on file (never a made-up figure). */
export function buildOwnerCleanPriceQuestion(cleanPrice?: number, service?: 'buy' | 'rent'): string {
  if (cleanPrice === undefined || !Number.isFinite(cleanPrice) || cleanPrice <= 0) return '';
  return service === 'rent'
    ? `Дали останува договорената чиста месечна кирија за Вас од ${eur(cleanPrice)} евра?`
    : `Дали останува договорената чиста цена за Вас од ${eur(cleanPrice)} евра?`;
}

/** THE PUBLISHED FIGURE IS THE ONLY OTHER PRICE WE HOLD (the [02:03] field
 *  capture). Most feed rows carry no clean price — the ad price is all there is,
 *  and the owner ask went out with NO price question at all, so the owner was
 *  never given the chance to correct it. This half asks him to confirm the
 *  figure the client is looking at; a different number in his answer is a price
 *  change like any other. Empty when the row has no price. */
export function buildOwnerPublishedPriceQuestion(price?: number, service?: 'buy' | 'rent'): string {
  if (price === undefined || !Number.isFinite(price) || price <= 0) return '';
  return service === 'rent'
    ? `Дали месечната кирија од огласот, ${eur(price)} евра, е сè уште актуелна?`
    : `Дали цената од огласот, ${eur(price)} евра, е сè уште актуелна?`;
}

/** THE PRICE-CHANGE NOTICE — served to the client at arranging time, before the
 *  visit is locked. It names both figures (what he saw on the ad, what stands
 *  now) and asks whether he still wants the visit, so he decides instead of
 *  discovering the new price at the door. */
export function buildPriceChangeNotice(eb: number, oldPrice?: number, newPrice?: number): string {
  const now = newPrice !== undefined ? `, актуелната цена е ${eur(newPrice)} евра` : '';
  const before = oldPrice !== undefined
    ? `Цената за Евидентен број ${eb} е променета — на огласот беше ${eur(oldPrice)} евра${now}.`
    : `Цената за Евидентен број ${eb} е променета${now ? `:${now.replace(/^,/, '')}` : ''}.`;
  return `${before} Дали сè уште сакате посета?`;
}

/** THE OWNER'S-PRICE DISCLAIMER (owner-dictated wording, verbatim). Served when
 *  a client complains about a price that moved between the ad and the owner's
 *  confirmation — owners may reprice or change terms without telling the
 *  agency, so the system carries the last contact's data until the client asks
 *  us to verify the property. */
export const PRICE_CHANGE_DISCLAIMER =
  'Сопствениците на недвижностите го задржуваат правото за промена на цената и условите без знаење на агенцијата. Сè додека одредена недвижност не се провери по барање на клиент, системот ги има податоците од последниот контакт со сопственикот, кои може да имаат различна состојба и вредности од моменталната.';
