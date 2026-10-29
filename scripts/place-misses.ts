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
// Usage: npx tsx scripts/place-misses.ts [--days 7] [--top 25]

import { readPlaceMisses } from '../src/store/placeMisses';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const days = Number(args[args.indexOf('--days') + 1]) || 7;
  const top = Number(args[args.indexOf('--top') + 1]) || 25;

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

  console.log(`place misses, last ${days} day(s): ${misses.length} rows, ${groups.size} distinct\n`);
  for (const [text, g] of rows) {
    const verdict = g.refused.length ? `refused row: ${g.refused.join(', ')}` : 'no such place on the map';
    console.log(`  ${String(g.n).padStart(3)}×  «${text}»  — ${verdict}`);
  }
  const noRow = [...groups.values()].filter(g => g.refused.length === 0).length;
  console.log(`\n${noRow} distinct name(s) the map does not hold; ${groups.size - noRow} were found and refused.`);
}

main();
