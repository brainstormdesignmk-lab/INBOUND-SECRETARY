// ========================================
// OFFENSIVE CLASSIFIER — normalizer + data-driven lexicon
// ========================================
// Ported from ANA (secretaries/outbound_final/offensive-classifier.js) — the
// production-proven insult detector behind her 3-strike protocol. Lina uses it
// DETERMINISTICALLY, before any LLM call, so an insult is caught even on the
// LLM-free path ("[без LLM]" in the TUI — the exact bug that let
// "DA SE EBETE VO GAZOT" slip through as an agreement and close the deal).
//
// Two-stage pipeline:
//   1. normalize(text) — folds ALL script chaos (Latin / Cyrillic / leetspeak /
//      mixed-script / diacritics) into ONE canonical form.
//   2. classifyOffensive — matches the canonical text against a data-driven
//      LEXICON of stems with structured guards. Adding a new word/phrase
//      variant is a DATA ROW, not a new regex branch.
//
// CANONICAL FORM = "casual Viber Latin" (the transcription actual users type):
//   • Latin input (picka, zenski, zivis, crkni, fuck, masaza, edvaj cekam...)
//     is ALREADY canonical — identity pass.
//   • Cyrillic input folds into the same form: женски→zenski, живееш→zivees,
//     пичка→picka, цркни→crkni, имаш→imas, девојче→devojce, ќути→kjuti.
//   • The h-dropping digraphs unify official vs casual spellings:
//     ch→c (pichka→picka), sh→s (zamolchi→zamolci, imash→imas), zh→z.
//   • Leetspeak 4→c (pi4ka→picka); other digits are preserved (the 'elena'
//     rule needs them).
// ========================================

// --- Normalization tables ---

// Official/accented Latin digraphs → casual Viber form (longest-match first).
const LATIN_FOLDS: ReadonlyArray<readonly [string, string]> = [
  ['dž', 'dz'], ['ǆ', 'dz'], ['ǌ', 'nj'], ['ǉ', 'lj'],
  ['ch', 'c'], ['sh', 's'], ['zh', 'z'],
  ['č', 'c'], ['ć', 'k'], ['š', 's'], ['ž', 'z'], ['đ', 'gj'],
  ['ǵ', 'gj'], ['ḱ', 'kj'],
];

// Cyrillic → canonical casual Latin. Multi-char targets first (single source
// chars, so ordering among them is safe), then 1:1 singles. Ambiguous letters
// use their MOST COMMON Viber reading: ж→z, ш→s, ч→c (ц also →c), ќ→kj, ѓ→gj.
const CYRILLIC_TO_LATIN: ReadonlyArray<readonly [string, string]> = [
  ['ѓ', 'gj'], ['ќ', 'kj'], ['љ', 'lj'], ['њ', 'nj'], ['ѕ', 'dz'], ['џ', 'dz'],
  ['ё', 'e'], ['ѝ', 'i'], ['й', 'j'],
  ['а', 'a'], ['б', 'b'], ['в', 'v'], ['г', 'g'], ['д', 'd'], ['е', 'e'],
  ['ж', 'z'], ['з', 'z'], ['и', 'i'], ['ј', 'j'], ['к', 'k'], ['л', 'l'],
  ['м', 'm'], ['н', 'n'], ['о', 'o'], ['п', 'p'], ['р', 'r'], ['с', 's'],
  ['т', 't'], ['у', 'u'], ['ф', 'f'], ['х', 'h'], ['ц', 'c'], ['ч', 'c'],
  ['ш', 's'],
];

