/**
 * THE SHARED LEXICON CONTRACT (AGENTS.md §4r).
 *
 * The defect this test exists for: the same word family was spelled out in
 * dozens of regexes, and they had drifted apart. «kukja» was a house for the
 * memory lane and NOTHING for `detectHouse`; «станбен» was a flat for the loose
 * type reader and not for the strict one; «МНОГУ СКУПО» armed service=buy
 * because the buy stem «куп» matched inside the word.
 *
 * So the contract is not "each detector matches these words" — it is "every
 * detector agrees about every word of the family". Each vector below is checked
 * against EVERY consumer of that family, so a future local list that disagrees
 * fails here by name.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROPERTY_WORDS, propertyCategoriesIn, namesCategory, readPropertyCategory,
  readPropertyNoun, looseTypePattern, typeFormPattern, typeSingularAlternation,
  typePluralAlternation,
  PROPERTY_TYPE_LOOSE_RE, PropertyCategory,
} from '../src/llm/lexicon/property';
import { readServiceWord, readServiceWords } from '../src/llm/lexicon/service';
import { speaksInPast, wasPattern, sightPattern, adNounPattern } from '../src/llm/lexicon/memory';
import { isLandmarkAnchored, landmarkPrepPattern } from '../src/llm/lexicon/place';
import {
  detectHouse, detectFlat, detectBusiness, detectService, detectRecallCategory,
  detectSeenListingRecall, memoryTypeNoun,
} from '../src/llm/deterministic';

const CATS: PropertyCategory[] = [
  'house', 'flat', 'garsonjera', 'apartment', 'land', 'business', 'garage',
];

/** Every surface form of a category (real words only — a stem + an invented
 *  ending is not a vector, it is a typo the feed never sends). */
function vectors(cat: PropertyCategory): string[] {
  return [...PROPERTY_WORDS[cat].forms];
}

test('property: every SURFACE FORM of a category is that category for the reader', () => {
  for (const cat of CATS) {
    for (const v of PROPERTY_WORDS[cat].forms) {
      assert.deepEqual(
        propertyCategoriesIn(v).includes(cat), true,
        `«${v}» must read as ${cat}: ${JSON.stringify(propertyCategoriesIn(v))}`,
      );
      assert.equal(namesCategory(v, cat), true, `namesCategory(«${v}», ${cat})`);
    }
  }
});

test('property: the LOOSE reading is a superset of the FORM reading', () => {
  const loose = new RegExp(looseTypePattern(CATS), 'iu');
  const form = new RegExp(typeFormPattern(CATS), 'iu');
  for (const cat of CATS) {
    for (const v of vectors(cat)) {
      assert.equal(form.test(v), true, `FORM must match «${v}»`);
      assert.equal(loose.test(v), true, `LOOSE must match «${v}» (it is the wider class)`);
    }
  }
});

test('property: a POSITIVE is never read as a NEGATIVE category (each detector agrees)', () => {
  for (const v of vectors('house')) {
    assert.equal(detectHouse(v), true, `«${v}» is a house`);
  }
  for (const v of [...vectors('flat'), ...vectors('garsonjera'), ...vectors('apartment')]) {
    assert.equal(detectFlat(v), true, `«${v}» is a flat`);
    // A flat names a type — it is not a house (the funnel asks bedroom counts).
    assert.notEqual(detectHouse(v), true, `«${v}» is not a house`);
  }
  for (const v of vectors('business')) {
    assert.equal(detectBusiness(v), true, `«${v}» is a business`);
    assert.equal(detectFlat(v), false, `«${v}» is not a flat`);
  }
  for (const v of vectors('land')) {
    assert.equal(detectFlat(v), false, `«${v}» is not a flat`);
    assert.equal(detectBusiness(v), false, `«${v}» is not a business`);
  }
});

