/**
 * THE MEMORY LEXICON MAY NOT FIRE ON A MAP PLACE NAME (AGENTS.md §4, one class
 * over: the strike classifier's stems have their own audit).
 *
 * The [23:12] capture: «SAKAM DA KUPAM TROSOBEN STAN KAJ BEVERLI HILS ILI
 * BUNJAKOVEC» was routed to the archive lane because the narration pattern
 * carried the open stems `bes/bev` — «bev» is a prefix of **BEV**ERLI, so a
 * landmark's own name satisfied the memory marker and the sighting arm (type
 * noun … narration) declared a RECALLED LISTING. The search then ran against
 * one anchor and the second landmark was never answered.
 *
 * The cause is generic: a short stem plus `\p{L}*` matches the beginning of any
 * innocent word. So the sweep runs EVERY shipped place name (POIs and street
 * names) through every memory reader, and a single hit is an appliance defect —
 * a client who writes «стан кај Besedi» would be answered as if he had seen a
 * listing there. The four names below were the real collisions; the sweep is
 * what finds the next one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config';
import { detectSeenListingRecall } from '../src/llm/deterministic';
import {
  pastMarkerPattern, hadPattern, wasPattern, sightPattern,
} from '../src/llm/lexicon/memory';

/** The four names the open narration stems used to swallow. */
const PINNED = ['Беверли Хилс', 'Best Travel', 'Besedi', 'American best burger'];

const READERS: Array<{ name: string; fires: (t: string) => boolean }> = [
  { name: 'recall', fires: t => detectSeenListingRecall(t) },
  { name: 'past', fires: t => pastMarkerPattern().test(t) },
  { name: 'had', fires: t => hadPattern().test(t) },
  { name: 'was', fires: t => wasPattern().test(t) },
  { name: 'sight', fires: t => sightPattern().test(t) },
  // NOT the ad NOUN: «недвижности» is a gate that only counts beside «уште
  // активен», and the cadastre places («Агенција за катастар на недвижности»)
  // legitimately carry it. The decision reader above already covers that arm.
];

test('a place name is never a memory marker', () => {
  for (const name of PINNED) {
    for (const r of READERS) {
      assert.equal(r.fires(name), false, `${r.name} fired on the place name «${name}»`);
    }
  }
  // The narration lane keeps its own words — precision, not a dead detector.
  assert.equal(wasPattern().test('kukjata BESE 130 000'), true);
  assert.equal(wasPattern().test('бевме кај вас вчера'), true);
});

test('every shipped place name is silent in the whole memory lexicon', () => {
  const cfg = loadConfig();
  if (!fs.existsSync(cfg.skopjePoisDb)) return; // no fetched map on this machine
  const db = new Database(cfg.skopjePoisDb, { readonly: true });
  const names = new Set<string>();
  try {
    for (const table of ['pois', 'addresses']) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map(c => c.name);
      const col = cols.includes('name') ? 'name' : cols.includes('street') ? 'street' : undefined;
      if (!col) continue;
      for (const row of db.prepare(`SELECT DISTINCT ${col} AS n FROM ${table}`).all() as Array<{ n: string }>) {
        if (row.n) names.add(row.n);
      }
    }
  } finally {
    db.close();
  }
  assert.ok(names.size > 1000, `the map must be the shipped one — got ${names.size} names`);
  const hits: string[] = [];
  for (const name of names) {
    for (const r of READERS) {
      if (r.fires(name)) { hits.push(`${r.name}: ${name}`); break; }
    }
  }
  assert.deepEqual(hits, [],
    `a map place name must never satisfy a memory reader (${hits.length} hits)`);
});
