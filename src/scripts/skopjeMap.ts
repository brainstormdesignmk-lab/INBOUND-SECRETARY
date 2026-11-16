// skopje-map — RETIRED. This used to `npm run map:pull`.
//
// WHY IT REFUSES NOW (2026-11-16). It called buildSkopjeDb(cfg.skopjePoisDb) —
// and cfg.skopjePoisDb is the AUTHORITATIVE map path on every host that reads
// it. That build restores OSM rows ONLY: no Google layer (ratings, phones,
// place ids, place_url), no manual overrides, no identity healing, no ledger.
// So running it did not "refresh" the map, it REPLACED the finished artifact
// with a strictly worse one, at the same path, silently — and it was documented
// as the remedy for a missing map (`boot_check`), which made it a one-command
// way to lose the city's malls and the place cards.
//
// The map is an artifact of ONE repo: maps-realestate. It is built by its
// monthly pass (`npm run refresh`), committed to git, and shipped to readers as
// a copy. The right answers here are:
//
//   get the map:      git -C <maps-realestate> pull
//                     npx tsx <maps-realestate>/scripts/map-verify.ts --stamp  (optional)
//   prove it:         npm run map:verify            # in maps-realestate
//   point a bot at it: SKOPJE_POIS_DB=<maps-realestate>/data/skopje-pois.db
//
// If a machine genuinely needs an OSM-only bootstrap map, that is a deliberate
// action with a DIFFERENT output path, run from the maps repo — never a
// command that overwrites the authority in place.

console.error(
  '[skopje-map] REFUSED — `npm run map:pull` is retired.\n'
  + '  It rebuilt the map from OSM ONLY (no Google layer, no overrides, no\n'
  + '  identity healing) and wrote it over whatever SKOPJE_POIS_DB names, so it\n'
  + '  could destroy the authoritative map in one command.\n'
  + '\n'
  + '  The map is built and shipped by the maps-realestate repo:\n'
  + '    1. there:  npm run refresh        (the monthly pass — the ONLY builder)\n'
  + '    2. there:  npm run map:verify     (prove which map you are holding)\n'
  + '    3. here:   SKOPJE_POIS_DB=<maps-realestate>/data/skopje-pois.db\n'
  + '  A reader never builds a map; it reads the one that was verified.',
);
process.exit(1);
