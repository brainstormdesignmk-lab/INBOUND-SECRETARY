import { buildEvent, inferPropertyId } from '../src/llm/deterministic';
import { PropertyService } from '../src/data/properties';
import { Db } from '../src/store/db';
import { loadConfig } from '../src/config';

const cfg = loadConfig();
const db = new Db(':memory:');
const properties = new PropertyService(db);

const texts = ['mi se svigja 89', 'mi se svigja 89', 'ZDRAVO', 'GO GLEDAV OVA 89'];

for (const text of texts) {
  const ev = buildEvent(text, 'discovery');
  const eb = inferPropertyId(text, properties);
  console.log(`"${text}" → event=${ev.type}, eb=${JSON.stringify(eb)}`);
}

// Check what the FSM would do with STAY + interest detected
import { transition } from '../src/fsm/machine';
for (const state of ['idle', 'discovery', 'intent', 'property_query', 'closing']) {
  const text = 'mi se svigja 89';
  const ev = buildEvent(text, state);
  const eb = inferPropertyId(text, properties);
  const t = transition(state, ev.type, eb);
  console.log(`state=${state} → event=${ev.type}, next=${t.state}, reply=${t.reply}`);
}
