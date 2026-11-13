// THE WHOLE BANK, SWEPT FOR ONE DEFECT CLASS: repeat avoidance that is dead
// because the bank's sentence reaches the screen WRAPPED.
//
// The [08:55] thread served the identical availability ack twice. The cause was
// not the pool (it has ten variants) but the freshness test: `recent` holds what
// was SENT, and callers compose a reply around the picked variant — a card
// PREPENDED (the flat's identity line above the ack), a footer APPENDED, or a
// relay clause inlined before it. The old exact-set comparison matched none of
// those shapes, so every wrapped serve could repeat verbatim. The fix compares
// the FILLED variant against each recent reply as a whole-token SPAN, so the
// wrapping shape no longer decides.
//
// TWO guards, both maintenance-proof:
//   1. THE BEHAVIOURAL SWEEP — every seed pool with at least two distinct
//      variants, every wrapping shape, many draws: the variant just served must
//      never come back. The reverse half proves the matcher is not so greedy
//      that a pool stops rotating (a different variant's composite must not
//      block a candidate).
//   2. THE SOURCE GUARD — every `pickVariant(` call site in `src/` passes
//      `recent`. A serve that forgets it cannot avoid a repeat at all, however
//      good the matcher is; a new site that forgets it lands RED here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import * as path from 'path';
import { findProjectRoot } from './helpers/project-root';
import {
  FIXED_SEEDS, POOL_CONTRACTS, pickVariant, seedVariants, normalizeVariant,
} from '../src/data/responseBank';
import { RESPONSE_BANK } from '../src/data/responses';

const KEYS = [...new Set([...Object.keys(FIXED_SEEDS), ...Object.keys(RESPONSE_BANK)])].sort();

/** Every pool the runtime can serve — seed layer plus any learned rows. */
function pools(): string[] {
  return KEYS.filter(k => new Set(seedVariants(k).map(normalizeVariant)).size >= 2);
}

/** Plausible values for the placeholders a pool uses, so the served text is
 *  the shape the client actually sees (a literal `{eb}` never reaches history,
 *  and an unfilled candidate would make the sweep test a dead comparison). */
const VARS: Record<string, string> = {
  eb: '79', time: 'Среда, 11.11.2026 во 18:00', term: 'Среда, 11.11.2026 во 18:00',
  location: 'Центар', place: 'Центар', area: 'Центар', prop: 'станот (Евидентен број 79)',
  price: '185.000', amount: '185.000', count: '3', n: '3', days: '2', kind: 'стан',
  left: '1', pre: 'претходно', fee: '500', pct: '50',
};
function varsFor(key: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const names = new Set(seedVariants(key).flatMap(v => [...v.matchAll(/{(\w+)}/g)].map(m => m[1])));
  for (const n of names) vars[n] = VARS[n] ?? 'ЗЗ';
  return vars;
}

/** The three wrapping shapes the executor composes around a picked variant. */
function wrappers(variant: string): Array<[string, string]> {
  return [
    ['card prepended', `Евидентен број 79 · двособен стан, 51 м² · 99.000 евра · Центар\n\n${variant}`],
    ['footer appended', `${variant}\n\nСо почит, вашата агенција Метрополис`],
    ['relay inlined', `Сопственикот се извинува. ${variant} Напишете ни кога Ви одговара.`],
  ];
}

const DRAWS = 24;

test('every bank pool retires a wrapped serve — no shape gets the same sentence twice', () => {
  const keys = pools();
  assert.ok(keys.length > 100, `the sweep must cover the real bank, got ${keys.length} pools`);
  const broken: string[] = [];
  for (const key of keys) {
    const vars = varsFor(key);
    const first = pickVariant(key, { vars });
    assert.ok(first, `${key}: the pool must serve something`);
    // A served text that its OWN contract rejects is served from the fallback
    // pool by design; the sweep still applies to whatever actually went out.
    for (const [shape, composite] of wrappers(first!)) {
      for (let i = 0; i < DRAWS; i++) {
        const again = pickVariant(key, { vars, recent: [composite] });
        if (again === first) { broken.push(`${key} [${shape}]`); break; }
      }
    }
  }
  assert.deepEqual(broken, [],
    `wrapped serves repeated (repeat avoidance misses this shape): ${broken.join(', ')}`);
});

