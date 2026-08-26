/**
 * Macedonian Phrase Pattern — Compact Word-Class Regex
 *
 * Instead of enumerating every phrase variation (14K+ combinations),
 * builds a compact regex from word-class alternations:
 *
 *   (што|како|какви|кои) (уште|добро)? (има|се наоѓа|постои) (во|околу|кај)? (околината|близината|тука)?
 *
 * This matches hundreds of natural phrasings with a single regex.
 *
 * Usage:
 *   const re = nearbyAreaRegex();
 *   re.test('што има во околината?');     // true
 *   re.test('kako uste ima okolu?');      // true
 *   re.test('koi objekti postoi blizu?'); // true
 */

// ── Word classes ────────────────────────────────────────────────────────────

/** Question/determiner words */
const Q = ['што', 'како', 'какви', 'какво', 'кои', 'кој', 'колку'];
const Q_L = ['sto', 'kako', 'kakvi', 'kakvo', 'koi', 'koj', 'kolku'];

/** Emphasis/filler words (optional, after Q) */
const F = ['уште', 'добро', 'арно', 'друго'];
const F_L = ['uste', 'dobro', 'arno', 'drugo'];

/** Verbs / copulas */
const V = ['има', 'има ли', 'се наоѓа', 'постои', 'ги има', 'е', 'е ли', 'ги нема'];
const V_L = ['ima', 'ima li', 'se naogja', 'postoi', 'gi ima', 'e', 'e li', 'gi nema'];

/** Prepositions / location words (optional, after verb) */
const P = ['во', 'на', 'околу', 'кај', 'близу', 'близу до'];
const P_L = ['vo', 'na', 'okolu', 'kaj', 'blizu', 'blizu do'];

/** Location nouns (optional, after preposition) */
const L = ['околината', 'близината', 'тука', 'овде', 'реонот', 'зоната'];
const L_L = ['okolinata', 'blizinata', 'tuka', 'ovde', 'reonot', 'zonata'];

/** Object-type nouns (for "какви објекти" queries) */
const O = ['објекти', 'места', 'продавници', 'згради', 'локали', 'работи'];
const O_L = ['objekti', 'mesta', 'prodavnici', 'zgradi', 'lokali', 'raboti'];

// ── Build compact regex ─────────────────────────────────────────────────────

function or(words: string[]): string {
  return '(?:' + words.join('|') + ')';
}

/**
 * Builds a single regex that matches ALL natural near-area question phrasings.
 *
 * Pattern structure:
 *   Q F? V P? L?         — "што уште има околу околината?"
 *   Q O V P?             — "какви објекти има во?"
 *   Q F? (е|е ли) P? L?  — "што е околу?"
 *   P Q V                — "околу што има?"
 *   F Q V                — "друго што има?"
 *   V li Q P? L?         — "има ли нешто околу?"
 */
export function nearbyAreaRegex(): RegExp {
  const parts: string[] = [];

  const QF = [...Q, ...Q_L];
  const FF = [...F, ...F_L];
  const VF = [...V, ...V_L];
  const PF = [...P, ...P_L];
  const LF = [...L, ...L_L];
  const OF = [...O, ...O_L];

  // Pattern 1: Q (F? V) (P L?)  — most common
  // "што има во околината?", "како уште се наоѓа близу?"
  parts.push(
    or(QF) + '(?:\\s+' + or(FF) + ')?' +
    '\\s+' + or(VF) +
    '(?:\\s+' + or(PF) + '(?:\\s+' + or(LF) + ')?)?'
  );

  // Pattern 2: Q O V P?  — "какви објекти има околу?"
  parts.push(
    or(QF) + '\\s+' + or(OF) +
    '\\s+' + or(VF) +
    '(?:\\s+' + or(PF) + ')?'
  );

  // Pattern 3: P Q V  — "околу што има?"
  parts.push(
    or(PF) + '\\s+' + or(QF) +
    '\\s+' + or(VF)
  );

  // Pattern 4: F Q V  — "друго што има?"
  parts.push(
    or(FF) + '\\s+' + or(QF) +
    '\\s+' + or(VF)
  );

  // Pattern 5: V li (нешто)? (P L?)?  — "има ли нешто околу?"
  parts.push(
    or(VF) + '\\s+(?:ли|li)(?:\\s+(?:нешто|nesto)(?:\\s+(?:друго|drugo|уште|uste))?)?' +
    '(?:\\s+' + or(PF) + '(?:\\s+' + or(LF) + ')?)?'
  );

  return new RegExp('(?:' + parts.join('|') + ')', 'iu');
}

// ── Generate sample phrases for testing ─────────────────────────────────────
export function sampleNearbyPhrases(): string[] {
  return [
    // Cyrillic
    'што има во околината?',
    'што уште има околу?',
    'што друго има во близина?',
    'какви објекти има околу?',
    'кои места се наоѓа близу?',
    'што е околу?',
    'околу што има?',
    'друго што има?',
    'има ли нешто околу?',
    'има ли нешто друго во околината?',
    'што има тука?',
    'какво има близу?',
    'колку објекти има околу?',
    'што се наоѓа во близина?',
    'што е во близина?',
    // Latin
    'sto ima vo okolinata?',
    'kako uste ima okolu?',
    'sto drugo ima vo blizina?',
    'kakvi objekti ima okolu?',
    'koi mesta se naogja blizu?',
    'sto e okolu?',
    'okolu sto ima?',
    'drugo sto ima?',
    'ima li nesto okolu?',
    'ima li nesto drugo vo okolinata?',
    'sto ima tuka?',
    'kakvo ima blizu?',
    'sto se naogja vo blizina?',
    'sto e vo blizina?',
  ];
}
