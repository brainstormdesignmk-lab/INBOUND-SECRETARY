/**
 * THE MEMORY LEXICON — the past, the sighting, the unit.
 *
 * Three readers used to own three different lists of the same words:
 *   • the market-memory lane (`MEMORY_PAST_RE`) knew «имаш-/беш-» only;
 *   • the recall detector knew `имавте/имавме/имаше/видов/гледав/најдов`;
 *   • the availability lane knew its own time adverbs.
 * So «имавме» recalled a listing for one detector and nothing for another.
 *
 * THE FAMILY IS SPLIT ON PURPOSE, and the split is the rule:
 *   - HAD = possession in the past («имавте/имавме/имаше») — can also be a
 *     stock question («имавте ли куќа?»), so it does not carry a recall alone;
 *   - WAS = narration («беше/бевме») — names ONE listing even with no unit;
 *   - SIGHT = the client SAW it («видов/гледав/најдов»);
 *   - AD = the ad noun whose «active?» state is asked about.
 */

import { NB, NA } from './text';
import { normalizeMc } from '../normalize';

/** Past possession: «имавте една куќа», «имавме», «имаше». */
export const MEMORY_HAD = [
  'имав', 'имаш', 'имало', 'imav', 'imas', 'imaš', 'imalo',
];
/** Past narration: «таа куќа беше…», «бевме кај вас». */
export const MEMORY_WAS = ['беш', 'бев', 'bev', 'bes', 'bese'];
/** The sighting verbs — the client SAW the listing with us. */
export const MEMORY_SIGHT = [
  'видов', 'видев', 'видовме', 'гледав', 'гледавме', 'најдов', 'најд', 'забележав',
  'vidov', 'videv', 'vidovme', 'gledav', 'gledavme', 'najdov', 'najd', 'zabelezav',
];
/** THE AD SPOKE (the [10:01] capture): «PISUVASE VO BLIZINA NA CRNOGORSKA
 *  AMBASADA» — «it said near …». The client is quoting the LISTING, so the
 *  sentence is a recall even with no category noun in it («MALA BESE , OKOLU
 *  30 000 EVRA CENA»). Past and present forms, both scripts. */
export const MEMORY_AD_SAID = ['пишува', 'пише', 'pisu', 'pise'];

/** The ad noun — required before «уште активен?» can be a recall. */
export const MEMORY_AD_NOUN = ['оглас', 'oglas', 'понуд', 'ponud', 'недвижност', 'nedviznost'];
/** The indefinite unit — «ЕДНА куќа» names a listing, «куќи» names a market. */
export const MEMORY_UNIT = [
  'еден', 'една', 'едно', 'некој', 'некоја', 'некое',
  'eden', 'edna', 'edno', 'nekoj', 'nekoja', 'nekoe',
];

function bounded(list: readonly string[]): string {
  return `${NB}(?:${list.map((s) => `${s}\\p{L}*`).join('|')})${NA}`;
}

/** Any of HAD / WAS / SIGHT — the general "has a past" test. */
export function pastMarkerPattern(): RegExp {
  return new RegExp(bounded([...MEMORY_HAD, ...MEMORY_WAS, ...MEMORY_SIGHT]), 'iu');
}

export function hadPattern(): RegExp {
  return new RegExp(bounded(MEMORY_HAD), 'iu');
}

export function wasPattern(): RegExp {
  return new RegExp(bounded(MEMORY_WAS), 'iu');
}

export function sightPattern(): RegExp {
  return new RegExp(bounded(MEMORY_SIGHT), 'iu');
}

export function adNounPattern(): RegExp {
  return new RegExp(bounded(MEMORY_AD_NOUN), 'iu');
}

/** Does the message speak in the past at all (either script)? */
export function speaksInPast(text: string): boolean {
  return pastMarkerPattern().test(`${text}\n${normalizeMc(text)}`);
}
