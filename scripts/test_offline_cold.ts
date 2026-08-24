import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LandmarkService } from '../src/geo/landmarks';

(async () => {
  const cfg = loadConfig();
  const db = new Db(cfg.dbPath);
  const offlineMap = new OfflineMapStore(cfg.skopjePoisDb);

  // Clear ALL cached entries
  db.db.prepare('DELETE FROM landmarks').run();
  console.log('Cleared ALL landmark cache entries\n');

  const lm = new LandmarkService(db, {
    googleKey: cfg.googleMapsApiKey,
    googleEnabled: false,
    osmEnabled: false,
    offlineMap,
  });

  const tests = [
    { eb: 78, address: 'Народен Фронт 23', location: 'Капиштец' },
    { eb: 89, address: 'Бул. АСНОМ Бр.134', location: 'Аеродром' },
    { eb: 76, address: 'Црвена Вода', location: 'Центар' },
    { eb: 63, address: 'Црногорска Амбасада', location: 'Центар (населба)' },
    { eb: 87, address: 'Асном 156', location: 'Ново Лисиче' },
    { eb: 53, address: 'Јане Сандански', location: 'Аеродром' },
    { eb: 55, address: 'Мраморец 12а', location: 'Влае' },
    { eb: 59, address: 'Рузвелтова 51', location: 'Центар (населба)' },
    { eb: 79, address: 'Владимир Назор', location: 'Водно' },
  ];

  for (const p of tests) {
    const prop = { eb: p.eb, address: p.address, location: p.location };
    const result = await lm.resolve(prop);
    const nearby = lm.nearbyLandmarks(prop);
    console.log(`EB ${p.eb} [${p.location}]`);
    console.log(`  resolve: ${result.landmark} [${result.source}]`);
    console.log(`  nearby:  ${nearby.map(n => n.landmark).join(' → ') || '(empty)'}`);
    console.log();
  }

  db.close();
  offlineMap.close();
})();
