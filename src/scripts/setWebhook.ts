import { loadConfig } from '../config';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const action = process.argv[2] ?? 'set';
  if (!cfg.viberToken) throw new Error('VIBER_TOKEN is not set in .env');
  if (action === 'set' && !cfg.viberWebhookUrl) throw new Error('VIBER_WEBHOOK_URL is not set in .env');

  const body = action === 'clear'
    ? { url: '' }
    : {
        url: cfg.viberWebhookUrl,
        event_types: ['delivered', 'seen', 'failed', 'subscribed', 'unsubscribed', 'conversation_started'],
        send_name: true,
        send_photo: true,
      };

  const res = await fetch('https://chatapi.viber.com/pa/set_webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Viber-Auth-Token': cfg.viberToken },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { status?: number; status_message?: string };
  console.log(JSON.stringify(data, null, 2));
  if (data.status !== 0) process.exitCode = 1;
}

main().catch(e => {
  console.error('[setWebhook]', e);
  process.exit(1);
});
