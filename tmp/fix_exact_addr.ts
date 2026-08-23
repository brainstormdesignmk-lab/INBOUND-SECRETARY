const fs = require('fs');
const file = 'src/llm/deterministic.ts';
let src = fs.readFileSync(file, 'utf8');
const lines = src.split('\n');

// Find EXACT_ADDRESS_RE line
let exactIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('const EXACT_ADDRESS_RE')) {
    exactIdx = i + 1; // regex is on next line
    break;
  }
}

if (exactIdx === -1) {
  console.log('ERROR: EXACT_ADDRESS_RE not found');
  process.exit(1);
}

// Original regex from git (verified working)
const original = `  /(?:потoчно|точно|поточно|tocno|potocno|pokazete|покажете|која|koja|којашто|kojа)\\s+(?:е\\s+|да\\s+е\\s+)?(?:точната|точн|tocnata|tocna)?\\s*(?:адреса|adresa|улица|ulica|локацијата|lokacijata|локација|lokacija)|(?:на\\s+која|na\\s+koja)\\s+(?:адреса|adresa|улица|ulica)|(?:адресата|adresata|улицата|ulicata|локацијата|lokacijata)\\s+(?:ќе|ke|да)\\s+(?:ја\\s+)?(?:доби|dobij|знам|znam|кажи|kazi)|кажи\\s+(?:ми\\s+)?(?:ја\\s+)?(?:адресата|adresata|улицата|ulicata|точно|tocno|каде\\s+точно)|точно\\s+(?:каде|kade)\\s+(?:е|e)|каде\\s+точно|kade\\s+tocno|kade\\s+tochno|(?:каде|kade)\\s+(?:е\\s+|e\\s+)?(?:точната|tocnata|точна|tocna|прецизната|preciznata)\\s*(?:адреса|adresa|улица|ulica|локација|lokacija)|(?:moram|mora|treba|морам|мора|треба|сакам|sakam)\\s+(?:(?:да|da)\\s+)?(?:знам|znam)\\s+(?:каде|kade)\\s+(?:е|e|се\\s+нао[гѓ]а|se\\s+naogja|се|se)|(?:морам|мора|moram|mora|треба|treba)\\s+(?:(?:да|da)\\s+)?(?:знам|znam)\\s+(?:каде|kade)\\s+е|za\\s+da\\s+se\\s+odlu(?:cam|čam)|за\\s+да\\s+се\\s+одлу(?:чам|кам)/iu;`;

// Apply MINIMAL additions:
let fixed = original;

// 1. Add tochno to first group
fixed = fixed.replace(
  '(?:потoчно|точно|поточно|tocno|potocno',
  '(?:потoчно|точно|поточно|tocno|tochno|potocno'
);

// 2. Add tochnata/tochna to adjective group  
fixed = fixed.replace(
  '(?:точната|точн|tocnata|tocna)',
  '(?:точната|точн|tocnata|tocna|tochnata|tochna)'
);

// 3. Add tochno to exactly-where patterns
fixed = fixed.replace(
  'точно\\s+(?:каде|kade)',
  '(?:точно|tochno)\\s+(?:каде|kade)'
);
fixed = fixed.replace(
  'каде\\s+точно',
  'каде\\s+(?:точно|tochno)'
);

// 4. Add tochnata/tochna to каде е точната patterns
fixed = fixed.replace(
  '(?:е\\s+|e\\s+)?(?:точната|tocnata|точна|tocna|прецизната|preciznata)',
  '(?:е\\s+|e\\s+)?(?:точната|tocnata|точна|tocна|tochnata|tochna|прецизната|preciznata)'
);

lines[exactIdx] = fixed;
src = lines.join('\n');
fs.writeFileSync(file, src, 'utf8');
console.log('Restored + fixed EXACT_ADDRESS_RE');
console.log('First 200:', fixed.substring(0, 200));
