// THE MAP-WIDE PLACE-BINDING SWEEP.
//
// Three captures in a row were the same defect seen from three angles:
//   [18:34] «MI TREBA STAN KAJ CITY MALL»   → script mismatch (Latin map, Cyrillic wish)
//   [18:47] «STANCE ZA PRODAVANJE KAJ DRZAVNA BOLNICA» → the place was not IN the map
//   [20:49] «MI TREBA STAN KAJ CITY MOL»   → spelling family (mol/mall, siti/city)
// Every one of them was found by a client. This test walks the LIVE map
// instead: every row must bind when the client says that row's own name, and
// the cross-script / spelling-variant coverage may never drop below the floor
// measured today. A regression next to the one we just fixed fails the build
// here, not in somebody's chat.
//
// The floor exists on purpose. 100% is not reachable by this fold: a machine
// transliteration of ENGLISH names («Bakery» → «бакерј») is not what a client
// types, and some rows are OCR junk («Reptil Market br.11 Drzavna bolnica»).
// Raise the floor when the number improves; never lower it to make a build go
// green — that is the same as deleting the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config';
import { poiNameCoversClientWords } from '../src/handlers/inbound';
import { toCyrillic, toLatin, soundKey, canonicalWordKey } from '../src/geo/offlineMap';

const dbPath = loadConfig().skopjePoisDb;
const hasMap = !!dbPath && fs.existsSync(dbPath);
const CYR = /[\u0400-\u04FF]/;

function names(): string[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = (db.prepare('SELECT name FROM pois').all() as Array<{ name: string }>)
    .map(r => r.name).filter(Boolean);
  db.close();
  return rows;
}

test('the sound key folds the spelling families this business actually meets', () => {
  // The families from the captures — and the ones one step away.
  const same: Array<[string, string]> = [
    ['City', 'Siti'], ['сити', 'Siti'], ['Mall', 'Mol'], ['мол', 'малл'],
    ['Center', 'Centar'], ['центар', 'Center'], ['Kipper', 'Кипер'],
    ['Broz', 'Броз'], ['Kafe', 'Кафе'], ['Skopje', 'Скопје'],
    ['Parking', 'Паркинг'], ['Tower', 'Тауер'], ['Beverly', 'Беверли'],
  ];
  for (const [a, b] of same) {
    assert.equal(canonicalWordKey(a), canonicalWordKey(b), `«${a}» and «${b}» are one word`);
  }
  // …and the fold may never MERGE different words into one key.
  const different: Array<[string, string]> = [
    ['KAM', 'KAN'], ['Skopje', 'Sarajevo'], ['Mall', 'Market'],
    ['Bolnica', 'Akademija'], ['Vero', 'Vodno'],
  ];
  for (const [a, b] of different) {
    assert.notEqual(canonicalWordKey(a), canonicalWordKey(b), `«${a}» ≠ «${b}»`);
  }
  // Digits are identity, not sound.
  assert.notEqual(soundKey('Бит Пазар 1'), soundKey('Бит Пазар 2'));
  assert.equal(soundKey('Бит Пазар 1'), soundKey('bit pazar 1'));
});

test('[sweep] EVERY place in the live map binds when the client says its own name', { skip: !hasMap }, () => {
  const all = names();
  assert.ok(all.length > 1000, `the live map looks empty (${all.length} rows)`);
  const CITY_ONLY = /^(?:скопје|скопју|скопје\s+\d+|skopje(?:\s+\d+)?)$/iu;
  const refused: string[] = [];
  for (const name of all) {
    // The city itself is not a landmark: rows named ONLY «Скопје» are refused
    // on purpose (a client saying «Skopje» has named no place).
    if (CITY_ONLY.test(name.trim())) continue;
    if (!poiNameCoversClientWords(name, name)) refused.push(name);
  }
  assert.deepEqual(refused.slice(0, 20), [],
    `${refused.length}/${all.length} map names are refused by the coverage guard`);
});

test('[sweep] cross-script and spelling-variant coverage stays above the measured floor', { skip: !hasMap }, () => {
  const all = names();
  let checked = 0, accepted = 0;
  const misses: string[] = [];
  for (const name of all) {
    const q = CYR.test(name) ? toLatin(name) : toCyrillic(name);
    if (q === name) continue;
    checked++;
    if (poiNameCoversClientWords(q, name)) accepted++;
    else if (misses.length < 20) misses.push(`${name} ⇐ «${q}»`);
  }
  const ratio = checked === 0 ? 1 : accepted / checked;
  // Measured 95.1% on 2026-10-28 (5,992 rows). The gap is machine
  // transliteration of ENGLISH names («Bakery» → «бакерј»), which is not what
  // a client types — not a spelling family. Raise the floor as it improves.
  const FLOOR = 0.94;
  assert.ok(ratio >= FLOOR,
    `cross-script coverage fell to ${(ratio * 100).toFixed(1)}% (floor ${FLOOR * 100}%) — e.g. ${misses.join(' | ')}`);
});

