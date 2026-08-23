const fs = require('fs');
const file = 'src/llm/deterministic.ts';
let src = fs.readFileSync(file, 'utf8');

// Find the exact location of the jа pattern in EXACT_ADDRESS_RE
// The pattern has (?:jа\s+)? where j is Latin j and а is Cyrillic а
// This matches NEITHER pure Latin "ja" NOR pure Cyrillic "ja"
// Fix: replace with (?:jа|ja)\s+)? to match both scripts

// Find the EXACT_ADDRESS_RE section
const exactIdx = src.indexOf('const EXACT_ADDRESS_RE');
const sectionEnd = src.indexOf('const LOCATION_FOLLOWUP_RE');
const section = src.substring(exactIdx, sectionEnd);

// Find the problematic mixed-script jа
// Latin j = 0x6A, Cyrillic а = 0x0430
const latinJ = String.fromCharCode(0x6A);
const cyrillicA = String.fromCharCode(0x0430);
const cyrillicJa = latinJ + cyrillicA; // "jа" mixed script

const idx = section.indexOf(cyrillicJa);
if (idx === -1) {
  console.log('Mixed-script jа not found in EXACT_ADDRESS_RE section');
  process.exit(1);
}

console.log('Found mixed-script jа at offset', idx);
console.log('Context:', JSON.stringify(section.substring(idx - 10, idx + 20)));

// Replace: (?:jа\s+)? → (?:jа|ja)\s+)?
// Note: the \s in the file is a literal backslash + s (regex shorthand)
const searchFor = '(?:' + cyrillicJa + '\\s+)?';
const replaceWith = '(?:' + cyrillicJa + '|ja)\\s+)';

const globalSearch = exactIdx;
const fullSearchIdx = src.indexOf(searchFor, globalSearch);
if (fullSearchIdx === -1) {
  console.log('Search pattern not found in full source');
  process.exit(1);
}

src = src.substring(0, fullSearchIdx) + replaceWith + src.substring(fullSearchIdx + searchFor.length);
fs.writeFileSync(file, src, 'utf8');
console.log('Fixed mixed-script jа → (?:jа|ja)');
