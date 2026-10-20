import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, classifyOffensive } from '../src/antiabuse/offensive';

test('normalize: folds Cyrillic into canonical casual Latin', () => {
  assert.equal(normalize('Добра локација, 2 спални'), 'dobra lokacija 2 spalni');
  assert.equal(normalize('ПИЧКА ТИ МАТЕР'), 'picka ti mater');
  assert.equal(normalize('Ќе бидеш ли фино девојче'), 'kje bides li fino devojce');
  assert.equal(normalize('Кучка разебана'), 'kucka razebana');
});

// The [20:14] field bug: the perfective "POEBAM" slipped past the S0k
// 'ebam' family (the 'o' prefix trips the letter-boundary guard) and the
// message was answered as a property-locate continuation. The prefixed/past
// forms are their own lexicon row now — and the innocent homographs that
// motivated the boundary guard must STAY clean.
test('prefixed/past ebam forms (poebam/naebam/ebal/jeban) are sexual severity 3', () => {
  for (const t of [
    'A DA TE POEBAM MALCE', 'da te poebam malce', 'ПОЕБАМ', 'поебам малце',
    'poebaj se', 'naebal sum', 'go ebala', 'jeban',
  ]) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, JSON.stringify(t) + ' -> ' + (d.reason ?? 'clean'));
    assert.equal(d.category, 'sexual', JSON.stringify(t));
    assert.equal(d.severity, 3, JSON.stringify(t));
  }
  for (const t of ['trebam', 'nebesa', 'poebanošе', 'zanaebana kola', 'sloboden', 'rebam']) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, false, JSON.stringify(t) + ' -> ' + (d.reason ?? ''));
  }
});

// The [14:01] field miss: "zimi kurov" (земи куров) was read as clean — the
// S0d row only listed 'kur' and 'kuro', and the possessive 'kurov' is neither
// (the boundary guard rejects 'kur'/'kuro' inside it). The possessive and
// definite forms are their own stems now; surnames and the innocent
// 'kultura'/'skurat' neighbours must stay clean via the boundary.
test('[14:01] possessive kurov (zimi kurov / земи куров) is sexual severity 3', () => {
  for (const t of [
    'zimi kurov', 'ZEMI KUROV', 'земи куров', 'ЗЕМИ КУРОВ',
    'kurov', 'kurot', 'kurovot', 'kurovi', 'kurovite',
    'kurov ti', 'zemi go kurot', 'kurov?',
    // the definite/possessive forms the boundary guard would otherwise reject
    'kuracot', 'kuracov', 'kuracite', 'kurci', 'kurcina', 'kurcinata', 'kurceto',
    'kurvata', 'kurvite', 'kurcinjata',
    'penisot', 'penisite', 'kurvin', 'kurvin sin', 'kurvina', 'kurvini',
  ]) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, JSON.stringify(t) + ' -> ' + (d.reason ?? 'clean'));
    assert.equal(d.category, 'sexual', JSON.stringify(t));
    assert.equal(d.severity, 3, JSON.stringify(t));
  }
  for (const t of ['kurovski', 'kurovska', 'kultura', 'skurat do park']) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, false, JSON.stringify(t) + ' -> ' + (d.reason ?? ''));
  }
});

test('normalize: folds Latin digraphs and leetspeak', () => {
  assert.equal(normalize('pi4ka'), 'picka');
  assert.equal(normalize('pichka'), 'picka');
  assert.equal(normalize('kuchka'), 'kucka');
  assert.equal(normalize('zamolchi'), 'zamolci');
  assert.equal(normalize('razebana'), 'razebana');
});

test('classify: the exact field insult is caught (severity 3, sexual)', () => {
  const d = classifyOffensive('DA SE EBETE VO GAZOT');
  assert.equal(d.isOffensive, true);
  assert.equal(d.severity, 3);
  assert.equal(d.category, 'sexual');
});

test('classify: heavy insults are severity 2', () => {
  for (const t of ['debilu', 'глупава си', 'kucko razebana', 'kreten', 'jebi se', 'не си професионалка? идиот']) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, JSON.stringify(t));
    assert.equal(d.severity, 2, JSON.stringify(t));
  }
});

