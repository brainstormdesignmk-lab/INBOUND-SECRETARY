import { normalizeMc } from '../src/llm/normalize';
import { detectWhereIs, detectExactAddressAsk, detectDefer, detectNegotiate, detectSchedulingFlex, detectEscalation } from '../src/llm/deterministic';

let fail = 0;
function chk(cond: boolean, label: string) {
  if (!cond) { fail++; console.log('FAIL:', label); }
}

// Normalizer output spot checks
chk(normalizeMc('kade e imotot') === 'каде е имотот', `norm kade e imotot → ${normalizeMc('kade e imotot')}`);
chk(normalizeMc('naogja') === 'наоѓа', `norm naogja → ${normalizeMc('naogja')}`);
chk(normalizeMc('adresata?') === 'адресата?', `norm adresata? → ${normalizeMc('adresata?')}`);
chk(normalizeMc('EB 78') === 'еб 78', `norm EB 78 → ${normalizeMc('EB 78')}`);
chk(normalizeMc('lokacijata') === 'локацијата', `norm lokacijata → ${normalizeMc('lokacijata')}`);
chk(normalizeMc('shto ima vo blizina') === 'што има во близина', `norm shto... → ${normalizeMc('shto ima vo blizina')}`);

// Routing preserved — Latin inputs through the NEW normalized path
chk(detectWhereIs('kade mu e lokacijata ?')?.generic === true, 'whereIs: kade mu e lokacijata (latin)');
chk(detectWhereIs('kade mu e adresata')?.generic === true, 'whereIs: kade mu e adresata (latin)');
chk(detectWhereIs('Каде адресата?')?.generic === true, 'whereIs: Каде адресата?');
chk(detectExactAddressAsk('ulica i broj?') === true, 'exact: ulica i broj');
chk(!detectWhereIs('daj mi ja adresata'), 'no false whereIs: daj mi ja adresata');
chk(detectExactAddressAsk('moram da znam adresata') === true, 'exact: moram da znam');

// Grammar families still work in both scripts
chk(detectDefer('ke razmislam potoa') === true, 'defer latin');
chk(detectDefer('ќе размислам подоцна') === true, 'defer cyrillic');
chk(detectNegotiate('moze li pomala cena') === true, 'negotiate latin');
chk(detectNegotiate('може ли помала цена') === true, 'negotiate cyrillic');
chk(detectSchedulingFlex('samo popladne') === true, 'schedflex latin');
chk(detectSchedulingFlex('само попладне') === true, 'schedflex cyrillic');
chk(detectEscalation('sakam da zboruvam so menadzer') === true, 'escalation latin');
chk(detectEscalation('сакам да зборувам со менаџер') === true, 'escalation cyrillic');

// Place extraction NOT corrupted by normalization (stays raw-scripted)
const q = detectWhereIs('kade se naogja Ramstor?');
chk(q && !q.generic && q.place === 'Ramstor', `place extraction keeps raw script → ${JSON.stringify(q)}`);

console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
