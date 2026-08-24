import { loadConfig } from '../src/config';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { Db } from '../src/store/db';
import { LandmarkService } from '../src/geo/landmarks';

(async () => {
  const cfg = loadConfig();
  console.log('googleEnabled:', cfg.googleMapsEnabled);
  console.log('osmEnabled:', cfg.osmEnabled);
  console.log();

  const db = new Db(cfg.dbPath);
  const offlineMap = new OfflineMapStore(cfg.skopjePoisDb);

  // Clear ALL caches so we get fresh resolution
  db.db.prepare('UPDATE landmarks SET nearby = NULL WHERE nearby IS NOT NULL').run();
  db.db.prepare("DELETE FROM landmarks WHERE source = 'hermes'").run();

  const lm = new LandmarkService(db, {
    googleKey: cfg.googleMapsApiKey,
    googleEnabled: cfg.googleMapsEnabled,
    osmEnabled: cfg.osmEnabled,
    offlineMap,
  });

  const tests = [
    { eb: 78, address: 'Народен Фронт 23', location: 'Капиштец' },
    { eb: 89, address: 'Бул. АСНОМ Бр.134', location: 'Аеродром' },
    { eb: 76, address: 'Црвена Вода', location: 'Центар' },
    { eb: 63, address: 'Црногорска Амбасада', location: 'Центар (населба)' },
    { eb: 87, address: 'Асном 156', location: 'Ново Лисиче' },
    { eb: 55, address: 'Мраморец 12а', location: 'Влае' },
    { eb: 53, address: 'Јане Сандански', location: 'Аеродром' },
  ];

  for (const p of tests) {
    const prop = { eb: p.eb, address: p.address, location: p.location };

    const result = await lm.resolve(prop);
    console.log('EB ' + p.eb + ' [' + p.location + ']');
    console.log('  resolve: ' + result.landmark + ' [' + result.source + ']');

    const nearby = lm.nearbyLandmarks(prop);
    console.log('  nearby:  ' + nearby.map(n => n.landmark).join(' → '));
    console.log();
  }

  db.close();
  offlineMap.close();
})();