test('property: the recall lane and the funnel read the SAME category', () => {
  // The [06:46] regression class: a definite/plural spelling the detector's own
  // list knew and the recall-category reader did not (or vice versa).
  const house = ['куќа', 'куќата', 'куќи', 'kukja', 'kukjata', 'kukji', 'куча', 'kuca'];
  for (const v of house) {
    assert.equal(propertyCategoriesIn(v).includes('house'), true, `«${v}» names a house`);
    assert.equal(detectRecallCategory(v).house, true, `«${v}» is a house for the recall lane`);
    assert.equal(detectHouse(v), true, `«${v}» is a house for the funnel`);
  }
  const business = ['локал', 'lokal', 'деловен простор', 'канцеларија', 'магацин', 'дуќан'];
  for (const v of business) {
    assert.equal(detectRecallCategory(v).business, true, `«${v}» is business for the recall lane`);
    assert.equal(detectBusiness(v), true, `«${v}» is business for the funnel`);
  }
});

test('property: a category word the fabric does NOT name is not invented', () => {
  // «станбен»/«стандард» are prose, not a category the client named.
  assert.equal(detectFlat('станбена површина'), false, 'станбен is not a flat');
  assert.equal(detectFlat('стандард'), false, 'стандард is not a flat');
  assert.deepEqual(detectRecallCategory('станбена површина 60'), {});
  // …but the LOOSE mention reading still sees the type (that is its job).
  assert.equal(PROPERTY_TYPE_LOOSE_RE.test('станбена површина'), true);
});

test('property: the noun said back is the FINEST name in the message', () => {
  assert.equal(readPropertyNoun('imashe lokаl kaj vas do 900'), 'локал');
  assert.equal(readPropertyNoun('ИМАШЕ ДЕЛОВЕН ПРОСТОР КАЈ НАС ОКОЛУ 400'), 'деловен простор');
  assert.equal(readPropertyNoun('beshe edna garsonjera kaj nas 12000'), 'гарсоњера');
  assert.equal(readPropertyNoun('imashe stan kaj vas za 80.000'), 'стан');
  assert.equal(memoryTypeNoun('beshe edna kukja kaj nas 400'), 'куќа');
});

test('property: the singular slot never carries a MARKET question', () => {
  // «имавте куќИ во Центар?» asks about stock; only a singular names one listing.
  const sg = new RegExp(`(?<![\\p{L}\\p{N}])${typeSingularAlternation(CATS)}(?![\\p{L}\\p{N}])`, 'iu');
  assert.equal(sg.test('една куќа'), true);
  assert.equal(sg.test('куќи'), false);
  assert.equal(sg.test('станови'), false);
});

test('property: singular + plural PARTITION every form (no derived guesswork)', () => {
  // The plural was once derived as `forms − singularForms`, which read the
  // definite singular «СТАНОВ» / «ПРОСТОР» as plurals and turned an ordinary
  // «STO MOZES DA MI KAZES ZA STANOV?» into the €/m² market band.
  for (const cat of [...CATS, 'generic' as PropertyCategory]) {
    const w = PROPERTY_WORDS[cat];
    for (const f of w.forms) {
      const sing = w.singularForms.includes(f);
      const plur = w.pluralForms.includes(f);
      assert.equal(sing !== plur, true,
        `«${f}» (${cat}) must be in exactly ONE of singular/plural — got sing=${sing} plur=${plur}`);
    }
    for (const f of [...w.singularForms, ...w.pluralForms]) {
      assert.equal(w.forms.includes(f), true, `«${f}» (${cat}) must also be in forms`);
    }
  }
  // The definite singulars that broke it stay singular.
  for (const v of ['станов', 'stanov', 'простор', 'prostor', 'станот', 'stanot']) {
    const plural = new RegExp(`(?<![\\p{L}\\p{N}])${typePluralAlternation(CATS)}(?![\\p{L}\\p{N}])`, 'iu');
    assert.equal(plural.test(v), false, `«${v}» is NOT a plural`);
  }
});

