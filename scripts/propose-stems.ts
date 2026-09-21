#!/usr/bin/env tsx
/**
 * propose-stems — the bridge from sweep corpora to detector patches.
 *
 * For every family's GAP phrases: extract distinctive vocabulary (word stems +
 * multiword idioms + whole-phrase literals as the completeness floor), EXCLUDE
 * anything that belongs to a rival family's true-target vocabulary (negative
 * corpus), then emit src/llm/detectorExt.ts with one extension regex per
 * family. Stems are canonicalized through normalizeMc (Cyrillic-authored —
 * matchesBoth folds Latin input to it). VALIDATES every proposal against its
 * own corpus before emitting: a proposal that misses its GAP phrase is a bug
 * in the proposal, not in the corpus.
 *
 * REPORT + EMIT ONLY — wiring into deterministic.ts is the separate step.
 *
 * Usage: npx tsx scripts/propose-stems.ts [--emit]
 */

import '../src/compat/node16';
import * as fs from 'fs';
import { normalizeMc } from '../src/llm/normalize';
import { FAMILIES } from './sweep-keys';

interface Row { phrase: string; verdict: 'COVERED' | 'GAP' | 'CROSS'; target: boolean; cross: string[] }

// Fillers that must never become stems (function words, generic real-estate
// nouns, numbers). Stems are lowercase, script-folded by normalizeMc.
const STOP = new Set([
  'ми', 'ти', 'му', 'и', 'м', 'е', 'је', 'да', 'не', 'за', 'од', 'на', 'во', 'со', 'ке', 'ќе', 'би', 'ли',
  'dali', 'kolku', 'stan', 'stanot', 'stanov', 'stanovi', 'imot', 'imotot', 'cena', 'cenata', 'cenua',
  'evra', 'evro', 'evr', 'denari', 'den', 'mkd', 'kilata', 'kila', 'kirija', 'kirijata', 'kupam',
  'kupuvam', 'sakam', 'baram', 'treba', 'trebat', 'mozam', 'mozete', 'moze', 'samo', 'uste', 'sega',
  'togash', 'ovoj', 'ovaa', 'ovie', 'toj', 'taa', 'tie', 'edna', 'eden', 'dve', 'tri', 'goo', 've',
  'vas', 'vama', 'nema', 'ima', 'kade', 'kadee', 'shto', 'sto', 'zoshto', 'zoska', 'kako', 'koe',
  'koga', 'dole', 'ovde', 'tuka', 'mene', 'tebe', 'nego', 'nie', 'tie', 'sopstvenik', 'sopstvenikot',
  'agent', 'agencija', 'metropolis', 'lina', 'drugo', 'drugi', 'drugi', 'nesto', 'nekoj', 'bilo',
  'super', 'dobro', 'ok', 'okej', 'fala', 'blagodaram', 'zdravo', 'aj', 'ajde', 'hajde', 'daj',
  'dajte', 'mole', 'molam', 've', 'mora', 'moram', 'sme', 'sum', 'beshe', 'ke', 'dali',
]);

const wordify = (s: string): string[] =>
  normalizeMc(s.toLowerCase()).split(/[^@\p{L}\p{N}]+/u).filter(w => w.length > 0);

/** Stem: drop trailing Macedonian suffix vowels/Clitics, floor 4 chars. */
function stemOf(w: string): string | undefined {
  if (STOP.has(w) || /^\d+$/.test(w) || w.length < 4) return undefined;
  const stem = w.replace(/(?:ата|ето|ита|ота|ува|те|то|та|ата|ото|и|а|о|е|у|ј)+$/u, '');
  if (stem.length < 4) return undefined;
  return stem;
}

function loadCorpora(): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const f of FAMILIES) {
    const file = `data/hardening/${f.id}.json`;
    if (!fs.existsSync(file)) continue;
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as { rows?: Row[] };
    if (Array.isArray(saved.rows)) out.set(f.id, saved.rows);
  }
  return out;
}

interface Proposal {
  id: string; stems: string[]; idioms: string[]; literals: string[];
  excludes: string[];          // rival-vocabulary regex sources
  rawIdioms?: string;          // pre-escaped regex source, emitted verbatim
  fixed: number; stillGap: string[];
}

