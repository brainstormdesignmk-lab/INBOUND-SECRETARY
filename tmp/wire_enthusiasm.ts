const fs = require('fs');
const file = 'src/handlers/inbound.ts';
let src = fs.readFileSync(file, 'utf8');

// The enthusiasm block goes right BEFORE the fee.why block.
// When the client says "mi se svigja 89" / "zainteresiran sum za 89",
// detectVisitInterest fires → INTERESTED → closing.
// We send enthusiasm + visit offer (NOT the fee yet).
// The fee is disclosed only after the client says "да" (ownerContactPending).

const marker = `    } else if (detectFeeWhy(text) && ['closing', 'property_query', 'presentation', 'discovery', 'intent', 'idle'].includes(before)) {`;

const enthusiasmBlock = `    } else if (next === 'closing'
        && ev.type === 'INTERESTED'
        && before !== 'closing'
        && (before === 'property_query' || before === 'presentation' || before === 'discovery')) {
      // Enthusiasm: the client said "ми се свиѓа 89" / "заинтересиран сум" /
      // "го сакам" — positive interest WITHOUT an explicit visit time or
      // availability ask. Send "Одличен избор!" + visit offer, NOT the fee
      // yet. The fee is disclosed ONLY after the client confirms ("да").
      const eb = session.slots.propertyId ?? session.slots.interestedPropertyId ?? props[0]?.eb;
      if (eb) {
        session.slots.interestedPropertyId = eb;
        session.slots.ownerContactPending = true;
        session.state = 'closing';
      }
      reply = pickVariant('property.liked', { recent: assistantTexts(session) })
        ?? 'Одличен избор! Дали би сакале да организирам посета, за да го погледнете во живо?';

${marker}`;

if (!src.includes(marker)) {
  console.error('Marker not found! Let me check...');
  // Try to find it
  const idx = src.indexOf('detectFeeWhy');
  console.log('detectFeeWhy first found at:', idx);
  console.log('Context:', src.substring(idx - 100, idx + 100).replace(/\n/g, '\\n'));
  process.exit(1);
}

src = src.replace(marker, enthusiasmBlock);
fs.writeFileSync(file, src);
console.log('OK: enthusiasm handler block added');
