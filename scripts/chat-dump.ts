// LIST A CHAT — the operator's own view of a real conversation.
//
//   npx tsx scripts/chat-dump.ts            # every chat that has a transcript
//   npx tsx scripts/chat-dump.ts V16K11     # that chat, in full
//   npx tsx scripts/chat-dump.ts V16K11 50  # its last 50 turns
//
// Reads the SAME database the appliance runs on (config's DB path), so it works
// on the box as well as locally: `npx tsx scripts/chat-dump.ts` from the
// appliance directory prints what the client and Lina actually exchanged.
//
// The transcript itself is written per turn from the handler's close hook (see
// src/store/chatLog.ts) and nothing sweeps it — this is the durable record the
// `sessions` table never was.

import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { ChatLogStore } from '../src/store/chatLog';

const cfg = loadConfig();
const dbPath = process.env.DB_PATH ?? 'data/tui.db';
const db = new Db(dbPath);
const log = new ChatLogStore(db);

const chatId = process.argv[2];
const limit = Number(process.argv[3] ?? 500);

if (!chatId) {
  const chats = log.chats();
  if (chats.length === 0) {
    console.log(`No transcripts in ${dbPath} yet — chat_log is written per turn from now on.`);
  } else {
    console.log(`Transcripts in ${dbPath} (newest activity first):`);
    for (const c of chats) {
      console.log(`  ${c.chatId.padEnd(28)} ${String(c.turns).padStart(5)} turns  last ${new Date(c.lastAt).toISOString().replace('T', ' ').slice(0, 19)}`);
    }
    console.log(`\nFull transcript: npx tsx scripts/chat-dump.ts <chatId>`);
  }
} else {
  const rows = log.recent(chatId, Number.isFinite(limit) && limit > 0 ? limit : 500);
  if (rows.length === 0) {
    console.log(`No transcript for ${chatId} in ${dbPath}.`);
  } else {
    console.log(ChatLogStore.render(rows));
    console.log(`\n(${rows.length} turns, ${dbPath})`);
  }
}

db.close();