function propose(corpora: Map<string, Row[]>): Proposal[] {
  // Negative corpus: for each family, the folded tokens of every OTHER
  // family's true-target phrase (target fired). A stem found here belongs to
  // the rival's vocabulary — it must never be proposed for this family.
  const rivalTokens = new Map<string, Set<string>>();
  for (const f of FAMILIES) {
    const tokens = new Set<string>();
    for (const [fid, rows] of corpora) {
      if (fid === f.id) continue;
      for (const r of rows) if (r.target) for (const w of wordify(r.phrase)) tokens.add(w);
    }
    rivalTokens.set(f.id, tokens);
  }

  const proposals: Proposal[] = [];
  for (const f of FAMILIES) {
    const rows = corpora.get(f.id);
    if (!rows) continue;
    const gaps = rows.filter(r => r.verdict === 'GAP').map(r => r.phrase);
    const stems = new Set<string>();
    const idioms = new Set<string>();
    let rawIdioms: string | undefined;
    const literals: string[] = [];
    const rivals = rivalTokens.get(f.id)!;

    for (const phrase of gaps) {
      literals.push(phrase);
      const words = wordify(phrase);
      // Negative-corpus exclusion at STEM level: a stripped stem must never
      // collide with a rival WORD (слободн vs слободен) — fold the stem back
      // onto every rival token via prefix/containment, not just equality.
      const rivalCollision = (s: string) => {
        for (const rw of rivals) {
          if (rw.length >= 4 && (rw.startsWith(s) || s.startsWith(rw) || rw.includes(s) || s.includes(rw))) return true;
        }
        return false;
      };
      // Dangerous greedy gates: NO open stems (a bare "слободн"/"деа" stem
      // one spelling-drift away from a rival family is how 00:09-class bugs
      // are born). Idioms + literals cover their gaps completely anyway.
      const DANGEROUS = new Set(['agreement-yes', 'offtopic', 'vague-time', 'exhausted']);
      for (const w of words) {
        const s = stemOf(w);
        if (!s || rivals.has(w) || rivalCollision(s)) continue;
        if (DANGEROUS.has(f.id)) continue;
        stems.add(s);
      }
      // Multiword idioms: 2-3 consecutive distinctive words (consent classes).
      for (let n = 2; n <= Math.min(3, words.length); n++) {
        for (let i = 0; i + n <= words.length; i++) {
          const gram = words.slice(i, i + n);
          if (gram.every(w => !STOP.has(w) && w.length >= 3 && !rivals.has(w))) idioms.add(gram.join(' '));
        }
      }
    }

    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const excludeSrcs = new Set<string>();
    // Dangerous-family guards: explicit exclusion vocabulary.
    if (f.id === 'agreement-yes') excludeSrcs.add('каде|kade|колку|kolku|cena|цена|sloboden|слободен|spalni|спални|kuc[aа]|куќа|lokacij|локациј');
    if (f.id === 'offtopic') excludeSrcs.add('стан|stan|куќ|kuc|имот|imot|цена|cena|посета|poseta|кириј|kirij|куп|kup|најм|najm|простор|prostor|агенци|agenci|документ|dokument|кредит|kredit|провизи|provizi');
    if (f.id === 'vague-time') excludeSrcs.add('\\d{1,2}[.:]\\d{2}|понеделник|pobnedelnik|vtornik|вторник|sreda|среда|četvrtok|четврток|petok|петок|sabota|сабота|nedela|недела|\\d+\\s*(?:cas|час)');
    if (f.id === 'exhausted') excludeSrcs.add('poeftin|поевтин|popust|попуст|drug_pat|друг\\s+пат');
    const excludes = [...excludeSrcs];

    // Validation mirrors the emitted detector: every alternative gets unicode
    // word-boundary anchoring — a short literal like "деа" must never
    // substring-match inside "идеален".
    const bound = (alt: string) => `(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`;
    const all = [
      ...stems,
      ...idioms,
      ...literals.map(l => normalizeMc(l.toLowerCase())),
    ];
    const extRe = (all.length || rawIdioms) ? new RegExp([...all.map(a => bound(esc(a))), ...(rawIdioms ? [bound(rawIdioms)] : [])].join('|'), 'iu') : null;
    const exclRe = excludes.length ? new RegExp(excludes.join('|'), 'iu') : null;
    const fires = (p: string) => {
      if (!extRe) return false;
      const n = normalizeMc(p.toLowerCase());
      if (exclRe?.test(n)) return false;
      return extRe.test(n);
    };
    const fixedGaps = gaps.filter(fires).length;
    const stillGap = gaps.filter(p => !fires(p));

    // Hand-written override: owner-contact needs BOTH sides (owner noun +
    // channel/verb) in a window — generic stems (контакт/број/надлезн) hijack
    // escalation and the contact-order flow.
    if (f.id === 'owner-contact') {
      const OC_IDIOMS = [
        '(?:сопственик|власник|газда)[^.!?\\n]{0,24}(?:број|телефон|контакт|јавам|јави|звонам)',
        '(?:број|телефон|контакт)[^.!?\\n]{0,24}(?:сопственик|власник|газда)',
        '(?:разгова|зборува|звонам|контактирам|директн)[^.!?\\n]{0,18}(?:сопственик|власник|газда)',
        '(?:без|покрај|освен)[^.!?\\n]{0,10}(?:агент|посредник|посредно)',
      ].join('|');
      stems.clear(); idioms.clear(); rawIdioms = OC_IDIOMS;
    }

    proposals.push({
      id: f.id,
      stems: [...stems], idioms: [...idioms], literals, excludes, rawIdioms,
      fixed: fixedGaps, stillGap: stillGap,
    });
  }
  return proposals;
}