test('classify: mild insults are severity 1', () => {
  for (const t of ['mlci', 'odjebi', 'begaj od tuka', 'mars', 'ne si profesionalka']) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, JSON.stringify(t));
    assert.equal(d.severity, 1, JSON.stringify(t));
  }
});

test('classify: violence and threats are severity 3', () => {
  for (const t of ['ke te ubijam', 'crkni', 'umri', 'ке те претепам']) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, JSON.stringify(t));
    assert.equal(d.severity, 3, JSON.stringify(t));
  }
});

test('classify: oral-sex variants (zemi/lapni/lizi/turam/go sakas) are caught', () => {
  const dirty = [
    'ZEMI GO NA USTA',
    'ZEMI GO U USTA',
    'lapni go',
    'lizi go',
    'go sakas odpozadi',
    'da ti go turam',
  ];
  for (const t of dirty) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, JSON.stringify(t));
    assert.equal(d.severity, 3, JSON.stringify(t));
  }
});

test('classify: substring class — innocent property words never fire (the lokaciJA lesson)', () => {
  const clean = [
    'skurat do gradski park',                 // 'kur' inside 'skurat' (street area!)
    'zgradata e vo blizina na kulturen dom',  // 'kur' inside 'kulturen'
    'sopstvenikot e cura',                    // bare 'cura' = girl, neutral speech
    'mreza od marselski klopi',               // 'mars' inside 'marselski'
    'avtobusot prelazi pred zgradata',        // 'lazi' inside 'prelazi' — bus crossings!
    'koga ke bide smrtno potrebno ke ve javam', // 'smrt' inside 'smrtno'
    'dokumentot ima smrtovni zabeleski',      // 'smrt' inside 'smrtovni'
    'stanot e vo blizina na Marsal Tito',     // 'mars' inside a real street name
  ];
  for (const t of clean) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, false, JSON.stringify(t) + ' -> ' + (d.reason ?? 'clean'));
  }
});

// The [00:29] field false positive: "NE ZNAM KONKRETEN STAN" + "SE NADEVAV
// DEKA VIE KE MI PREDLOZITE NESTO" — a politely disappointed client — served a
// strike-1 warning. 'kreten' (H5) had NO boundary and fired inside
// "konKRETEN" (конкретен = specific — core real-estate vocabulary). The line
// itself is clean; the follow-up was never an offense (strike 1 just decayed).
test('[00:29] konkreten (specific) is property talk, never the kreten insult', () => {
  const clean = [
    'NE ZNAM KONKRETEN STAN',
    'SE NADEVAV DEKA VIE KE MI PREDLOZITE NESTO',
    'ne znam konkreten stan',
    'КОНКРЕТЕН СТАН',            // cyrillic folds to the same canonical form
    'konkretno do 500 evra',
    'dali ima konkreten broj?',
  ];
  for (const t of clean) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, false, JSON.stringify(t) + ' -> ' + (d.reason ?? 'clean'));
  }
  // …but the real jabs — free-standing, plural and definite forms — still fire
  for (const t of ['ti si kreten', 'kreten eden', 'KRETENOT', 'kretenite', 'kretens', 'КРЕТЕНИ']) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, JSON.stringify(t) + ' must fire');
    assert.equal(d.category, 'heavy_insult', JSON.stringify(t));
  }
});

test('classify: 3rd-person lies about properties are complaints, not insults', () => {
  const clean = [
    'sopstvenikot laze za kvadraturata',  // client complaint about the OWNER
    'starite vladelci lazea za stanot',
  ];
  for (const t of clean) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, false, JSON.stringify(t) + ' -> ' + (d.reason ?? 'clean'));
  }
  // …but directed liar insults still fire
  for (const t of ['ti lazes', 'lazov eden', 'ti si lazov']) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, JSON.stringify(t) + ' must fire');
  }
});

test('classify: real insults still fire after the boundary sweep', () => {
  for (const t of ['A DA TE POEBAM MALCE', 'DA SE EBETE VO GAZOT', 'ti si debil', 'picka ti mater']) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, JSON.stringify(t) + ' must fire');
  }
});

