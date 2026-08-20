import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, classifyOffensive } from '../src/antiabuse/offensive';

test('normalize: folds Cyrillic into canonical casual Latin', () => {
  assert.equal(normalize('Добра локација, 2 спални'), 'dobra lokacija 2 spalni');
  assert.equal(normalize('ПИЧКА ТИ МАТЕР'), 'picka ti mater');
  assert.equal(normalize('Ќе бидеш ли фино девојче'), 'kje bides li fino devojce');
  assert.equal(normalize('Кучка разебана'), 'kucka razebana');
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
  ];
  for (const t of clean) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, false, JSON.stringify(t) + ' -> ' + (d.reason ?? 'clean'));
  }
});
