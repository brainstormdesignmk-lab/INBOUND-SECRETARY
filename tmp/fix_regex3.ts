const fs = require('fs');
const file = 'src/llm/deterministic.ts';
let src = fs.readFileSync(file, 'utf8');
const lines = src.split('\n');

// Find the LOCATION_FOLLOWUP_RE regex line (line after the const declaration)
let lineIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('LOCATION_FOLLOWUP_RE') && lines[i].includes('const')) {
    lineIdx = i + 1; // regex is on the next line
    break;
  }
}

if (lineIdx > -1) {
  // Fully dual-script regex — every word has both Cyrillic and Latin alternatives
  const newRegex = `  /(?:те|te)\\s+(?:праш(ав|ам)|pras(av|ам))\\s+(?:за|za)\\s+(?:локација|адреса|улица|lokacija|adresa|ulica)|(?:ова|ova)\\s+(?:е|e)\\s+(?:локација|адреса|lokacija|adresa)\\s+(?:на|na)|(?:точн|tochn)(?:ата|ata|а|а|о|о)\\s+(?:локација|адреса|lokacija|adresa)/iu;`;
  console.log('Old line:', lines[lineIdx].substring(0, 80));
  lines[lineIdx] = newRegex;
  console.log('New line:', lines[lineIdx].substring(0, 120));
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  console.log('Written!');
}
