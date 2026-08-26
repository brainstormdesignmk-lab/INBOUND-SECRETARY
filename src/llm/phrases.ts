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
    // ── што + има (what + has) ──
    'што има во околината?',
    'што уште има околу?',
    'што друго има во близина?',
    'што има тука?',
    'што има околу?',
    'што уште има тука?',
    'што друго има тука?',
    'што има близу?',
    'што уште има близу?',
    // ── кои/какви + објекти + има (which/what objects + has) ──
    'какви објекти има околу?',
    'кои објекти има околу?',
    'колку објекти има околу?',
    'какви објекти има тука?',
    'кои објекти има тука?',
    'какви објекти има близу?',
    'кои објекти има близу?',
    // ── кои/какви + објекти + се (which/what objects + are) ──
    'кои објекти се тука?',
    'какви објекти се тука?',
    'кои објекти се околу?',
    'какви објекти се околу?',
    'кои објекти се близу?',
    'какви објекти се близу?',
    // ── кои други објекти (which other objects) ──
    'кои други објекти се тука?',
    'кои други објекти има?',
    'кои други објекти има околу?',
    'какви други објекти се тука?',
    'какви други објекти има?',
    // ── што е/се (what is/are) ──
    'што е околу?',
    'што е тука?',
    'што е во близина?',
    'што се наоѓа во близина?',
    'што се наоѓа околу?',
    'што се наоѓа тука?',
    // ── inverted / emphasis ──
    'околу што има?',
    'друго што има?',
    'уште што има?',
    'има ли нешто околу?',
    'има ли нешто друго во околината?',
    'има ли нешто тука?',
    'какво има близу?',
    'кои места се наоѓа близу?',
    // ── Latin equivalents ──
    'sto ima vo okolinata?',
    'kako uste ima okolu?',
    'sto drugo ima vo blizina?',
    'sto ima tuka?',
    'sto ima okolu?',
    'sto ima blizu?',
    'kakvi objekti ima okolu?',
    'koi objekti ima okolu?',
    'kakvi objekti ima tuka?',
    'koi objekti ima tuka?',
    'koi objekti se tuka?',
    'kakvi objekti se tuka?',
    'koi objekti se okolu?',
    'kakvi objekti se okolu?',
    'koi drugi objekti se tuka?',
    'koi drugi objekti ima?',
    'kakvi drugi objekti se tuka?',
    'kakvi drugi objekti ima?',
    'sto e okolu?',
    'sto e tuka?',
    'sto e vo blizina?',
    'sto se naogja vo blizina?',
    'sto se naogja okolu?',
    'sto se naogja tuka?',
    'okolu sto ima?',
    'drugo sto ima?',
    'ste sto ima?',
    'ima li nesto okolu?',
    'ima li nesto drugo vo okolinata?',
    'ima li nesto tuka?',
    'kakvo ima blizu?',
    'koi mesta se naogja blizu?',
  ];
}
