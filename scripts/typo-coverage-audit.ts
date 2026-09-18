// Single-letter typo coverage audit: for each intent-critical keyword family,
// mutate the FUZZ-ELIGIBLE anchors (the words wired into fuzzyHasToken) with
// one edit (delete / adjacent-swap / adjacent-key / double / transposition)
// and report the mutations the detector still MISSES.
//
// Families with NO anchors are deliberately out of scope for token-level
// fuzzy matching — the reason is noted inline:
//   - agreement (да/ок/добро): 2–5-letter confirmation words — the distance-1
//     neighborhood is full of other real words ("да"→"дс"/"ад"), fuzzing them
//     would make almost every message an agreement;
//   - bedrooms/property-interest order-sensitive forms: the NUMBER or the
//     clitic position carries the meaning (a typo'd "спални" says nothing
//     about the count; "svigja mi se" reversed = NOT interest);
//   - rent/visit/interest/widen residual misses below are distance-2 slips
//     (two edits) or morphology variants — deliberately not fuzzed.
//
// Exit code 0 always: this is an observability tool, not a gate. Expected
// healthy state after the anchor wiring: every family with anchors reports
// 0 missed mutations.
import {
  detectService, detectAvailabilityAsk, detectFeeWhy,
  detectPricePriority, detectSuggestAlternatives,
  detectGarsonjera, detectExplicitWiden,
  detectVisitTime, detectDocumentsAsk, detectMortgageAsk, detectProvisionAsk,
} from '../src/llm/deterministic';

type Fam = {
  name: string;
  bases: string[]; // Cyrillic first, then Latin
  hit: (t: string) => boolean;
};

// Adjacent-key maps (qwerty + мкд layout approximations)
const ADJ: Record<string, string> = {
  a:'sqwz', b:'vghn', c:'xdfv', d:'sfexc', e:'wrds', f:'dgrvc', g:'fhtbv',
  h:'gjybn', i:'uokj', j:'hkuin', k:'jilm', l:'kop', m:'njk', n:'bmjh',
  o:'ipkl', p:'ol', q:'wa', r:'etdf', s:'adwxz', t:'ryfg', u:'yhji',
  v:'cfgb', w:'qesa', x:'zsdc', y:'tuhg', z:'asx',
  'а':'чс', 'б':'ину', 'в':'цуи', 'г':'шђф', 'д':'јкл', 'е':'ртс',
  'ж':'зѕџ', 'з':'жџ', 'и':'окј', 'ј':'икл', 'к':'илј', 'л':'кјч',
  'м':'нњ', 'н':'мњ', 'о':'ип', 'п':'ољ', 'р':'ет', 'с':'адє',
  'т':'ру', 'у':'тшз', 'ф':'гх', 'х':'фц', 'ц':'вх', 'ч':'лв',
  'ѕ':'жс', 'ђ':'гж', 'ќ':'бн', 'њ':'мд', 'ш':'уег', 'џ':'зж',
};

function mutate(w: string): string[] {
  const out = new Set<string>();
  const c = [...w];
  for (let i = 0; i < c.length; i++) {
    out.add([...c.slice(0, i), ...c.slice(i + 1)].join(''));            // delete
    out.add([...c.slice(0, i), c[i], c[i], ...c.slice(i + 1)].join(''));// double
    if (i + 1 < c.length) {                                             // swap
      const m = [...c]; [m[i], m[i + 1]] = [m[i + 1], m[i]];
      out.add(m.join(''));
    }
    for (const a of (ADJ[c[i]] ?? '')) {                                // adjacent key
      out.add([...c.slice(0, i), a, ...c.slice(i + 1)].join(''));
    }
  }
  return [...out].filter(m => m !== w);
}

const fams: Fam[] = [
  {
    name: 'buy (anchors: купувам, купам)',
    bases: ['купувам', 'купам', 'kupuvam', 'kupam'],
    hit: t => detectService(t) === 'buy',
  },
  {
    name: 'rent (anchor: изнајмувам)',
    bases: ['изнајмувам', 'iznajmuvam'],
    hit: t => detectService(t) === 'rent',
  },
  {
    name: 'availability (anchors: достапен, слободен)',
    bases: ['достапен', 'слободен', 'dostapen', 'sloboden'],
    hit: t => detectAvailabilityAsk(t),
  },
  {
    name: 'fee-why (anchor: надомест)',
    bases: ['надомест', 'nadomest'],
    hit: t => detectFeeWhy(`зошто ${t} за посета`),
  },
  {
    name: 'price-priority (anchors: поевтино, појефтино)',
    bases: ['поевтино', 'појефтино', 'poeftino', 'pojeftino'],
    hit: t => detectPricePriority(`дај нешто ${t}`),
  },
  {
    name: 'suggest-alt (anchors: предложи, предложете, предлози)',
    bases: ['предложи', 'предложете', 'предлози', 'predlozi', 'predlozete'],
    hit: t => detectSuggestAlternatives(t),
  },
  {
    name: 'garsonjera (anchors: гарсоњера, студио)',
    bases: ['гарсоњера', 'студио', 'garsonjera', 'studio'],
    hit: t => detectGarsonjera(t),
  },
  {
    name: 'widen (anchor: прошири)',
    bases: ['прошири', 'prosiri'],
    hit: t => detectExplicitWiden(t),
  },
  {
    name: 'visit-time (anchors: day/period names only)',
    bases: ['понеделник', 'вторник', 'четврток', 'сабота', 'недела', 'попладне', 'викенд',
      'ponedelnik', 'vtornik', 'cetvrtok', 'sabota', 'nedela', 'popladne', 'vikend'],
    hit: t => detectVisitTime(`${t} posle 5`) !== undefined,
  },
  {
    name: 'documents (anchors: документи, документација)',
    bases: ['документи', 'документација', 'dokumenti', 'dokumentacija'],
    hit: t => detectDocumentsAsk(t),
  },
  {
    name: 'mortgage (anchors: кредит, хипотека)',
    bases: ['кредит', 'хипотека', 'kredit', 'hipoteka'],
    hit: t => detectMortgageAsk(t),
  },
  {
    name: 'provision (anchor: провизија)',
    bases: ['провизија', 'provizija'],
    hit: t => detectProvisionAsk(t),
  },
];

let gapCount = 0;
for (const f of fams) {
  const gaps: string[] = [];
  for (const base of f.bases) {
    for (const mut of mutate(base)) {
      if (!f.hit(mut)) gaps.push(mut);
    }
  }
  console.log(`\n== ${f.name}: ${gaps.length} missed mutations`);
  console.log('   ' + gaps.slice(0, 40).join('  '));
  if (gaps.length) gapCount++;
}
console.log(`\nFamilies with residual gaps: ${gapCount}/${fams.length}`);
console.log('Deliberately NOT fuzzed: agreement (too short), bedrooms (number carries meaning),\nproperty-interest clitic order (svigja mi se), cheaper/alt distance-2 slips.');
