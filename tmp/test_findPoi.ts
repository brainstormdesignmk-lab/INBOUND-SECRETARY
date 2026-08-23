import { OfflineMapStore } from '../src/geo/offlineMap';
const store = new OfflineMapStore('data/skopje-pois.db');
console.log('available:', store.available);
console.log('findPoiByName Бисер:', JSON.stringify(store.findPoiByName('Бисер')));
console.log('findPoiByName ТЦ Бисер:', JSON.stringify(store.findPoiByName('ТЦ Бисер')));
console.log('findPoiByName Капитол:', JSON.stringify(store.findPoiByName('Капитол')));
console.log('findPoiByName Парк Авионче:', JSON.stringify(store.findPoiByName('Парк Авионче')));
