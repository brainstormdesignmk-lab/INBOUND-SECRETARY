// Deterministic approximate-location table — the ZERO-cost base layer of the
// landmark resolver. Keyed by Skopje neighborhood (as the feed's `naselba`
// names them, e.g. "Карпош III"); each entry lists REAL public landmarks that
// a human agent would name ("во близина на …"). NEVER stores exact addresses.
//
// This layer works offline, in the LLM-free state, with no keys and no network
// — the live layers (Google/OSM, and Hermes later) only add precision for
// addresses the table doesn't cover. The pick is deterministic per property
// (hash of the EB), so two properties in the same neighborhood get DIFFERENT
// landmarks — like a human would vary the answer, never one fixed sentence.

export interface TableLandmark {
  landmark: string;
  type: string;
}

/** Neighborhood key (normalized, lowercase) -> candidate landmarks. */
export const NEIGHBORHOOD_LANDMARKS: Record<string, TableLandmark[]> = {
  'центар': [
    { landmark: 'Плоштад „Македонија“', type: 'square' },
    { landmark: 'Градскиот трговски центар (ГТЦ)', type: 'mall' },
    { landmark: 'Градската болница', type: 'hospital' },
    { landmark: 'Хотел „Парк“', type: 'hotel' },
    { landmark: 'Македонската опера и балет', type: 'culture' },
    { landmark: 'Универзална сала', type: 'culture' },
  ],
  'карпош': [
    { landmark: 'Градежниот факултет', type: 'university' },
    { landmark: 'City Mall', type: 'mall' },
    { landmark: 'Македонската опера и балет', type: 'culture' },
    { landmark: 'Хотел „Карпош“', type: 'hotel' },
  ],
  'аеродром': [
    { landmark: 'Трговскиот центар „Веро Центар“', type: 'mall' },
    { landmark: 'Паркот Аеродром', type: 'park' },
    { landmark: 'Автобуската станица на Аеродром', type: 'transit' },
  ],
  'кисела вода': [
    { landmark: 'Стадионот „Борис Трајковски“', type: 'stadium' },
    { landmark: 'Клиничкиот центар', type: 'hospital' },
    { landmark: 'Паркот „Жена Борец“', type: 'park' },
    { landmark: 'ОУ „Блаже Конески“', type: 'school' },
  ],
  'чаир': [
    { landmark: 'Старата скопска чаршија', type: 'culture' },
    { landmark: 'Бања Баши џамија', type: 'culture' },
  ],
  'бит пазар': [
    { landmark: 'Старата скопска чаршија', type: 'culture' },
    { landmark: 'Камен мост', type: 'culture' },
  ],
  'гази баба': [
    { landmark: 'Скопскиот саем', type: 'fair' },
    { landmark: 'Автобуската станица', type: 'transit' },
  ],
  'ѓорче петров': [
    { landmark: 'Железничката станица Ѓорче Петров', type: 'transit' },
  ],
  'бутел': [
    { landmark: 'Градскиот парк', type: 'park' },
    { landmark: 'Зоолошката градина', type: 'park' },
  ],
  'центар (населба)': [
    { landmark: 'Градскиот трговски центар (ГТЦ)', type: 'mall' },
    { landmark: 'Градската болница', type: 'hospital' },
    { landmark: 'Хотел „Парк“', type: 'hotel' },
    { landmark: 'Плоштад „Македонија“', type: 'square' },
  ],
};

/** Normalize a feed/query location for table matching: lowercase, latin ->
 *  cyrillic, parentheses and extra spaces stripped. "Карпош III" -> "карпош iii". */
export function normalizeLocationKey(s: string): string {
  const MK_LAT2CYR: Array<[string, string]> = [
    ['lj', 'љ'], ['nj', 'њ'], ['dj', 'ѓ'], ['gj', 'ѓ'], ['kj', 'ќ'],
    ['zh', 'ж'], ['ch', 'ч'], ['dz', 'џ'], ['sh', 'ш'],
    ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'], ['e', 'е'],
    ['z', 'з'], ['i', 'и'], ['j', 'ј'], ['k', 'к'], ['l', 'л'], ['m', 'м'],
    ['n', 'н'], ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'],
    ['u', 'у'], ['f', 'ф'], ['h', 'х'], ['c', 'ц'], ['y', 'ј'],
    ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'], ['e', 'е'],
    ['z', 'з'], ['i', 'и'], ['j', 'ј'], ['k', 'к'], ['l', 'л'], ['m', 'м'],
    ['n', 'н'], ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'],
    ['u', 'у'], ['f', 'ф'], ['h', 'х'], ['c', 'ц'], ['y', 'ј'],
  ];
  const low = s.toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  let out = '';
  let i = 0;
  while (i < low.length) {
    const pair = low.slice(i, i + 2);
    const hit = MK_LAT2CYR.find(([k]) => k === pair);
    if (hit) { out += hit[1]; i += 2; continue; }
    out += low[i];
    i += 1;
  }
  return out;
}

/** The neighborhood a location belongs to (longest key wins: \"Карпош III\"
 *  matches карпош; \"Кисела Вода\" matches the two-word key exactly). */
export function tableNeighborhood(location: string): string | undefined {
  const key = normalizeLocationKey(location);
  const keys = Object.keys(NEIGHBORHOOD_LANDMARKS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (k.length >= 3 && (key === k || key.startsWith(`${k} `) || key.startsWith(`${k} -`))) return k;
    // A short table key must not collide with a longer neighborhood name.
    if (key === k) return k;
  }
  return undefined;
}

/** Deterministic landmark for a property (same EB always gets the same one). */
export function tableLandmark(eb: number, location: string): TableLandmark | undefined {
  const nb = tableNeighborhood(location);
  if (!nb) return undefined;
  const opts = NEIGHBORHOOD_LANDMARKS[nb];
  return opts[Math.abs(eb * 2654435761) % opts.length];
}
