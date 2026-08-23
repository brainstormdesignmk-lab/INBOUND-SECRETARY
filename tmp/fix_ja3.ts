const fs = require('fs');
const file = 'src/llm/deterministic.ts';
let src = fs.readFileSync(file, 'utf8');

// The pattern has: (?:jа\s+)? — Cyrillic ја (U+0458 + U+0430)
// We need: (?:jа|ja)\s+)? — add Latin ja (U+006A + U+0061)

// Find the exact byte sequence: (?: + Cyrillic ја + \s+)?
const cyrillicJa = String.fromCharCode(0x0458, 0x0430); // ја
const latinJa = String.fromCharCode(0x006A, 0x0061); // ja

const searchFor = '(?:' + cyrillicJa + '\\s+)?';
const replaceWith = '(?:' + cyrillicJa + '|' + latinJa + ')\\s+)';

console.log('Searching for:', JSON.stringify(searchFor));
console.log('Replacing with:', JSON.stringify(replaceWith));

const idx = src.indexOf(searchFor);
if (idx === -1) {
  console.log('Pattern not found! Searching for partial...');
  const partialIdx = src.indexOf(cyrillicJa);
  if (partialIdx > -1) {
    console.log('Cyrillic ja found at', partialIdx, ':', JSON.stringify(src.substring(partialIdx - 10, partialIdx + 15)));
  }
  process.exit(1);
}

console.log('Found at index', idx);
console.log('Context:', JSON.stringify(src.substring(idx - 20, idx + 30)));

src = src.substring(0, idx) + replaceWith + src.substring(idx + searchFor.length);
fs.writeFileSync(file, src, 'utf8');
console.log('Fixed!');
