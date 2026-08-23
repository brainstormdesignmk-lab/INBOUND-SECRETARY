const fs = require('fs');
const file = 'src/llm/deterministic.ts';
let src = fs.readFileSync(file, 'utf8');
const changes: string[] = [];

// ═══════════════════════════════════════════════════════════
// 1. WHERE_IS_RE: add dokade/докаде + pronouns (mu/go/ja/ti)
// ═══════════════════════════════════════════════════════════
const oldWhereIs = '(?:каде|kade|где|gde|where|кај|kaj)';
const newWhereIs = '(?:каде|kade|где|gde|where|кај|kaj|докаде|dokade)';
if (src.includes(oldWhereIs) && !src.includes(newWhereIs)) {
  src = src.replace(oldWhereIs, newWhereIs);
  changes.push('WHERE_IS_RE: added dokade/докаде');
}

// Add optional pronoun before verb
const oldWhereVerb = "(?:\\\\s+(?:да\\\\s+)?(?:(?:се|se)\\\\s+)?(?:наоѓа|naogja|naoga|е|e|се|se|is))";
// Actually the regex is in literal form, let me use the actual file content
const whereIsLine = src.match(/const WHERE_IS_RE = \/([\s\S]*?)\/iu;/);
if (whereIsLine) {
  const oldP = whereIsLine[1];
  // Add optional pronoun: (?:(?:му|го|ја|ти|mu|go|ja|ti)\s+)?
  if (!oldP.includes('mu|go|ja|ti')) {
    const newP = oldP.replace(
      /(\(\?:се\|se\)\\s\+\)\?)(\(\\?[\s\S]*?\)\??нао)/,
      '$1(?:(?:му|го|ја|ти|mu|go|ja|ti)\\s+)?$2'
    );
    if (newP !== oldP) {
      src = src.replace(oldP, newP);
      changes.push('WHERE_IS_RE: added pronoun alternatives');
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 2. WHERE_IS_GENERIC: add lokacijata/adresata/ulicata
// ═══════════════════════════════════════════════════════════
const oldGeneric = 'објект|objekt)$';
const newGeneric = 'објект|objekt|локацијата|lokacijata|локација|lokacija|адресата|adresata|адреса|adresa|улицата|ulicata|улица|ulica)$';
if (src.includes(oldGeneric) && !src.includes('lokacijata')) {
  src = src.replace(oldGeneric, newGeneric);
  changes.push('WHERE_IS_GENERIC: added lokacijata/adresata/ulicata');
}

// ═══════════════════════════════════════════════════════════
// 3. EB number detection in detectWhereIs
// ═══════════════════════════════════════════════════════════
if (!src.includes("ebRest.replace")) {
  const oldGuard = "  if (rest.length < 3) return undefined;\n  return { place: rest, generic: false };\n}";
  const newGuard = "  // EB number: \"каде се наоѓа 89?\" / \"каде е број 89\"\n  const ebRest = rest.replace(/(?:евидентен\\s+)?(?:број|broj|еб|eb)\\s*/iu, '').trim();\n  if (/^\\d{1,5}$/.test(ebRest)) return { place: ebRest, generic: false };\n  if (rest.length < 3) return undefined;\n  return { place: rest, generic: false };\n}";
  if (src.includes(oldGuard)) {
    src = src.replace(oldGuard, newGuard);
    changes.push('detectWhereIs: EB number detection + prefix stripping');
  }
}

// ═══════════════════════════════════════════════════════════
// 4. FEE_WHY_RE: add naplatuva variants to nikoj branch
// ═══════════════════════════════════════════════════════════
const oldFeeNikoj = 'ne naplakja|ne naplakjaat)';
const newFeeNikoj = 'ne naplakja|ne naplakjaat|не наплатува|не наплатуваат|ne naplatuva|ne naplatuvaat)';
if (src.includes(oldFeeNikoj) && !src.includes('ne naplatuva')) {
  src = src.replace(oldFeeNikoj, newFeeNikoj);
  changes.push('FEE_WHY_RE: added naplatuva variants');
}

// ═══════════════════════════════════════════════════════════
// 5. AVAILABILITY_ASK_RE: da+[il]+ typo tolerance
// ═══════════════════════════════════════════════════════════
if (!src.includes('da+[il]+')) {
  // Convert the old regex literal to string-based RegExp for adding new patterns
  // This is complex — for now, just add the daali pattern via the existing regex
  const oldDa = 'da[il][il]';
  const newDa = 'da+[il]+';
  if (src.includes(oldDa)) {
    src = src.replace(oldDa, newDa);
    changes.push('AVAILABILITY_ASK_RE: da[il][il] → da+[il]+ for typo tolerance');
  }
}

// ═══════════════════════════════════════════════════════════
// 6. LOCATION_FOLLOWUP_RE: new regex for persistent follow-ups
// ═══════════════════════════════════════════════════════════
if (!src.includes('LOCATION_FOLLOWUP_RE')) {
  const insertAfter = 'export function detectExactAddressAsk(text: string): boolean {';
  const newRegex = `
// Persistent location follow-ups: after a landmark answer, the client pushes
// back asking for the exact location/address. These get the privacy line.
const LOCATION_FOLLOWUP_RE =
  /(?:те|te)\\s+(?:праш(ав|ам)|pras(av|ам|am))\\s+(?:за|za)\\s+(?:локација|адреса|улица|lokacija|adresa|ulica)|(?:ова|ova)\\s+(?:е|e)\\s+(?:локација|адреса|lokacija|adresa)\\s+(?:на|na)|(?:точн|tochn)(?:ата|ata|а|а|о|о)\\s+(?:локација|адреса|lokacija|adresa)/iu;
`;
  src = src.replace(insertAfter, newRegex + insertAfter);
  changes.push('LOCATION_FOLLOWUP_RE: new regex for persistent follow-ups');
  
  // Update detectExactAddressAsk to use both regexes
  src = src.replace(
    'return EXACT_ADDRESS_RE.test(text);',
    'return EXACT_ADDRESS_RE.test(text) || LOCATION_FOLLOWUP_RE.test(text);'
  );
  changes.push('detectExactAddressAsk: added LOCATION_FOLLOWUP_RE check');
}

// ═══════════════════════════════════════════════════════════
// 7. EXACT_ADDRESS_RE: add Latin alternatives
// ═══════════════════════════════════════════════════════════
// Only modify if not already modified
if (!src.includes('tochno') && src.includes('EXACT_ADDRESS_RE')) {
  // Find the EXACT_ADDRESS_RE regex line
  const exactMatch = src.match(/const EXACT_ADDRESS_RE\s*=\s*\/([\s\S]*?)\/iu;/);
  if (exactMatch) {
    let pattern = exactMatch[1];
    let modified = false;
    
    // Add tochno to first group
    if (!pattern.includes('tochno')) {
      pattern = pattern.replace('(?:потoчно|точно|поточно|tocno|potocno', '(?:потoчно|точно|поточно|tocno|tochno|potocno');
      modified = true;
    }
    
    // Add tochnata/tochna to adjective group
    if (!pattern.includes('tochnata')) {
      pattern = pattern.replace('(?:точната|точн|tocnata|tocna)', '(?:точната|точн|tocnata|tocna|tochnata|tochna)');
      modified = true;
    }
    
    // Add tochno to exactly-where patterns
    if (!pattern.includes('tochno\\\\s')) {
      pattern = pattern.replace('точно\\\\s+(?:каде|kade)', '(?:точно|tochno)\\\\s+(?:каде|kade)');
      pattern = pattern.replace('каде\\\\s+точно', 'каде\\\\s+(?:точно|tochno)');
      modified = true;
    }
    
    // Add tochnata/tochna to каде е точната patterns
    if (!pattern.includes('tochnata|tochna|')) {
      pattern = pattern.replace(
        '(?:е\\\\s+|e\\\\s+)?(?:точната|tocnata|точна|tocna|прецизната|preciznata)',
        '(?:е\\\\s+|e\\\\s+)?(?:точната|tocnata|точна|tocna|tochnata|tochna|прецизната|preciznata)'
      );
      modified = true;
    }
    
    // Add tochna adresa pattern
    if (!pattern.includes('tochna)\\\\s+(?:адреса')) {
      pattern = pattern.replace(
        '(?:на\\\\s+која|na\\\\s+koja)',
        '(?:точна|tochna)\\\\s+(?:адреса|adresa)|(?:на\\\\s+која|na\\\\s+koja)'
      );
      modified = true;
    }
    
    // Add kazi alongside кажи in standalone pattern
    if (!pattern.includes('(?:кажи|kazi)\\\\s+(?:ми\\\\s+)?(?:jа|ja)')) {
      // Replace standalone кажи with (?:кажи|kazi)
      pattern = pattern.replace(
        'кажи\\\\s+(?:ми\\\\s+)?(?:jа\\\\s+)?(?:адресата',
        '(?:кажи|kazi)\\\\s+(?:ми\\\\s+)?(?:jа|ja)\\\\s+(?:адресата'
      );
      modified = true;
    }
    
    if (modified) {
      src = src.replace(exactMatch[0], `const EXACT_ADDRESS_RE =\n  /${pattern}/iu;`);
      changes.push('EXACT_ADDRESS_RE: added Latin alternatives (tochno/tochna/kazi)');
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 8. visit cancellation detection
// ═══════════════════════════════════════════════════════════
// Already in the original from git — skip

// Write changes
fs.writeFileSync(file, src, 'utf8');
console.log('Applied ' + changes.length + ' changes:');
changes.forEach(c => console.log('  ✓ ' + c));