/** Canonical: lowercase → leetspeak → Latin folds → Cyrillic folds → strip non-[a-z0-9] */
export function normalize(text: string): string {
  let s = String(text ?? '').toLowerCase().trim();
  if (!s) return '';
  // Leetspeak: '4' commonly represents 'ч' in Balkan texting (pi4ka → picka).
  s = s.replace(/4/g, 'c');
  for (const [from, to] of LATIN_FOLDS) s = s.split(from).join(to);
  for (const [from, to] of CYRILLIC_TO_LATIN) s = s.split(from).join(to);
  // Collapse everything that isn't a lowercase Latin letter or digit.
  s = s.replace(/[^a-z0-9]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// ========================================
// LEXICON — data rows, ordered by priority
// ========================================
// Entry shape:
//   id          — catalog id (S1..S10, C1..C12, O1..O9, V, H, M)
//   category    — sexual | violence | creepy | heavy_insult | mild
//   severity    — 3 | 2 | 1
//   confidence  — confidence score (0..1), reported as metadata
//   stems       — canonical phrases (normalized space). FIRST match wins.
//   boundary    — optional: require non-letter on BOTH sides of the stem
//                 ('vol' must not match inside "dozvola", 'ebam' not in "trebam")
//   exclude     — optional: if ANY of these substrings appear anywhere in the
//                 canonical message, the entry does NOT match
//   excludeAfter— optional: if the word immediately AFTER a matched stem is one
//                 of these, that occurrence is rejected
//   requireRegex— optional: the canonical message must match this regex too
//   reason      — human-readable why (used in logs)
//
// ORDER MATTERS: sexual → violence → creepy → heavy_insult → mild. A message
// like "пичка ти матер" → "picka ti mater" must resolve to SEXUAL (severity 3),
// so the sexual 'picka' stem is checked first.
// ========================================

export interface LexiconEntry {
  id: string;
  category: 'sexual' | 'violence' | 'creepy' | 'heavy_insult' | 'mild';
  severity: number;
  confidence: number;
  stems: string[];
  boundary?: boolean;
  exclude?: string[];
  excludeAfter?: string[];
  requireRegex?: RegExp;
  reason: string;
}

const LEXICON: LexiconEntry[] = [
  // ---------- SEXUAL (severity 3) ----------
  { id: 'S0a', category: 'sexual', severity: 3, confidence: 0.98, stems: ['seks'], reason: 'seks' },
  { id: 'S0b', category: 'sexual', severity: 3, confidence: 0.95, stems: ['sisa', 'cici'], reason: 'body objectification (sisa/cici)' },
  { id: 'S0b2', category: 'sexual', severity: 3, confidence: 0.95, stems: ['gradi'], boundary: true,
    excludeAfter: ['se', 'si', 'ime', 'ite', 'aat', 'eme', 'ot', 'ata'],
    reason: 'gradi (letter-bounded so "izgradi"=built stays clean; reflexive forms excluded)' },
  { id: 'S0c', category: 'sexual', severity: 3, confidence: 0.98, stems: ['picka'], reason: 'picka (picka/pichka/pi4ka/пичка all normalize here)' },
  { id: 'S0d', category: 'sexual', severity: 3, confidence: 0.98, stems: ['kur', 'kuro', 'kura', 'cura', 'penis'], reason: 'kur/penis' },
  { id: 'S0e', category: 'sexual', severity: 3, confidence: 0.98, stems: ['vagin', 'vulv'], reason: 'vagina/vulva' },
  // boundary on 'anal' (ANA had it bare): "направи анализа" (make an analysis)
  // is a legit real-estate request and must never flag — the unambiguous
  // 'oralen'/'analen' forms still catch the actual insults.
  { id: 'S0f', category: 'sexual', severity: 3, confidence: 0.95, stems: ['oralen', 'analen', 'anal'], boundary: true, reason: 'oral/anal' },
  { id: 'S0g', category: 'sexual', severity: 3, confidence: 0.95, stems: ['dupka', 'durka'], reason: 'dupka' },
  { id: 'S0h', category: 'sexual', severity: 3, confidence: 0.95, stems: ['gluva', 'gluvac'], reason: 'gluva/gluvac' },
  { id: 'S0i', category: 'sexual', severity: 3, confidence: 0.97, stems: ['fuck', 'fuk', 'fakj', 'fakji'], reason: 'fuck variants' },
  { id: 'S0j', category: 'sexual', severity: 3, confidence: 0.97, stems: ['fak'], boundary: true, reason: 'fak (letter-bounded so "fakt"/"fakel" stay clean)' },
  { id: 'S0k', category: 'sexual', severity: 3, confidence: 0.97, stems: ['ebam', 'ebes', 'ebete', 'ebeme', 'ebat'], boundary: true, reason: 'ebam/ebete vulgar verb (letter-bounded so "trebam"/"trebete"/"nebesa" stay clean)' },
  // Flirtatious / sexual advances toward Lina personally — early warning
  { id: 'S0l', category: 'sexual', severity: 3, confidence: 0.9, stems: ['ostri zenski', 'sakam ostri zenski', 'ostro a'], reason: 'ostri zenski' },
  { id: 'S0m', category: 'sexual', severity: 3, confidence: 0.9, stems: ['ke bides li fino devojce', 'kje bides li fino devojce', 'fino devojce za mene'], reason: 'fino devojce' },
  { id: 'S0n', category: 'sexual', severity: 3, confidence: 0.95, stems: ['sakam da te baknam', 'sakam da te baknuvam', 'sakam da te ljubam', 'sakam da te lubam'], reason: 'sexual propositions (baknam/ljubam)' },
  { id: 'S0o', category: 'sexual', severity: 3, confidence: 0.9, stems: ['ajde da se druzime'], reason: 'ajde da se druzime' },
  { id: 'S0p', category: 'sexual', severity: 3, confidence: 0.9, stems: ['imam ponuda za tebe'], reason: 'imam ponuda za tebe' },
  { id: 'S0q', category: 'sexual', severity: 3, confidence: 0.9, stems: ['sakam da te vidam'], reason: 'sakam da te vidam' },
  { id: 'S0r', category: 'sexual', severity: 3, confidence: 0.9, stems: ['ke te voljam', 'kje te voljam', 'ke te voleam'], reason: 'ke te voljam' },
  { id: 'S0s', category: 'sexual', severity: 3, confidence: 0.85, stems: ['elena'], requireRegex: /\d/, reason: 'elena + phone digits (prostitution reference)' },
  { id: 'S0t', category: 'sexual', severity: 3, confidence: 0.9, stems: ['masaza', 'masage', 'erot'], reason: 'masaza/erotic services' },
  { id: 'S0u', category: 'sexual', severity: 3, confidence: 0.9, stems: ['privatni uslugi'], reason: 'privatni uslugi' },
  { id: 'S1', category: 'sexual', severity: 3, confidence: 0.98, stems: ['sakam da mi bides devojka'], reason: 'sakam da mi bides devojka' },
  { id: 'S2', category: 'sexual', severity: 3, confidence: 0.97, stems: ['si vruba zenska', 'si vruka zenska', 'si vruca zenska', 'vruba si', 'vruka si', 'vruca si'], reason: 'si vruba zenska' },
  { id: 'S3', category: 'sexual', severity: 3, confidence: 0.97, stems: ['polubajam', 'da te polubam'], reason: 'sakam da te polubajam' },
  { id: 'S4', category: 'sexual', severity: 3, confidence: 0.97, stems: ['soblecam so oci', 'te soblecam'], reason: 'ke te soblecam so oci' },
  { id: 'S5', category: 'sexual', severity: 3, confidence: 0.97, stems: ['prefina zadnica', 'dobra zadnica'], reason: 'imas prefina zadnica' },
  { id: 'S6', category: 'sexual', severity: 3, confidence: 0.97, stems: ['sakam da te zemam za sebe'], reason: 'sakam da te zemam za sebe' },
  { id: 'S7', category: 'sexual', severity: 3, confidence: 0.95, stems: ['kaj mene vecer', 'kaj mene vecerva', 'pomines kaj mene vecer', 'pomines kaj mene vecerva'], reason: 'pomines kaj mene vecerva (vecer qualifier REQUIRED — bare viewing invite stays clean)' },
  { id: 'S8', category: 'sexual', severity: 3, confidence: 0.95, stems: ['nokj zaedno', 'pomineme nokj', 'da spieme'], reason: 'sakam da pomineme nokj zaedno' },
  { id: 'S9', category: 'sexual', severity: 3, confidence: 0.97, stems: ['ej bebe', 'sakam da te sredam', 'ajde bebe'], reason: 'ej bebe, sakam da te sredam' },
  { id: 'S10', category: 'sexual', severity: 3, confidence: 0.97, stems: ['prefini gradi', 'imas li gradi'], reason: 'imas li prefini gradi' },
  // ORAL-SEX (pusenje family) — production miss in ANA: "dali ima gratis pusenje
  // so toa ?" slipped through as INTERESTED because the lexicon had zero oral-sex
  // stems. Two entries: S0v = unambiguous sexual PHRASES; S0w = bare pusenje/pusi
  // verbs gated by a sexual qualifier (requireRegex). Both exclude SMOKING
  // contexts ("dali smee pusenje vo stanot?" / "dozvoleno li e pusenje?" /
  // "da pusam na balkon") which are legit real-estate questions.
  { id: 'S0v', category: 'sexual', severity: 3, confidence: 0.97, stems: [
      'gratis pusenje', 'pusenje gratis',
      'darmo pusenje', 'besplaten pusenje', 'besplatno pusenje',
      'pusenje so toa', 'pusenje kaj tebe', 'pusenje za tebe',
      'sakam pusenje', 'sakam da mi pusis', 'sakam da ti pusam',
      'pusi mi', 'pusi mi go', 'pusis mi', 'pusis mi go',
      'da mi pusis', 'kje mi pusis', 'ke mi pusis',
      'da ti pusam', 'kje ti pusam', 'ke ti pusam',
      'da go pusis', 'pusi go',
      'pusenje kur', 'pusis kur',
      // 'take it in your mouth' family — zemi/stavi go na usta
      'zemi go na usta', 'stavi go na usta', 'zemi ga na usta',
      'zemi go v usta', 'stavi ga na usta', 'zemi na usta',
      'zemi gi na usta', 'stavi gi na usta', 'zemi gi v usta',
      // 'zemi go u usta' (without preposition fusion)
      'zemi go u usta', 'stavi go u usta', 'zemi ga u usta',
      'zemi gi u usta', 'stavi ga u usta', 'stavi gi u usta',
      // lapni/swallow — 'lapni go', 'lapaj go'
      'lapni go', 'lapaj go', 'lapni ga', 'lapaj ga',
      'lapni gi', 'lapaj gi', 'lapni mi go', 'lapaj mi go',
      // lizi/lick — 'lizi go', 'lijzi go'
      'lizi go', 'lijzi go', 'lizi ga', 'lijzi ga',
      'lizi gi', 'lijzi gi', 'lizi mi go', 'lijzi mi go',
      // 'go sakash odpozadi' / 'odpozadi' (from behind)
      'go sakas odpozadi', 'go saka odpozadi', 'go sakas odpozadi',
      'odpozadi',
      // 'da ti go turam' / 'turam ti go' (shove it in)
      'da ti go turam', 'turam ti go', 'ti go turam',
      'da ti ga turam', 'turam ti ga', 'ti ga turam',
      'da ti go vmetnam', 'vmetnam ti go',
      'da ti go stavam', 'stavam ti go',
    ],
    exclude: ['cigar', 'dozvoleno', 'zabran', 'smee', 'balkon', 'ventilac', 'pusac'],
    reason: 'oral-sex (pusenje/pusi mi family — smoking contexts excluded)' },
  { id: 'S0w', category: 'sexual', severity: 3, confidence: 0.9, stems: ['pusenje', 'pusi', 'pusis', 'pusam', 'pusas'],
    boundary: true,
    requireRegex: /(gratis|darmo|besplat|so toa|kaj tebe|za tebe|sakam da mi|sakam da ti|da mi pus|da ti pus)/,
    exclude: ['cigar', 'dozvoleno', 'zabran', 'smee', 'balkon', 'ventilac', 'pusac'],
    reason: 'oral-sex (bare pusenje/pusi verb, letter-bounded + gated by sexual qualifier — smoking excluded)' },

  // ---------- VIOLENCE (severity 3) ----------
  { id: 'V1', category: 'violence', severity: 3, confidence: 0.99, stems: ['ke te ubijam', 'kje te ubijam', 'ke te ubiam'], reason: 'death threat (ke te ubijam)' },
  { id: 'V2', category: 'violence', severity: 3, confidence: 0.99, stems: ['ke te pretapam', 'kje te pretapam', 'ke te pretepam', 'kje te pretepam'], reason: 'assault threat (ke te pretapam)' },
  { id: 'V3', category: 'violence', severity: 3, confidence: 0.99, stems: ['zastreluvam', 'pucam vo tebe'], reason: 'shooting threat' },
  { id: 'V4', category: 'violence', severity: 3, confidence: 0.99, stems: ['ke te najdam', 'kje te najdam'], reason: 'I will find you' },
  { id: 'V5', category: 'violence', severity: 3, confidence: 0.99, stems: ['ke ti gi skrsam', 'kje ti gi skrsam'], reason: 'I will break you' },
  { id: 'V6', category: 'violence', severity: 3, confidence: 0.98, stems: ['smrt', 'umri', 'crkni'], reason: 'death/die' },
  { id: 'V7', category: 'violence', severity: 3, confidence: 0.95, stems: ['znam kade rabotite', 'znam kade zivees'], reason: 'I know where you work/live (stalking)' },

  // ---------- CREEPY (severity 2) — personal-boundary questions ----------
  // NOTE: C1 ("kolku godini imas") was REMOVED in ANA — the age question is
  // answered with a hardcoded professional deflection instead of a strike.
  { id: 'C2', category: 'creepy', severity: 2, confidence: 0.85, stems: ['si mnogu mlada', 'dali si mlada'], reason: 'dali si mnogu mlada' },
  { id: 'C3', category: 'creepy', severity: 2, confidence: 0.85, stems: ['imas li dejko', 'imas li momce'], reason: 'imas li dejko' },
  { id: 'C4', category: 'creepy', severity: 2, confidence: 0.85, stems: ['kade zivis', 'kade zivees'], reason: 'kade zivis (personal home address)' },
  { id: 'C5', category: 'creepy', severity: 2, confidence: 0.85, stems: ['si doma sega', 'dali si doma sama'], reason: 'dali si doma sega (sega/sama REQUIRED — send-photos question stays clean)' },
  { id: 'C6', category: 'creepy', severity: 2, confidence: 0.85, stems: ['zives samo', 'zivis samo', 'zivees sama', 'zivis sama'], reason: 'dali zives samo' },
  { id: 'C9', category: 'creepy', severity: 2, confidence: 0.85, stems: ['pratam vecer', 'pisuvam vecer'], reason: 'dali mozam da ti pratam vecer' },
  { id: 'C10', category: 'creepy', severity: 2, confidence: 0.85, stems: ['ti e prazen stanot', 'prazen stanot vecer'], reason: 'dali ti e prazen stanot vecer (ti/vecer REQUIRED — is-apt-vacant stays clean)' },
  { id: 'C11', category: 'creepy', severity: 2, confidence: 0.85, stems: ['samo ke bides na poseta', 'samo kje bides na poseta', 'sama ke bides na poseta', 'sama kje bides na poseta'], reason: 'dali samo ke bides na poseta' },
  { id: 'C12', category: 'creepy', severity: 2, confidence: 0.85, stems: ['edvaj cekam da te zapoznaam', 'sakam da te zapoznaam'], excludeAfter: ['so'], reason: 'sakam da te zapoznaam (excludes "introduce you TO the client" via so-guard)' },

  // ---------- HEAVY INSULTS (severity 2) ----------
  { id: 'H1', category: 'heavy_insult', severity: 2, confidence: 0.9, stems: ['debil', 'dibil'], reason: 'debil' },
  { id: 'H2', category: 'heavy_insult', severity: 2, confidence: 0.9, stems: ['idiot', 'idioti'], reason: 'idiot' },
  { id: 'H3', category: 'heavy_insult', severity: 2, confidence: 0.9, stems: ['glupak', 'glupac', 'glupa'], reason: 'glupak/glupac' },
  { id: 'H4', category: 'heavy_insult', severity: 2, confidence: 0.9, stems: ['retard', 'retardiran'], reason: 'retard' },
  { id: 'H5', category: 'heavy_insult', severity: 2, confidence: 0.9, stems: ['kreten', 'kretens', 'kreteni'], reason: 'kreten' },
  // 'budi' was dropped vs ANA: it is the common neutral imperative "be"
  // ("budi iskren" = be honest — a normal client request), not an insult;
  // the unambiguous 'magare'/'magarcinja' (donkey/ass) keep the entry.
  { id: 'H6', category: 'heavy_insult', severity: 2, confidence: 0.9, stems: ['magare', 'magarcinja'], reason: 'magare' },
  { id: 'H7', category: 'heavy_insult', severity: 2, confidence: 0.9, stems: ['tupo devojce'], reason: 'tupo devojce' },
  { id: 'H8', category: 'heavy_insult', severity: 2, confidence: 0.9, stems: ['svinj', 'goved'], reason: 'svinja/govedo' },
  { id: 'H9', category: 'heavy_insult', severity: 2, confidence: 0.9, stems: ['vol'], boundary: true, reason: 'vol (letter-bounded so dozvola/izvoli stay clean)' },
  { id: 'H10', category: 'heavy_insult', severity: 2, confidence: 0.9, stems: ['izrod', 'nakaz', 'cudoviste'], reason: 'izrod/nakaz' },
  { id: 'H11', category: 'heavy_insult', severity: 2, confidence: 0.9, stems: ['psov', 'kletv'], reason: 'psov/kletva' },
  { id: 'H12', category: 'heavy_insult', severity: 2, confidence: 0.9, stems: ['jebem ti'], reason: 'jebem ti' },
  { id: 'H13', category: 'heavy_insult', severity: 2, confidence: 0.9, stems: ['materina', 'materinu'], reason: 'materina' },
  { id: 'H14', category: 'heavy_insult', severity: 2, confidence: 0.9, stems: ['koja si ti'], reason: 'koja si ti (NOT "koj si ti" — "кој си ти?" is a normal question)' },
  // kucko/kucka (bitch/dog) — kuchko, kučko, кучко all normalize here;
  // boundary keeps "kuce" (puppy — innocent pets talk) clean. Definite forms
  // (kuckata/kuckite/kuckoto) are separate stems because the boundary guard
  // rejects them when embedded.
  { id: 'H15', category: 'heavy_insult', severity: 2, confidence: 0.95, stems: ['kucko', 'kucka', 'kucki', 'kuckata', 'kuckite', 'kuckoto', 'kuckov', 'kuckova'], boundary: true, reason: 'kucko/kucka (bitch — kuchko, kučko, кучко all normalize here)' },
  // razeban/razebana/razebani/razebano = past participle of ебам (fucked) —
  // the S0k ebam family only covers present-tense forms; no boundary needed.
  { id: 'H16', category: 'heavy_insult', severity: 2, confidence: 0.95, stems: ['razeban', 'razebana', 'razebani', 'razebano'], reason: 'razebana (razeban/разебана — ebam past participle)' },
  // jebi se/go/te (fuck off / fuck you) — vulgar imperative; the mild
  // "odjebi" (M2) is a different word that normalizes separately.
  { id: 'H17', category: 'heavy_insult', severity: 2, confidence: 0.9, stems: ['jebi se', 'jebi go', 'jebi te'], reason: 'jebi se (fuck off/you — vulgar imperative)' },

  // ---------- MILD (severity 1) ----------
  { id: 'M1', category: 'mild', severity: 1, confidence: 0.8, stems: ['mlci', 'mlcis', 'utkni', 'zatkni'], reason: 'shut up (mlci/utkni/zatkni)' },
  { id: 'M2', category: 'mild', severity: 1, confidence: 0.8, stems: ['odjebi', 'odjebi se'], reason: 'odjebi' },
  { id: 'M3', category: 'mild', severity: 1, confidence: 0.8, stems: ['begaj', 'gubi se', 'nosi se'], reason: 'begaj/gubi se/nosi se' },
  { id: 'M4', category: 'mild', severity: 1, confidence: 0.8, stems: ['zajebavaj', 'zajebavas', 'zajebuvaj', 'zajebuvas', 'zaebavaj', 'zaebes', 'ne me zajebavaj', 'ne me zaebavaj'], reason: 'zajebavas family' },
  { id: 'M5', category: 'mild', severity: 1, confidence: 0.8, stems: ['mars'], reason: 'mars' },
  { id: 'M6', category: 'mild', severity: 1, confidence: 0.8, stems: ['bolesnik', 'bolesna'], reason: 'bolesnik' },
  { id: 'M7', category: 'mild', severity: 1, confidence: 0.8, stems: ['smesen', 'smesna'], reason: 'smeshen' },
  { id: 'M8', category: 'mild', severity: 1, confidence: 0.8, stems: ['lazo', 'laze', 'lazi', 'lazov'], reason: 'lazh/lazho' },
  { id: 'M9', category: 'mild', severity: 1, confidence: 0.8, boundary: true, stems: ['dosadna si', 'si dosadna', 'dosaden si', 'si dosaden', 'dosadni ste', 'dosadno e'], reason: 'you are annoying (DOSADNA SI)' },
  { id: 'M10', category: 'mild', severity: 1, confidence: 0.8, boundary: true, stems: ['otkaci se', 'otkazi se', 'otkazhi se'], reason: 'buzz off (OTKACI SE)' },
  { id: 'O1', category: 'mild', severity: 1, confidence: 0.8, stems: ['zamolci', 'kjuti', 'kjutis'], reason: 'zamolci/kjuti' },
  { id: 'O4', category: 'mild', severity: 1, confidence: 0.8, stems: ['ne znaes nisto'], reason: 'ne znaes nisto' },
  { id: 'O5', category: 'mild', severity: 1, confidence: 0.8, stems: ['ne si profesionalka'], reason: 'ne si profesionalka' },
  { id: 'O6', category: 'mild', severity: 1, confidence: 0.8, stems: ['prazna glavo'], reason: 'prazna glavo' },
  { id: 'O7', category: 'mild', severity: 1, confidence: 0.8, stems: ['lazi me'], reason: 'lazi me' },
  { id: 'O8', category: 'mild', severity: 1, confidence: 0.8, stems: ['odaj si'], reason: 'odaj si od tuka' },
];

// ========================================
// MATCHING ENGINE
// ========================================

const IS_LETTER = /[a-z]/;

function hasPhrase(norm: string, phrase: string, entry: LexiconEntry): boolean {
  let idx = 0;
  while ((idx = norm.indexOf(phrase, idx)) !== -1) {
    const before = idx === 0 ? '' : norm[idx - 1];
    const after = idx + phrase.length >= norm.length ? '' : norm[idx + phrase.length];

    // Letter-boundary guard: reject occurrences embedded inside a word.
    if (entry.boundary && (IS_LETTER.test(before) || IS_LETTER.test(after))) {
      idx += 1;
      continue;
    }

    // excludeAfter guard: reject this occurrence if the next word is excluded.
    if (entry.excludeAfter) {
      const rest = norm.slice(idx + phrase.length);
      const nextWord = (rest.match(/^\s+([a-z]+)/) || [])[1] || '';
      if (entry.excludeAfter.includes(nextWord)) {
        idx += 1;
        continue;
      }
    }

    return true;
  }
  return false;
}

function matchEntry(norm: string, entry: LexiconEntry): boolean {
  // Optional extra regex requirement (e.g. 'elena' must be near digits)
  if (entry.requireRegex && !entry.requireRegex.test(norm)) return false;
  // Optional anywhere-exclusion (e.g. smoking contexts for the pusenje family)
  if (entry.exclude && entry.exclude.some(e => norm.includes(e))) return false;
  for (const stem of entry.stems) {
    if (hasPhrase(norm, stem, entry)) return true;
  }
  return false;
}

// ========================================
// CLASSIFY OFFENSIVE
// ========================================

export interface OffenseDetection {
  isOffensive: boolean;
  severity: 0 | 1 | 2 | 3;
  category: string | null;
  confidence: number;
  reason: string | null;
}

/** Returns the offense verdict for a message — the deterministic scan that
 *  feeds the 3-strike protocol. NEVER relies on an LLM. */
export function classifyOffensive(text: string): OffenseDetection {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { isOffensive: false, severity: 0, category: null, confidence: 0, reason: null };
  }
  const norm = normalize(text);
  if (!norm) {
    return { isOffensive: false, severity: 0, category: null, confidence: 0, reason: null };
  }

  for (const entry of LEXICON) {
    if (matchEntry(norm, entry)) {
      return {
        isOffensive: true,
        severity: entry.severity as OffenseDetection['severity'],
        category: entry.category,
        confidence: entry.confidence,
        reason: entry.reason || `lexicon:${entry.id}`,
      };
    }
  }

  return { isOffensive: false, severity: 0, category: null, confidence: 0, reason: null };
}
