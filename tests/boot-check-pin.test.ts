// THE PIN DRIFT SHOWS UP IN THE PANEL, NOT ONLY IN A SCRIPT (2026-11-23).
//
// The audit existed and the card guard dropped the guilty landmark line, but the
// only way to SEE the drift was for someone to remember `npm run
// audit:pin-location`. `/status` and the boot check now run the same ruler
// (src/feed/pinAudit.ts) over the live feed, so a row that sits in another
// quarter is loud before a client hears about a mall 3 km away.
//
// What is pinned: the check appears with the map, reads the edge function's OWN
// column names (evidenten_broj/naselba/adresa/opis — not the Property field
// names), names the offending EB, and is NON-critical (a drifted pin degrades an
// answer; it must never abort the boot).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { writeMap, OfflineMapStore } from '../src/geo/offlineMap';
import { checkFeed } from '../src/boot_check';

function buildMap(): OfflineMapStore {
  const dbPath = path.join(os.tmpdir(), `lina-boot-pin-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [
    { name: 'Пајко Маало', type: 'suburb', lat: 41.9977663, lon: 21.4365615 },
    { name: 'Ново Лисиче', type: 'suburb', lat: 41.9840, lon: 21.4700 },
  ], []);
  return new OfflineMapStore(dbPath);
}

/** The edge function's public row shape, verbatim. */
function feedResponse(): Response {
  const properties = [
    // EB 85 as the feed carried it on 2026-11-22: Ново Лисиче, pin beside the
    // town-centre mall.
    { evidenten_broj: '85', naselba: 'Ново Лисиче', adresa: 'Кај Бранка', opis: '', lat: 41.9993, lon: 21.44 },
    // A flat at home in its own naselba — the check must not cry wolf.
    { evidenten_broj: '91', naselba: 'Ново Лисиче', adresa: 'ул. 91', opis: '', lat: 41.9842, lon: 21.4702 },
  ];
  return new Response(JSON.stringify({ properties }), { status: 200 });
}

test('the boot/status feed check reports the drifted pin by number', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async () => feedResponse()) as typeof fetch;

  const checks = await checkFeed('https://example.invalid/feed', buildMap());
  const pin = checks.find(c => c.name === 'feed:pin');
  assert.ok(pin, `the pin check is part of the feed check: ${JSON.stringify(checks.map(c => c.name))}`);
  assert.equal(pin!.ok, false, `drift is reported: ${pin!.detail}`);
  assert.match(pin!.detail, /EB 85/u, 'the operator gets the number to repair');
  assert.doesNotMatch(pin!.detail, /EB 91/u, 'and a healthy row is not named');
  assert.equal(pin!.critical, false, 'a drifted pin degrades an answer, it does not stop the appliance');
});

test('a clean feed passes the pin check, and a missing map simply omits it', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async () => new Response(JSON.stringify({
    properties: [{ evidenten_broj: '91', naselba: 'Ново Лисиче', adresa: 'ул. 91', opis: '', lat: 41.9842, lon: 21.4702 }],
  }), { status: 200 })) as typeof fetch;

  const withMap = await checkFeed('https://example.invalid/feed', buildMap());
  const pin = withMap.find(c => c.name === 'feed:pin');
  assert.equal(pin?.ok, true, `a clean feed passes: ${pin?.detail}`);
  assert.match(pin!.detail, /no contradiction/u, 'and says so in words, not just a tick');

  const withoutMap = await checkFeed('https://example.invalid/feed');
  assert.deepEqual(withoutMap.map(c => c.name), ['feed'],
    'without the map there is nothing to measure against — the check is omitted, never a false ✅');
});
