const fs = require('fs');
const file = 'src/llm/deterministic.ts';
let src = fs.readFileSync(file, 'utf8');

// Replace LOCATION_FOLLOWUP_RE with dual-script version
const oldPattern = "(?:те|te)\\\\s+(?:праш(ав|ам)|pras(av|ам))\\\\s+(?:за\\\\s+)?(?:локација|адреса|улица|lokacija|adresa|ulica)|ова\\\\s+(?:е|e)\\\\s+(?:локација|адреса|lokacija|adresa)\\\\s+на|точн(ата|а|о)\\\\s+(?:локација|адреса|lokacija|adresa)";
const newPattern = "(?:те|te)\\\\s+(?:праш(ав|ам)|pras(av|ам))\\\\s+(?:за|za)\\\\s+(?:локација|адреса|улица|lokacija|adresa|ulica)|(?:ова|ova)\\\\s+(?:е|e)\\\\s+(?:локација|адреса|lokacija|adresa)\\\\s+на|(?:точн|tochn)(ата|а|о)\\\\s+(?:локација|адреса|lokacija|adresa)";

if (src.includes(oldPattern)) {
  src = src.replace(oldPattern, newPattern);
  fs.writeFileSync(file, src, 'utf8');
  console.log('Replaced LOCATION_FOLLOWUP_RE');
} else {
  console.log('Pattern not found!');
  // Find the actual content
  const idx = src.indexOf('LOCATION_FOLLOWUP_RE');
  if (idx > -1) {
    console.log('Found at:', idx);
    console.log('Context:', src.substring(idx, idx + 300));
  }
}
