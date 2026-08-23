const fs = require('fs');
const file = 'src/llm/deterministic.ts';
let src = fs.readFileSync(file, 'utf8');

// The pattern in the file has: (?:jа\\s+)? where jа is Cyrillic
// We need: (?:jа|ja)\\s+)?  (add Latin ja alternative)
// But the file has the actual Cyrillic character, so we need to match it literally

// Find the EXACT_ADDRESS_RE pattern
const match = src.match(/const EXACT_ADDRESS_RE\s*=\s*\/([\s\S]*?)\/iu;/);
if (!match) { console.log('Pattern not found'); process.exit(1); }

const pattern = match[1];
// Find all occurrences of jа (Cyrillic j + Cyrillic а)
const jаIdx = pattern.indexOf('jа');
console.log('Cyrillic jа found at index:', jаIdx);
if (jаIdx > -1) {
  console.log('Context:', JSON.stringify(pattern.substring(jаIdx-10, jаIdx+20)));
}

// Replace: (?:jа\\s+)? → (?:jа|ja)\\s+)?
// But only in the EXACT_ADDRESS_RE section
const oldPart = '(?:jа\\s+)?(?:адресата';
const newPart = '(?:jа|ja)\\s+(?:адресата';

if (src.includes(oldPart)) {
  src = src.replace(oldPart, newPart);
  fs.writeFileSync(file, src, 'utf8');
  console.log('Fixed: replaced (?:jа\\s+)? with (?:jа|ja)\\s+');
} else {
  console.log('Pattern not found in file. Looking for alternatives...');
  // Try with different escaping
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('EXACT_ADDRESS_RE') && lines[i].includes('const')) {
      const regexLine = lines[i + 1];
      // Find ја in the line
      const jаPos = regexLine.indexOf('jа');
      console.log('Line', i + 2, ': jа at pos', jаPos);
      if (jаPos > -1) {
        console.log('Around:', JSON.stringify(regexLine.substring(jаPos - 5, jаPos + 25)));
      }
      break;
    }
  }
}