test('[22:48] classify: directed crazy/sexist jabs are caught (the TI LUDA SI transcript)', () => {
  // The transcript missed the first two offenses; only GLUPACA SI (already in
  // the lexicon via 'glupac') fired. All three must strike now.
  const dirty = [
    'TI LUDA SI ?',
    'ti si luda',
    'luda li si',
    'lud si',
    'NE SI SO SITE DEVOJKO',      // the devojki typo form from the transcript
    'ne si kako site devojki',
    'so site zenski si',
  ];
  for (const t of dirty) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, JSON.stringify(t) + ' must fire');
    assert.equal(d.severity, 2, JSON.stringify(t) + ' = heavy_insult');
    assert.equal(d.category, 'heavy_insult', JSON.stringify(t));
  }
  // "you are all the same" dismissive generalization — mild
  for (const t of ['site isti ste', 'vie ste isti', 'isti si kako site']) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, JSON.stringify(t) + ' must fire');
    assert.equal(d.severity, 1, JSON.stringify(t) + ' = mild');
  }
  // neutral/3rd-person uses must stay clean
  for (const t of ['cenata e luda', 'lud e toa', 'kako site', 'dali ima ludi kaj koi stanot e dostapen']) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, false, JSON.stringify(t) + ' must stay clean');
  }
});

// THE прифаќам BUG: the polite verb "прифаќам" (to accept) normalizes to
// "prifakjam", and the unbounded 'fakj' stem read it as an English swear —
// severity 3, sexual. Every "не прифаќам" (the commission refusal!), "не ја
// прифаќам понудата", "да, прифаќам" got the professional-tone warning and a
// STRIKE instead of climbing the money ladder. The 'fakj' row is
// letter-bounded now; the real swear spellings stand alone and still fire.
test('прифаќам (to accept) is polite consent, never the fakj swear', () => {
  const clean = [
    'не прифаќам', 'НЕ ПРИФАЌАМ', 'прифаќам', 'да, прифаќам', 'не ја прифаќам понудата',
    'провизијата не ја прифаќам', 'ne ja prifakjam', 'prifakjam uslovite', 'не прифаќам провизија',
    'прифаќам, кога може да се погледне', 'ne prifakjam da plakjam provizija',
  ];
  for (const t of clean) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, false, JSON.stringify(t) + ' flagged: ' + (d.reason ?? ''));
  }
  // The genuine spellings of the same swear are standalone words — still caught.
  for (const t of ['fakj', 'fakji!', 'fakju', 'FAKJ TI MATER', 'fakjaj se', 'FUCK YOU', 'fucking hell']) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, JSON.stringify(t) + ' must fire');
    assert.equal(d.severity, 3, JSON.stringify(t));
  }
});

// THE [16:42] BURST — three consecutive abuses, only the first one struck:
//   "PRETERAVTE SO CENIVE PICKA VI MATERINA VISE" → strike 1 (S0c 'picka')
//   "MA KAKVA POCIT KURVETINO EDNA"             → CLEAN (kurv-+etina unlisted)
//   "DA TI GO ZBIBERAM MEGJU NOZE"              → CLEAN (whole threat unlisted)
// The two misses decayed nothing but let the funnel answer a second and third
// insult with the discovery greeting. Every line must now strike, in order.
test('[16:42] the insult burst is caught turn by turn', () => {
  const dirty = [
    'PRETERAVTE SO CENIVE PICKA VI MATERINA VISE',
    'MA KAKVA POCIT KURVETINO EDNA',
    'DA TI GO ZBIBERAM MEGJU NOZE',
    // Cyrillic typing of the same three
    'ПРЕТЕРАВТЕ СО ЦЕНИВЕ ПИЧКА ВИ МАТЕРИНА ВИШЕ',
    'МА КАКВА ПОЧИТ КУРВЕТИНО ЕДНА',
    'ДА ТИ ГО ЗБИБЕРАМ МЕЃУ НОЗЕ',
  ];
  for (const t of dirty) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, JSON.stringify(t) + ' -> ' + (d.reason ?? 'clean'));
    assert.equal(d.severity, 3, JSON.stringify(t));
    assert.equal(d.category, 'sexual', JSON.stringify(t));
  }
});

