# Feed corrections needed (agency side)

Produced by `npx tsx scripts/audit_addresses.ts`. These addresses cannot be
fixed by the map — the FEED itself carries garbage or colloquial names.
Fix them in Supabase; until then Lina answers these properties at
neighborhood precision only.

## GARBAGE — placeholder text, no address exists (4)

| EB | feed address | location | what the client hears |
|----|--------------|----------|----------------------|
| 58 | „Непозната" | Центар (населба) | neighborhood-level answer only |
| 56 | „Непозната" | Центар | neighborhood-level answer only |
| 40 | „Хфгхфгх" | Кисела Вода | keyboard mash — no resolution possible |
| 39 | „Фгхфгхфгхфгх" | — | keyboard mash, no location either |

**Action:** ask the agent who imported these for the real street + number.

## STREET_MISSING — colloquial names, real place unknown to the map (2)

| EB | feed address | location | note |
|----|--------------|----------|------|
| 85 | „Кај Бранка" | Ново Лисиче | person/place nickname — needs the actual street |
| 41 | „Ѓорче Кај Пазарчето" | Ѓорче Петров | "near the little market" — needs street+number |

**Action:** these DO partially resolve (POI-name lookup / neighborhood table),
but precision is block-level at best. One real address each closes the audit
at 100%.

## How to close this list

1. Correct `address` in Supabase for the EBs above.
2. Re-run: `npx tsx scripts/audit_addresses.ts`
3. Target: GARBAGE 0 · STREET_MISSING 0.

New imports should be audited at ingestion time so garbage never reaches a
client conversation silently.