test('the matcher is not greedy: another variant on the wire does not block the candidate', () => {
  // The failure the sweep above CANNOT see: if the span test matched too much,
  // every candidate would look "recent", the pool would fall back to its whole
  // list, and the repeat would come back through the fallback door.
  //
  // A variant that IS a sub-sentence of what was served (bye.again has
  // «Пријатно, до нареден пат.» and «Пријатно, до нареден пат. Поздрав!») is
  // legitimately retired — hearing it again reads as the same sentence — so a
  // pair like that proves nothing and the key is checked against a variant that
  // does not contain the candidate.
  const boundary = /[\p{L}\p{N}]/u;
  const isSpan = (haystack: string, needle: string): boolean => {
    const r = normalizeVariant(haystack);
    const t = normalizeVariant(needle);
    if (!t) return false;
    for (let at = r.indexOf(t); at !== -1; at = r.indexOf(t, at + 1)) {
      const before = at > 0 ? r[at - 1] : '';
      const after = r[at + t.length] ?? '';
      if (!boundary.test(before) && !boundary.test(after)) return true;
    }
    return false;
  };

  const blind: string[] = [];
  let checked = 0;
  for (const key of pools()) {
    const vars = varsFor(key);
    const first = pickVariant(key, { vars });
    if (!first) continue;
    // Collect what the pool prefers when the first variant is retired.
    const others = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const v = pickVariant(key, { vars, recent: [first] });
      if (v && v !== first) others.add(v);
    }
    let tested = false;
    let seen = false;
    for (const other of others) {
      const composite = wrappers(other)[0][1];
      if (isSpan(composite, first)) continue; // a real sub-sentence — correct to retire
      tested = true;
      for (let i = 0; i < 240 && !seen; i++) {
        seen = pickVariant(key, { vars, recent: [composite] }) === first;
      }
      break;
    }
    if (!tested) continue;
    checked++;
    if (!seen) blind.push(key);
  }
  assert.ok(checked > 90, `the reverse guard must really run, checked ${checked} pools`);
  assert.deepEqual(blind, [], `pools that stopped rotating after one serve: ${blind.join(', ')}`);
});

// ── the source guard ────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Drop comment-only lines so a doc sentence about pickVariant(key) is not a
 *  call site (arbiterLlm.ts documents the serve path in its header). */
function stripComments(src: string): string {
  return src.split('\n').map(line => {
    const t = line.trimStart();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? '' : line;
  }).join('\n');
}

test('every serve site tells the picker what was already served', () => {
  // findProjectRoot, not `__dirname/..`: under the bundled runner this file
  // lives in dist-test/tests/ and `..` is the BUNDLE dir, which has no src/
  // (the sweep failed with ENOENT: dist-test/src). The assertions are the same.
  const root = path.join(findProjectRoot(), 'src');
  const missing: string[] = [];
  let sites = 0;
  for (const file of walk(root)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    // The DEFINITION is not a serve site, and a thin wrapper that forwards its
    // own PickOpts (`pickVariant(hit.key, opts)`) carries `recent` through —
    // both are named here so the guard keeps its teeth for real call sites.
    for (const m of src.matchAll(/(?<!function )\bpickVariant\(/g)) {
      let depth = 0;
      let i = m.index! + 'pickVariant'.length;
      let text = '';
      for (; i < src.length; i++) {
        const c = src[i];
        text += c;
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) break;
      }
      sites++;
      if (!/\brecent\b|\bopts\b/.test(text)) {
        const line = src.slice(0, m.index!).split('\n').length;
        missing.push(`${path.relative(root, file)}:${line}`);
      }
    }
  }
  assert.ok(sites > 100, `the scan must see the real serve sites, got ${sites}`);
  assert.deepEqual(missing, [], `serve sites without recent (a repeat is unpreventable): ${missing.join(', ')}`);
});

test('the contracts the sweep relies on are the documented pools', () => {
  // The sweep serves through pickVariant, which filters by POOL_CONTRACTS; a
  // documented pool that lost its row would silently widen the candidate set.
  for (const key of Object.keys(POOL_CONTRACTS)) {
    assert.ok(seedVariants(key).length > 0, `contract row without a pool: ${key}`);
  }
});