test('service: buy and rent are read the same way by every consumer', () => {
  const buy = ['сакам да купам стан', 'kupuvam stan', 'купување', 'за продажба', 'prodazba'];
  for (const v of buy) {
    assert.equal(readServiceWord(v), 'buy', `«${v}» is a buy`);
    assert.equal(detectService(v), 'buy', `detectService(«${v}»)`);
  }
  const rent = ['сакам да изнајмам', 'iznajmuvam stan', 'под кирија', 'pod kirija', 'rentanje', 'издава стан', 'рентање', 'РЕНТАЊЕ', 'rentaњe'];
  for (const v of rent) {
    assert.equal(readServiceWord(v), 'rent', `«${v}» is a rent`);
    assert.equal(detectService(v), 'rent', `detectService(«${v}»)`);
  }
});

test('service: «скупо» is a VALUE COMPLAINT, never a purchase', () => {
  // The old BUY_RE had no word boundary, so the stem «куп» matched inside
  // «СКУПО» and armed service=buy on a price objection.
  for (const v of ['МНОГУ СКУПО', 'mnogu skapo', 'скупо е', 'МНОГУ СКАПО']) {
    assert.equal(readServiceWord(v), undefined, `«${v}» names no deal`);
    assert.equal(detectService(v), undefined, `detectService(«${v}»)`);
  }
  // «рентабилно» is a yield word, not a tenancy.
  assert.equal(readServiceWord('mnogu e rentabilno'), undefined);
});

test('memory: the past markers are one family, and the recall lane reads them', () => {
  for (const v of ['имавте една куќа', 'имавме стан', 'имаше гарсоњера', 'беше една куќа', 'видов куќа', 'gledav kukja na sajtot']) {
    assert.equal(speaksInPast(v), true, `«${v}» speaks in the past`);
  }
  assert.equal(wasPattern().test('беше'), true);
  assert.equal(wasPattern().test('имавте'), false, '«имавте» alone narrates nothing');
  assert.equal(sightPattern().test('gledav'), true);
  assert.equal(adNounPattern().test('огласот'), true);
  // …and the recall detector agrees with the family (unit + singular category).
  for (const v of ['ИМАВТЕ ЕДНА КУЌА ВО СКОПЈЕ СЕВЕР', 'IMAVTE EDNA GARSONJERA TAMU', 'VIDOV KUKJA NA VASNIOT SAJT', 'КУЌАТА ВО СКОПЈЕ СЕВЕР ЗА 130000 БЕШЕ']) {
    assert.equal(detectSeenListingRecall(v), true, `«${v}» is a recall`);
  }
});

test('place: a POINT is not an AREA, and a PRICE is not a landmark', () => {
  const point = ['имавте гарсоњера кај Црногорска амбасада', 'kaj Broz Kafe', 'близу Олимпико', 'до Карпош', 'таму', 'во близина на аеродром'];
  for (const v of point) {
    assert.equal(isLandmarkAnchored(v), true, `«${v}» reads a point`);
  }
  const area = ['имавте куќа во Скопје Север', 'во Центар имате стан', 'во Кисела Вода'];
  for (const v of area) {
    assert.equal(isLandmarkAnchored(v), false, `«${v}» reads an area, not a point`);
  }
  // THE PRICE GUARD: «до» in a budget is not the landmark preposition. Reading
  // it as one handed the [06:46] recall back to the criteria grill.
  for (const v of ['имавте куќа во Скопје Север до 130.000 евра', 'stan do 80000 evra']) {
    assert.equal(landmarkPrepPattern().test(v), false, `«${v}» has no landmark`);
  }
  // THE AGENCY ANCHOR: «кај вас/нас» is a memory line, not a place on the map.
  for (const v of ['имавте куќа кај вас', 'imashe stan kaj nas']) {
    assert.equal(landmarkPrepPattern().test(v), false, `«${v}» is the agency, not a place`);
  }
});

test('service: both-deal answers are still both', () => {
  const both = readServiceWords('i kupuvam i iznajmuvam');
  assert.deepEqual(both, { buy: true, rent: true });
  assert.equal(readServiceWord('i kupuvam i iznajmuvam'), undefined);
});
