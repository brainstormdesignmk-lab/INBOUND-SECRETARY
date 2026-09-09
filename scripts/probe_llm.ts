import * as path from 'path';
import * as os from 'os';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(os.homedir(), '.lina', 'lina.env') });

async function main() {
  const { createLlm } = await import('../src/llm/factory');
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  console.log('provider:', cfg.llmProvider, '| geminiModel:', cfg.geminiModel, '| groqModel:', cfg.groqModel);
  console.log('keys present: gemini1/2/3 =', !!cfg.geminiApiKey, !!cfg.geminiApiKey2, !!cfg.geminiApiKey3, '| groq =', !!cfg.groqApiKey);
  const llm = createLlm(cfg);
  console.log('client type:', llm.constructor.name);
  try {
    const r = await llm.complete({
      role: 'respond',
      messages: [
        { role: 'system', content: 'Ти си Лина, секретарка во агенција. Одговарај кратко на македонски.' },
        { role: 'user', content: 'Здраво' },
      ],
      temperature: 0.7,
      maxTokens: 200,
      topP: 0.9,
    });
    console.log('COMPLETE OK:', JSON.stringify(r).substring(0, 150));
  } catch (e) {
    console.log('COMPLETE FAILED:', (e as Error).message.substring(0, 300));
    process.exit(1);
  }
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