// GRAMMAR-BASED RECOGNITION — the lexicon now expands a ROOT over Macedonian
// endings (vocative -o/-u, definite -ot/-ta/-to/-te, plural -i/-ite, the
// augmentative -etina/-ina, and the verb's person/tense ladder) instead of
// only matching hand-listed surface forms.
test('grammar-expanded inflections of the sexual families are caught', () => {
  const dirty = [
    'kurva', 'kurvo', 'kurvi', 'kurvite', 'курвата', 'курви', 'курво',
    'kurvetina', 'kurvetino', 'kurvetinite', 'курветино',
    'picka', 'picki', 'picke', 'pickata', 'pickite', 'пичката', 'пички',
    'kurac', 'kurcu', 'kurcov', 'kurci', 'kurcina', 'kurcinata', 'курци',
    // ebam verb: prefix × person/tense
    'poebam', 'наебав', 'zaebi', 'izjeban', 'ebala', 'ebete', 'ebano',
  ];
  for (const t of dirty) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, JSON.stringify(t) + ' -> ' + (d.reason ?? 'clean'));
    assert.equal(d.category, 'sexual', JSON.stringify(t));
    assert.equal(d.severity, 3, JSON.stringify(t));
  }
});

test('grammar-expanded inflections of the heavy insults are caught', () => {
  const dirty = [
    'debil', 'debilu', 'debili', 'debilite', 'дебилу', 'дебили',
    'idiot', 'idiotu', 'idioti', 'идиоту', 'идиоти',
    'kreten', 'kretenu', 'kreteni', 'kretenot', 'кретени',
    'glupak', 'glupaku', 'glupaci', 'glupacite', 'глупава', 'глупави',
    'kucka', 'kucko', 'kucki', 'kuckite', 'кучки',
    'magare', 'magareto', 'magarci', 'магарето', 'магарци',
    // razeban/razebana keeps its own (severity-2) row — the sexual verb
    // pattern must not re-grade it.
    'razebana', 'kucko razebana',
  ];
  for (const t of dirty) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, JSON.stringify(t) + ' -> ' + (d.reason ?? 'clean'));
    assert.equal(d.severity, 2, JSON.stringify(t));
  }
});

// The SAME grammar must never widen onto property vocabulary — these are the
// neighbours the whole-word boundary exists for.
test('grammar-expanded roots never fire inside innocent real-estate words', () => {
  const clean = [
    'konkreten stan', 'КОНКРЕТЕН СТАН', 'kultura', 'kulturen dom', 'skurat do park',
    'trebam stan', 'nebesa', 'potrebno e', 'izgradi se zgradata', 'dozvola za gradba',
    'kucni ljubimci', 'kuce', 'magacin', 'idiotizam na pazarot',
    'glupo e da se plati tolku', 'diskriminacija',
    'prifakjam', 'ne prifakjam', 'fakt e deka cenata e dobra',
  ];
  for (const t of clean) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, false, JSON.stringify(t) + ' -> ' + (d.reason ?? 'clean'));
  }
});

test('classify: normal real-estate talk is never offensive', () => {
  const clean = [
    'Здраво, сакам стан под кирија.',
    'bilo kade do 250',
    'sakam stan so 2 spalni vo centar do 250 evra',
    'dali e sloboden?',
    'koga moze da se pogledne',
    'dali smee pusenje vo stanot?',       // smoking question, not oral-sex
    'dozvoleno li e pusenje na balkon?',
    'da pusam na balkon?',
    'kucni ljubimci se dozvoleni?',        // pets talk — 'kuce' must stay clean
    'dali ima parkiranje i lift',
    'kolku e cenata, budi iskren',         // 'budi iskren' = be honest — never a strike
    'napravete analiza na cenite',         // 'anal' in 'analiza' — never a strike
    'ima dozvola za gradba',               // 'vol' in 'dozvola' stays clean
    'izgradeno e 2020 godina',             // 'gradi' in 'izgradeno' stays clean
    'fakt deka cenata e dobra',            // 'fak' in 'fakt' stays clean
    'ne sum vraboten, kako funkcionira cela procedura?',
    'sakam da ja vidam 74',
    'dali moze da se vidi ovaa nedela?',
    'turam se kon tebe, ne me cekaj',     // 'turam' in construction/colloquial context
    'gradi se zgradata',                  // 'gradi se' = being built, not sexual
    'odzadi e stanot',                    // 'odzadi' = in the back — real estate
    'lapa supa',                          // 'lapa' = eats (soup) — not oral-sex
  ];
  for (const t of clean) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, false, JSON.stringify(t) + ' -> ' + (d.reason ?? 'clean'));
  }
});
