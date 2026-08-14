// Offline property fixture so the simulator and tests are deterministic
// (no dependence on the Supabase endpoint).
import { Property } from '../data/properties';

export const FIXTURE_PROPERTIES = [
  { id: 1,  title: 'Двособен стан, Карпош 2', location: 'Карпош',   bedrooms: 2, service: 'buy',  price: '78.000 €',    area: '62 м²', floor: '3/5' },
  { id: 2,  title: 'Трособен стан, Аеродром', location: 'Аеродром', bedrooms: 3, service: 'buy',  price: '115.000 €',   area: '85 м²', floor: '5/7' },
  { id: 3,  title: 'Еднособен стан, Центар',  location: 'Центар',   bedrooms: 1, service: 'buy',  price: '55.000 €',    area: '38 м²', floor: '2/4' },
  { id: 4,  title: 'Двособен стан, Центар',   location: 'Центар',   bedrooms: 2, service: 'buy',  price: '89.000 €',    area: '60 м²', floor: '4/6' },
  { id: 5,  title: 'Еднособен стан, Аеродром', location: 'Аеродром', bedrooms: 1, service: 'rent', price: '280 €/мес',   area: '35 м²', floor: '1/4' },
  { id: 6,  title: 'Двособен стан, Карпош',   location: 'Карпош',   bedrooms: 2, service: 'rent', price: '320 €/мес',   area: '58 м²', floor: '2/5' },
  { id: 7,  title: 'Двособен стан, Центар',   location: 'Центар',   bedrooms: 2, service: 'rent', price: '350 €/мес',   area: '61 м²', floor: '6/8' },
  { id: 8,  title: 'Двособен стан, Карпош 4', location: 'Карпош',   bedrooms: 2, service: 'buy',  price: '82.000 €',    area: '64 м²', floor: '4/6' },
  { id: 9,  title: 'Двособен стан, Центар 2', location: 'Центар',   bedrooms: 2, service: 'buy',  price: '92.000 €',    area: '63 м²', floor: '5/7' },
] as unknown as Property[];

export function fakePropertyService() {
  return {
    healthy: true,
    async getById(id: number | undefined) {
      return FIXTURE_PROPERTIES.find(p => p.id === id);
    },
    async search(f: { location?: string; bedrooms?: number; service?: string }) {
      return FIXTURE_PROPERTIES.filter(p =>
        (!f.service || p.service === f.service) &&
        (!f.location || String(p.location).toLowerCase().includes(f.location.toLowerCase())) &&
        (!f.bedrooms || Number(p.bedrooms) >= f.bedrooms)
      );
    },
    async locations() {
      const set = new Set<string>();
      for (const p of FIXTURE_PROPERTIES) {
        if (p.location) set.add(String(p.location));
      }
      return [...set];
    },
  } as unknown as import('../data/properties').PropertyService;
}
