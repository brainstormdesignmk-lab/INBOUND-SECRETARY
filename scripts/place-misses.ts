// WEEKLY PLACE-MISS DIGEST — what the clients named that the map could not place.
//
// Reads data/place-misses-YYYY-MM-DD.jsonl (written by
// src/store/placeMisses.ts from the chat path, never blocking it) and groups
// the words so a human can decide what to add:
//   • «no such place»  — the map has no row; add an override (address-overrides)
//     or a colloquial alias (LOCAL_PLACE_ALIASES) when it is a real place;
//   • «refused»        — the map HAS a row and the coverage guard discarded it;
//     that is either a sound-key gap (fix the fold) or a correct refusal
//     (the client said something ambiguous — leave it).
//
// THE SUGGESTIONS (why they exist): a miss used to be a dead end — the digest
// named the words and stopped there, so the alias was written only after
// somebody happened to read the list. Each group now carries the map's own
// answer: either the name ALREADY resolves (a bridge or alias landed since the
// row was logged — nothing to do), or the likeliest row to point at, plus a
// paste-ready alias line. That is the difference between «200 misses» and
// «three names, here is the row each one means».
//
// Usage: npx tsx scripts/place-misses.ts [--days 7] [--top 25] [--no-suggest]

import { loadConfig } from '../src/config';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { readPlaceMisses } from '../src/store/placeMisses';

/** The map's best answer for a name that missed: what it resolves to NOW, or
 *  the rows a human would most likely point the alias at (one-slip recovery
 *  first, then the name fragments). Empty when nothing plausible exists — an
 *  honest «no such place» is a valid outcome, not a failure of this tool. */
function suggest(text: string, map?: OfflineMapStore): string[] {
  if (!map?.available) return [];
  const out: string[] = [];
  try {
    const now = map.findPoiByName(text);
    if (now) return [`resolves now → ${now.name}  (a bridge/alias covers it; no action needed)`];
  } catch { /* a suggestion may never break the digest */ }
  try {
    const loose = map.findPoiByNameLoose(text);
    if (loose) out.push(`map row (one slip away) → ${loose.name}`);
  } catch { /* ignore */ }
  try {
    for (const r of map.findPoisByName(text, 3) ?? []) {
      if (!out.some(l => l.includes(r.name))) out.push(`map row → ${r.name}`);
    }
  } catch { /* ignore */ }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const days = Number(args[args.indexOf('--days') + 1]) || 7;
  const top = Number(args[args.indexOf('--top') + 1]) || 25;
  const withSuggestions = !args.includes('--no-suggest');

  const misses = await readPlaceMisses({ days });
  if (misses.length === 0) {
    console.log(`No place misses in the last ${days} day(s).`);
    return;
  }
  const groups = new Map<string, { n: number; refused: string[] }>();
  for (const m of misses) {
    const key = m.text.toLowerCase();
    const g = groups.get(key) ?? { n: 0, refused: [] };
    g.n++;
    if (m.refused && g.refused.length < 3 && !g.refused.includes(m.refused)) g.refused.push(m.refused);
    groups.set(key, g);
  }
  const rows = [...groups.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, top);

  let map: OfflineMapStore | undefined;
  if (withSuggestions) {
    try { map = new OfflineMapStore(loadConfig().skopjePoisDb); } catch { map = undefined; }
  }

  console.log(`place misses, last ${days} day(s): ${misses.length} rows, ${groups.size} distinct\n`);
  let unresolved = 0;
  for (const [text, g] of rows) {
    const verdict = g.refused.length ? `refused row: ${g.refused.join(', ')}` : 'no such place on the map';
    console.log(`  ${String(g.n).padStart(3)}×  «${text}»  — ${verdict}`);
    if (g.refused.length === 0) unresolved++;
    for (const s of suggest(text, map)) console.log(`       ↳ ${s}`);
  }
  const noRow = [...groups.values()].filter(g => g.refused.length === 0).length;
  console.log(`\n${noRow} distinct name(s) the map does not hold; ${groups.size - noRow} were found and refused.`);
  if (withSuggestions && noRow > 0) {
    const patch = rows
      .filter(([, g]) => g.refused.length === 0)
      .map(([text]) => {
        // ONLY a real candidate row becomes a paste line — a «resolves now»
        // group needs no alias at all (its bridge already landed).
        const hit = suggest(text, map).find(l => l.startsWith('map row'));
        const row = hit?.split('→ ')[1]?.trim();
        if (!row) return '';
        return `  [/${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/iu, '${row}'],`;
      })
      .filter(Boolean);
    if (patch.length) {
      console.log('\nready to paste into LOCAL_PLACE_ALIASES (src/geo/offlineMap.ts):');
      for (const line of patch) console.log(line);
    }
  }
  if (unresolved > 0 && !withSuggestions) {
    console.log('\n(run without --no-suggest to see the map rows each miss most resembles)');
  }
}

main();
