// THE SCHOOL-NAME BRIDGE.
//
// The map files schools the way the registry does: under an abbreviation
// (СЕПУГС, СУГС, ООУ, ДСУ) or with the type as an adjective («Медицинско
// училиште»). Clients say neither — they use the definite adjectival form and
// drop the noun: «медицинското», «хемиското», «угостителското», «економското».
// Every one of those MISSED the map: the definite suffix is part of the name as
// typed, so no substring pass could see the row's bare stem, and with the noun
// elided there was no word to match at all. The distance/where lanes then fell
// through and the client was told the place was unknown — while the row sat in
// the table (the [11:28] capture: «NA KOLKAVO RASTOJANIE SE DO EKONOMSKOTO?»).
//
// The bridge is a bounded completion: the article comes off, and a school-type
// ADJECTIVE is completed with «училиште»/«гимназија». It runs only after the
// exact passes miss, so it can never displace a real hit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OfflineMapStore, schoolQueryForms, writeMap } from '../src/geo/offlineMap';

const map = ((): OfflineMapStore => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'school-bridge-')), 'map.db');
  writeMap(p, [
    { name: 'Медицинско Училиште', type: 'school', lat: 42.0000, lon: 21.4300, source: 'google' },
    { name: 'Хемиско Училиште', type: 'school', lat: 42.0010, lon: 21.4310, source: 'google' },
    { name: 'Средно угостителско училиште „Лазар Танев“', type: 'school', lat: 42.0020, lon: 21.4320, source: 'google' },
    { name: 'СЕПУГС Васил Антевски - Дрен', type: 'school', lat: 41.9799, lon: 21.4389, source: 'google' },
    { name: 'Музичко-балетско училиште „Илија Николовски - Луј“', type: 'school', lat: 42.0030, lon: 21.4330, source: 'google' },
    { name: 'Пекон', type: 'bakery', lat: 42.0040, lon: 21.4340, source: 'google' },
  ], []);
  return new OfflineMapStore(p);
})();

const center = { lat: 41.9813, lon: 21.4382 };

test('a definite school adjective reaches the row the map files it under', () => {
  const cases: Array<[string, RegExp]> = [
    ['медицинското', /Медицинско Училиште/u],
    ['МЕДИЦИНСКОТО УЧИЛИШТЕ', /Медицинско Училиште/u],
    ['хемиското', /Хемиско Училиште/u],
    ['угостителското', /угостителско училиште/u],
    ['музичкото', /[Мм]узичко/u],
    ['економското', /СЕПУГС/u],
    ['економско-правното', /СЕПУГС/u],
  ];
  for (const [q, want] of cases) {
    const hit = map.findPoiByName(q, center);
    assert.ok(hit, `${q} must resolve`);
    assert.match(hit!.name, want, `${q} → ${hit!.name}`);
  }
});

test('the exact passes still win — the bridge never displaces a real hit', () => {
  assert.equal(map.findPoiByName('Медицинско Училиште', center)?.name, 'Медицинско Училиште');
  // An exact abbreviation the client typed still resolves as typed.
  assert.match(map.findPoiByName('СЕПУГС Васил Антевски - Дрен', center)!.name, /СЕПУГС/u);
});

test('schoolQueryForms: the article comes off, the elided noun is completed', () => {
  const forms = schoolQueryForms('медицинското');
  assert.ok(forms.includes('медицинско'), `the stripped stem: ${forms.join(' | ')}`);
  assert.ok(forms.includes('медицинско училиште'), `the completed noun: ${forms.join(' | ')}`);
  // Multi-word: the article is stripped, the noun is already there.
  assert.ok(schoolQueryForms('МЕДИЦИНСКОТО УЧИЛИШТЕ').includes('МЕДИЦИНСКО УЧИЛИШТЕ'));
  // A NON-school adjective is never completed into a school.
  for (const f of schoolQueryForms('големото')) {
    assert.ok(!/училиште|гимназија/u.test(f), `never a school: ${f}`);
  }
  // …and a non-school place is never turned into one by the bridge either.
  assert.equal(map.findPoiByName('пекарата', center), undefined);
});
