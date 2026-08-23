import { classifyOffensive, normalize } from '../src/antiabuse/offensive.js';

const tests = ['PUSI KUR MA TAMU', 'ZEMI GO NA USTA', 'pusi kur', 'zemi go na usta', 'usta', 'zemi go'];
for (const t of tests) {
  const norm = normalize(t);
  const r = classifyOffensive(t);
  console.log(JSON.stringify({ input: t, normalized: norm, offensive: r.isOffensive, category: r.category, severity: r.severity, reason: r.reason }));
}
