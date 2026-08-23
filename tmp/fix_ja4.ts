const fs = require('fs');
const file = 'src/llm/deterministic.ts';
let src = fs.readFileSync(file, 'utf8');

// The remaining unfixed occurrence is at the standalone кажи pattern:
// (?:кажи|kazi)\\s+(?:ми\\s+)?(?:jа\\s+)?(?:адресата
// We need: (?:кажи|kazi)\\s+(?:ми\\s+)?(?:jа|ja)\\s+(?:адресата

const cyrillicJa = String.fromCharCode(0x0458, 0x0430); // jа (Cyrillic)
const latinJa = String.fromCharCode(0x006A, 0x0061); // ja (Latin)

// Search for the pattern: kazi)\\s+(?:ми\\s+)?(?:jа\\s+)?
const searchFor = 'kazi)\\s+(?:ми\\s+)?(?:' + cyrillicJa + '\\s+)?';
const replaceWith = 'kazi)\\s+(?:ми\\s+)?(?:' + cyrillicJa + '|' + latinJa + ')\\s+)';

console.log('Searching for:', JSON.stringify(searchFor));

const idx = src.indexOf(searchFor);
if (idx === -1) {
  console.log('Pattern not found!');
  // Check what's there instead
  const kaziIdx = src.indexOf('kazi)\\s+(?:ми\\s+)');
  if (kaziIdx > -1) {
    console.log('Found kazi pattern at:', kaziIdx, JSON.stringify(src.substring(kaziIdx, kaziIdx + 50)));
  }
  process.exit(1);
}

console.log('Found at', idx, ':', JSON.stringify(src.substring(idx, idx + 50)));
src = src.substring(0, idx) + replaceWith + src.substring(idx + searchFor.length);
fs.writeFileSync(file, src, 'utf8');
console.log('Fixed remaining jа → (?:jа|ja)');