// ── THE GUARD'S TOLERANCE, PINNED ──────────────────────────────────────────
// The typed-lookup tolerance above is only half the bind: the handler's
// coverage guard must then ACCEPT the row. Three shapes were refused before the
// [21:41]–[21:46] captures — a venue word in front of the name, a connector as
// the first word, and a name of short words only — and one was refused by the
// old one-slip-per-NAME budget. All four are pinned here, together with the
// misses that must never open up.
test('the coverage guard tolerates typos, venue words and connector heads — and nothing else', () => {
  // The [21:45] capture: «ДАЈМОНД МОЛ» is the map's «Diamond Mall»; the j is a
  // spelling, not a different word.
  assert.equal(poiNameCoversClientWords('ДАЈМОНД МОЛ', 'Diamond Mall'), true);
  assert.equal(poiNameCoversClientWords('дајмонд мол', 'Diamond Mall'), true);
  // A venue word in front is class, not identity («ТЦ Џевахир» is the complex
  // the map files as «Џевахир кула А»).
  assert.equal(poiNameCoversClientWords('ТЦ Џевахир', 'Џевахир кула А'), true);
  assert.equal(poiNameCoversClientWords('TC DZEVAHIR', 'Џевахир кула А'), true);
  // A connector or a generic word can never be the head (the map-wide audit).
  assert.equal(poiNameCoversClientWords('Кај Џино', 'Кај Џино'), true);
  assert.equal(poiNameCoversClientWords('The Gallery', 'The Gallery'), true);
  assert.equal(poiNameCoversClientWords('Трговски центар', 'Трговски центар'), true);
  // …and a short name is still its own name («DM», not a ≥3-letter head).
  assert.equal(poiNameCoversClientWords('DM', 'DM'), true);
  // THE SLIP IS PER WORD: one typo in each word of a two-word name.
  assert.equal(poiNameCoversClientWords('Комерцијална Карпош', 'Комерцјална Карпоша'), true);
  assert.equal(poiNameCoversClientWords('Бунјаковац', 'Буњаковец'), true);
  // ONE INSERTED MAP WORD is still the same name: the map carries a qualifier
  // the client omits («Буњаковец кула 5» for «Бунјаковац 5»).
  assert.equal(poiNameCoversClientWords('Бунјаковац 5', 'Буњаковец кула 5'), true);
  assert.equal(poiNameCoversClientWords('Рамстор Мол', 'Рамстор Сити Мол'), true);
  // …but the CLIENT may not add a word, and the map may not insert TWO.
  assert.equal(poiNameCoversClientWords('Бунјаковац кула 5', 'Буњаковец 5'), false);
  assert.equal(poiNameCoversClientWords('Бунјаковац 5', 'Буњаковец кула стара 5'), false);

  // THE CONTRACT THAT MUST NOT WEAKEN.
  // Short words stay exact („KAM“/„KAN“ are different places).
  assert.equal(poiNameCoversClientWords('KAM', 'KAN'), false);
  // A generic word is dropped only as a PREFIX — «Веро Центар» (the mall) is
  // not «Веро 9» (the shop inside it).
  assert.equal(poiNameCoversClientWords('Веро Центар', 'Веро 9'), false);
  // A brand in FRONT of the client's words is a different place.
  assert.equal(poiNameCoversClientWords('ELS Novo Lisice', 'Novo Lisice'), false);
  // A different KIND of institution is never that place.
  assert.equal(poiNameCoversClientWords('Воена болница', 'Воена академија Генерал Михаило Апостолски'), false);
});

// THE TYPE-FIRST SCHOOLS.
//
// The map files most schools behind their type — «ООУ „Димитар Македонски“»,
// «Средно уметничко училиште „Лазар Личеновски“», «Гимназија Орце Николов кон
// Влае» — so the map name's head is «ООУ»/«средно»/«гимназија», a word the
// client never said, and the coverage guard refused the school he named. The
// type is class, not identity (the same contract as «ТЦ»), so it is stripped
// from the map's leading run AND the client's — but only while an identity word
// survives, and never for a name that merely starts with the adjective.
test('a school filed behind its TYPE binds by its own name — and only that name', () => {
  // Every shape the live map carries: abbreviations, type phrases, a Latin row.
  assert.equal(poiNameCoversClientWords('Стив Наумов', 'ООУ Стив Наумов'), true);
  assert.equal(poiNameCoversClientWords('Димитар Македонски', 'ООУ „Димитар Македонски“'), true);
  assert.equal(poiNameCoversClientWords('Лазар Личеновски', 'Средно уметничко училиште „Лазар Личеновски“'), true);
  assert.equal(poiNameCoversClientWords('Битолски Конгрес', 'ОУГС Битолски Конгрес'), true);
  assert.equal(poiNameCoversClientWords('Орце Николов кон Влае', 'Гимназија Орце Николов кон Влае'), true);
  assert.equal(poiNameCoversClientWords('Lazo Trpovski', 'Elementary School "Lazo Trpovski"'), true);
  assert.equal(poiNameCoversClientWords('Лазар Танев', 'Catering High School „Lazar Tanev“'), true);
  // The school's own FULL name — type words included — still binds to itself.
  assert.equal(poiNameCoversClientWords('ООУ Стив Наумов', 'ООУ Стив Наумов'), true);
  // …and from the other script, which is how the extractor hands it over.
  assert.equal(poiNameCoversClientWords('OOU Stiv Naumov', 'ООУ Стив Наумов'), true);

  // A TYPE ALONE NAMES NO SCHOOL. «Угостителско училиште» is a description,
  // not the one catering school in town, and a bare «училиште» is not a place.
  assert.equal(poiNameCoversClientWords('Угостителско училиште', 'Средно угостителско училиште „Лазар Танев“'), false);
  assert.equal(poiNameCoversClientWords('училиште', 'ООУ Стив Наумов'), false);
  // A DIFFERENT SCHOOL is still a different school.
  assert.equal(poiNameCoversClientWords('Стив Наумов', 'ООУ Круме Кепески'), false);
  // «Средно Нерези»/«Средно Водно» are SETTLEMENTS whose name merely starts
  // with the adjective — no marker word, so the type strip never fires.
  assert.equal(poiNameCoversClientWords('Нерези', 'Средно Нерези'), false);
  assert.equal(poiNameCoversClientWords('Водно', 'Средно Водно'), false);
});