function emitDetectorExt(proposals: Proposal[]): void {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bound = (alt: string) => `(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`;
  const lines: string[] = [];
  lines.push('// GENERATED by scripts/propose-stems.ts — grounded in data/hardening/*.json GAP corpora.', '');
  lines.push('// One extension entry per family: stems (typo-grounded, rival-collision-checked),');
  lines.push('// idioms (multiword), literals (whole GAP phrases as the completeness floor), and');
  lines.push('// exclude (rival-vocabulary veto). extFires() folds the input via normalizeMc');
  lines.push('// before testing — detectors just call extFires(familyId, text). Unicode');
  lines.push('// word-boundary anchored throughout. Do NOT hand-edit — re-run the script.');
  lines.push('');
  lines.push("import { normalizeMc } from './normalize';");
  lines.push('');
  lines.push('export interface FamilyExt { stems: RegExp | null; idioms: RegExp | null; literals: RegExp | null; exclude: RegExp | null; }');
  lines.push('');
  lines.push('export const FAMILY_EXT: Record<string, FamilyExt> = {');
  for (const p of proposals) {
    if (p.stems.length === 0 && p.literals.length === 0 && !p.rawIdioms) {
      lines.push(`  // ${p.id}: no GAPs — no extension needed`);
      continue;
    }
    const stemSrc = p.stems.map(s => bound(esc(s))).join('|');
    const idiomSrc = p.rawIdioms ? bound(p.rawIdioms) : p.idioms.map(s => bound(esc(s))).join('|');
    const litSrc = p.literals.map(l => bound(esc(normalizeMc(l.toLowerCase())))).join('|');
    lines.push(`  '${p.id}': {`);
    lines.push(`    stems: ${stemSrc ? `/(${stemSrc})/iu` : 'null'},`);
    lines.push(`    idioms: ${idiomSrc ? `/(${idiomSrc})/iu` : 'null'},`);
    lines.push(`    literals: ${litSrc ? `/(${litSrc})/iu` : 'null'},`);
    lines.push(`    exclude: ${p.excludes.length ? `/${p.excludes.join('|')}/iu` : 'null'},`);
    lines.push('  },');
  }
  lines.push('};');
  lines.push('');
  lines.push('/** Fold the input, veto on the family\'s exclusion vocabulary, then test all');
  lines.push(' *  extension classes. The ONLY sanctioned entry point — detectors must not');
  lines.push(' *  hand-roll their own folding of these regexes. */');
  lines.push('export function extFires(familyId: string, text: string): boolean {');
  lines.push('  const ext = FAMILY_EXT[familyId];');
  lines.push('  if (!ext) return false;');
  lines.push('  const n = normalizeMc(text.toLowerCase());');
  lines.push('  if (ext.exclude?.test(n)) return false;');
  lines.push('  return (ext.stems?.test(n) ?? false) || (ext.idioms?.test(n) ?? false) || (ext.literals?.test(n) ?? false);');
  lines.push('}');
  fs.writeFileSync('src/llm/detectorExt.ts', lines.join('\n') + '\n');
}

function main(): void {
  const corpora = loadCorpora();
  const proposals = propose(corpora);
  const emit = process.argv.includes('--emit');
  if (emit) emitDetectorExt(proposals);

  console.log('FAMILY               STEMS IDIOMS LITS  FIXES STILL-GAP');
  let tFix = 0, tGap = 0;
  for (const p of proposals.sort((a, b) => b.stillGap.length - a.stillGap.length)) {
    tFix += p.fixed; tGap += p.stillGap.length;
    console.log(`${p.id.padEnd(20)} ${String(p.stems.length).padStart(5)} ${String(p.idioms.length).padStart(6)} ${String(p.literals.length).padStart(4)} ${String(p.fixed).padStart(5)} ${String(p.stillGap.length).padStart(9)}`);
    for (const g of p.stillGap.slice(0, 4)) console.log(`    UNRESOLVED "${g}"`);
  }
  console.log(`\nTotal: ${tFix} gaps fixable by proposal, ${tGap} need hand-tuning`);
  if (emit) console.log('Emitted src/llm/detectorExt.ts — review, then wire into deterministic.ts');
}

main();
