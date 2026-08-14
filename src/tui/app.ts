import blessed from 'blessed';
import { AppConfig } from '../config';
import { Db } from '../store/db';
import { SessionStore, ChatSession, resetToIdle } from '../fsm/session';
import { AppointmentStore } from '../store/appointments';
import { EscalationStore } from '../store/escalations';
import { MetaStore } from '../store/meta';
import { PropertyService } from '../data/properties';
import { createLlm } from '../llm/factory';
import { Classifier } from '../llm/classify';
import { Responder } from '../llm/respond';
import { InboundHandler } from '../handlers/inbound';
import { ChannelRegistry } from '../channels/types';
import { TuiChannel } from './channel';
import { QUICK_INTROS } from './intros';
import { buildLayout, esc, hhmm } from './layout';

type Role = 'user' | 'assistant' | 'system' | 'error';
interface Msg { role: Role; text: string; at: number; }
interface Lead {
  chatId: string;
  name: string;
  createdAt: number;
  state: string;
  strikes: number;
  outbound: number;
  msgs: Msg[];
}
type Mode = 'chat' | 'naming' | 'menu';

const HELP = `КОНТРОЛИ: [Space] нов клиент · [↑/↓] префрли клиент · [Enter] испрати / bypass типинг · [F1] нов клиент · [F2] брз почеток · [PgUp/PgDn] скрол на разговорот · [/reset] ресетирај сесија · [/owner <eb> ok|sold|rented|counter <time>] одговори на сопственик · [/agents] квоти · [/customers] редица · [C-q] излез`;

export class TuiApp {
  private box: any;
  private channel: TuiChannel;
  private pipeline: InboundHandler;
  private sessions: SessionStore;
  private db: Db;

  private leads: Lead[] = [];
  private selected = 0;
  private nextId = 1;
  private inputBuf = '';
  private nameBuf = '';
  private mode: Mode = 'chat';
  private menuIndex = 0;
  private menuBox: any = null;
  private chatFollow = true; // false once the user scrolls up — new messages no longer yank to bottom

  private chains = new Map<string, Promise<void>>();
  private busy = new Set<string>();
  private typing: { chatId: string; until: number } | null = null;
  private ownerTyping: {
    chatId: string; until: number;
    eb: number; action: 'ok' | 'sold' | 'rented' | 'counter'; ownerTime?: string;
  } | null = null;
  private ownerTimer: NodeJS.Timeout | null = null;
  // Client "typing" window — mirror of the owner's: after the client sends a
  // message Lina waits (default 30s) before replying; follow-up messages reset
  // the timer, and the queued messages flush in order when it fires or on Enter.
  private clientWindow: { chatId: string; until: number; queue: string[] } | null = null;
  private clientTimer: NodeJS.Timeout | null = null;
  private banner = '';
  private clock: any = null;
  private ticker: any = null;
  private quitting = false;

  private cfg: AppConfig;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    this.db = new Db('data/tui.db'); // separate DB — never pollutes production counters
    this.sessions = new SessionStore(this.db);
    const appointments = new AppointmentStore(this.db);
    const escalations = new EscalationStore(this.db);
    const meta = new MetaStore(this.db);

    const llm = createLlm(cfg);
    const propertyService = new PropertyService(cfg.propertyDataUrl); // REAL Supabase feed
    const classifier = new Classifier(llm, cfg, propertyService);
    const responder = new Responder(llm, cfg);

    this.channel = new TuiChannel(cfg);
    this.channel.onTyping = (chatId, ms) => {
      this.typing = ms > 0 ? { chatId, until: Date.now() + ms } : null;
      this.renderStatus();
      this.box.screen.render();
    };
    this.channel.onMessage = (chatId, text) => {
      this.appendMsg(chatId, { role: 'assistant', text, at: Date.now() });
    };

    const channels = new ChannelRegistry();
    channels.register(this.channel);

    this.pipeline = new InboundHandler({
      cfg, db: this.db, sessions: this.sessions, classifier, responder,
      properties: propertyService,
      appointments, escalations, meta, channels,
    });

    this.box = buildLayout('METROPOLIS · ЛИНА · TUI');
  }

  start(): void {
    const { screen } = this.box;
    screen.on('keypress', (ch: string | undefined, key: any) => this.onKey(ch, key));
    screen.on('resize', () => { this.renderAll(); });

    this.banner = 'Добредојдовте. [Space] = нов клиент. Вие сте клиентот — тестирајте ја Лина.';
    this.renderAll();

    this.clock = setInterval(() => { this.renderTop(); screen.render(); }, 1000);
    this.ticker = setInterval(() => {
      if (this.typing || this.ownerTyping || this.clientWindow || this.busy.size > 0) {
        this.renderStatus();
        screen.render();
      }
    }, 100);

    screen.render();
  }

  // ---------------- input handling ----------------

  private onKey(ch: string | undefined, key: { name: string; ctrl?: boolean; meta?: boolean }): void {
    const { screen } = this.box;
    if (key.ctrl && (key.name === 'q' || key.name === 'c')) return this.quit();

    // blessed emits Enter TWICE: first as name='return' (raw \r), then it
    // re-emits the same keystroke as name='enter'. If the raw 'return' event
    // reaches the input handling below, the \r gets appended to the input
    // buffer and corrupts the rendered line — letters appear to vanish while
    // typing. Swallow it; the 'enter' re-emit does the work.
    if (key.name === 'return' && (key as any).sequence === '\r') return;
    // Some terminals send \n for Enter; blessed renames that to 'linefeed'.
    if (key.name === 'linefeed') key = { ...key, name: 'enter' };

    if (this.mode === 'menu') {
      if (key.name === 'up') { this.menuIndex = Math.max(0, this.menuIndex - 1); this.renderMenu(); }
      else if (key.name === 'down') { this.menuIndex = Math.min(QUICK_INTROS.length - 1, this.menuIndex + 1); this.renderMenu(); }
      else if (key.name === 'enter') {
        const q = QUICK_INTROS[this.menuIndex];
        if (q) this.inputBuf = q.text;
        this.closeMenu();
      } else if (key.name === 'escape') this.closeMenu();
      return;
    }

    if (this.mode === 'naming') {
      if (key.name === 'enter') return this.confirmName();
      if (key.name === 'escape') { this.mode = 'chat'; this.renderAll(); return; }
      if (key.name === 'backspace') this.nameBuf = this.nameBuf.slice(0, -1);
      else if (ch && !key.ctrl && !key.meta) this.nameBuf += ch;
      this.renderAll(); // full repaint — incremental box updates get dropped by some web terminals
      return;
    }

    switch (key.name) {
      case 'up': this.move(-1); return;
      case 'down': this.move(1); return;
      case 'f1': this.startNewClient(); return;
      case 'f2': this.openMenu(); return;
      case 'pageup': this.scrollChat(-1); return;
      case 'pagedown': this.scrollChat(1); return;
      case 'home': this.box.chatBox.scrollTo(0); this.chatFollow = false; this.box.screen.render(); return;
      case 'end': this.box.chatBox.setScrollPerc(100); this.chatFollow = true; this.box.screen.render(); return;
      case 'enter':
        // Text typed + Enter = SEND it. (This is also what makes the OWNER
        // follow-up work: a second /owner while the window is open goes through
        // sendInput, which replaces the pending answer and resets the timer —
        // it must NOT be swallowed by the bypass below.)
        if (this.inputBuf.trim().length > 0) { this.sendInput(); return; }
        // Pure Enter (empty buffer) = bypass whatever is pending.
        if (this.ownerTyping && this.ownerTyping.chatId === this.activeLead()?.chatId) {
          this.ownerAnswer(); // Enter = skip the owner's typing delay
          return;
        }
        if (this.clientWindow) { this.flushClient(); return; } // flush the client's queued messages now
        if (this.channel.bypass()) { this.renderStatus(); screen.render(); return; }
        return;
      case 'backspace': this.inputBuf = this.inputBuf.slice(0, -1); break;
      case 'escape': this.inputBuf = ''; break;
      case 'space':
        if (this.inputBuf.length === 0) { this.startNewClient(); return; }
        this.inputBuf += ' '; break;
      default:
        if (ch && !key.ctrl && !key.meta) this.inputBuf += ch;
        this.renderAll(); // full repaint — incremental box updates get dropped by some web terminals
        return;
    }
    this.renderAll();
  }

  // ---------------- actions ----------------

  private activeLead(): Lead | undefined {
    return this.leads[this.selected];
  }

  private scrollChat(dir: number): void {
    const lead = this.activeLead();
    if (!lead) return;
    const { chatBox } = this.box;
    const step = Math.max(1, Math.floor(chatBox.height / 2));
    if (dir < 0) {
      chatBox.scroll(-step);
      this.chatFollow = false;
    } else {
      chatBox.scroll(step);
      if (chatBox.getScrollPerc() >= 100) this.chatFollow = true;
    }
    this.renderStatus();
    this.box.screen.render();
  }

  private move(delta: number): void {
    if (!this.leads.length) return;
    this.selected = Math.max(0, Math.min(this.leads.length - 1, this.selected + delta));
    this.renderLeads();
    this.renderChat();
    this.renderStatus();
    this.box.screen.render();
  }

  private startNewClient(): void {
    if (this.mode !== 'chat') return;
    this.mode = 'naming';
    this.nameBuf = '';
    this.renderInput();
    this.renderStatus();
    this.box.screen.render();
  }

  private confirmName(): void {
    const name = this.nameBuf.trim() || `Клиент ${this.nextId}`;
    this.mode = 'chat';
    const chatId = `client-${this.nextId++}`;
    // data/tui.db persists across runs while chatIds restart at client-1 — a NEW
    // client must never inherit a stale session (e.g. owner_checking from a
    // previous run), or Lina resumes the old state and never greets.
    this.sessions.delete(chatId);
    const lead: Lead = {
      chatId,
      name,
      createdAt: Date.now(),
      state: '—', strikes: 0, outbound: 0,
      msgs: [{ role: 'system', text: `нов клиент: ${name} — чека прва порака од клиентот`, at: Date.now() }],
    };
    this.leads.push(lead);
    this.selected = this.leads.length - 1;
    this.renderInput();
    // Inbound-first: Lina must NOT greet until the CLIENT writes. The session is
    // created lazily on the first message (see InboundHandler.processMessage).
    this.renderAll();
  }

  private sendInput(): void {
    const lead = this.activeLead();
    const text = this.inputBuf.trim();
    if (!lead || !text) return;
    this.inputBuf = '';
    if (text === '/help') {
      this.appendMsg(lead.chatId, { role: 'system', text: HELP, at: Date.now() });
      this.renderAll();
      return;
    }
    if (text === '/reset') {
      const s = this.sessions.get(lead.chatId);
      if (s) { resetToIdle(s); this.sessions.set(s); }
      this.appendMsg(lead.chatId, { role: 'system', text: 'сесијата е ресетирана — следната порака добива нов поздрав', at: Date.now() });
      this.refreshLeadState(lead.chatId);
      this.renderAll();
      return;
    }
    // --- v3 owner sim commands ---
    const ownerMatch = text.match(/^\/owner\s+(\d+)\s+(ok|sold|rented|counter)(?:\s+(.+))?$/i);
    if (ownerMatch) {
      const eb = parseInt(ownerMatch[1], 10);
      const action = ownerMatch[2].toLowerCase() as 'ok' | 'sold' | 'rented' | 'counter';
      const ownerTime = ownerMatch[3] ?? undefined;
      const agent = this.pipeline.ownerAgent as unknown as {
        pendingEb?: (chatId: string) => number | null;
        simulate?: (chatId: string, eb: number, action: 'ok' | 'sold' | 'rented' | 'counter', ownerTime?: string) => boolean;
      };
      const pending = agent.pendingEb?.(lead.chatId) ?? null;
      if (pending !== eb) {
        this.appendMsg(lead.chatId, {
          role: 'system',
          text: `[owner] EB ${eb} — нема чекање за овој клиент (или погрешен EB)`,
          at: Date.now(),
        });
        this.renderAll();
        return;
      }
      this.appendMsg(lead.chatId, {
        role: 'system',
        text: `[owner] EB ${eb} → ${action}${ownerTime ? ` (${ownerTime})` : ''} — одговор примен`,
        at: Date.now(),
      });
      // The owner "types" within a window (default 30s — they may send a
      // FOLLOW-UP message after the first one; Lina waits for the final word
      // before relaying). [Enter] bypasses the timer for fast testing.
      const ownerDelay = this.cfg.ownerTypingDelayMs;
      if (this.ownerTimer) { clearTimeout(this.ownerTimer); this.ownerTimer = null; } // follow-up resets the window
      this.ownerTyping = { chatId: lead.chatId, until: Date.now() + ownerDelay, eb, action, ownerTime };
      this.renderStatus();
      this.box.screen.render();
      this.ownerTimer = setTimeout(() => this.ownerAnswer(), ownerDelay);
      return;
    }
    if (text === '/agents') {
      const rows = this.pipeline.agents.listActive().map(a => {
        const sale = this.pipeline.agents.visitsThisMonth(a.id, 'buy');
        const rent = this.pipeline.agents.visitsThisMonth(a.id, 'rent');
        return `${a.name} (${a.phone}) — продажба: ${sale} · изнајмување: ${rent} · вкупно: ${sale + rent}`;
      }).join('\n');
      this.appendMsg(lead.chatId, { role: 'system', text: `КВОТИ (овој месец):\n${rows || '(нема агенти)'}`, at: Date.now() });
      this.renderAll();
      return;
    }
    if (text === '/customers') {
      const rows = this.pipeline.customers.listQueued().map(c =>
        `${c.name || '(без име)'} · ${c.phone || '(без тел)'} · ${c.service || '?'} · ${c.location || '?'} · EB ${c.refusedEb ?? '-'} · ${c.reason}`
      ).join('\n');
      this.appendMsg(lead.chatId, { role: 'system', text: `РЕДИЦА КЛИЕНТИ:\n${rows || '(празно)'}`, at: Date.now() });
      this.renderAll();
      return;
    }
    // --- end v3 commands ---
    this.appendMsg(lead.chatId, { role: 'user', text, at: Date.now() });
    // Client 30s typing window: Lina waits for the client to finish before
    // replying. Follow-up messages RESET the timer; when it fires (or [Enter]
    // is pressed with an empty buffer) ALL queued messages flush in order.
    // Slash commands above never queue — they run immediately.
    if (this.clientWindow && this.clientWindow.chatId !== lead.chatId) {
      this.flushClient(); // deliver the other chat's pending messages first
    }
    const delay = this.cfg.clientTypingDelayMs;
    if (this.clientTimer) { clearTimeout(this.clientTimer); this.clientTimer = null; }
    this.clientWindow = this.clientWindow && this.clientWindow.chatId === lead.chatId
      ? { chatId: lead.chatId, until: Date.now() + delay, queue: [...this.clientWindow.queue, text] }
      : { chatId: lead.chatId, until: Date.now() + delay, queue: [text] };
    this.clientTimer = setTimeout(() => this.flushClient(), delay);
    this.renderInput();
    this.renderStatus();
    this.box.screen.render();
  }

  /** The client's queued messages land — process them IN ORDER through the pipeline. */
  private flushClient(): void {
    const cw = this.clientWindow;
    if (!cw) return;
    if (this.clientTimer) { clearTimeout(this.clientTimer); this.clientTimer = null; }
    this.clientWindow = null;
    const lead = this.leads.find(l => l.chatId === cw.chatId);
    for (const text of cw.queue) {
      this.runChain(cw.chatId, () =>
        this.pipeline.handle('viber', cw.chatId, text, { kind: 'text', senderName: lead?.name ?? 'Клиент' })
      );
    }
    this.renderStatus();
    this.box.screen.render();
  }

  // Per-chat serialized chain: preserves order inside one chat, parallel across chats.
  private runChain(chatId: string, fn: () => Promise<void>): void {
    this.busy.add(chatId);
    const prev = this.chains.get(chatId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const s0 = this.sessions.get(chatId)?.state;
        try {
          await fn();
        } catch (e) {
          this.appendMsg(chatId, { role: 'error', text: `грешка: ${(e as Error).message}`, at: Date.now() });
        }
        const s1 = this.sessions.get(chatId)?.state;
        if (s0 && s1 && s0 !== s1) {
          this.appendMsg(chatId, { role: 'system', text: `state: ${s0} → ${s1}`, at: Date.now() });
        }
      })
      .finally(() => {
        this.busy.delete(chatId);
        this.refreshLeadState(chatId);
        this.renderAll();
      });
    this.chains.set(chatId, next);
  }

  /** The owner's typed answer lands — resolve the pending check so Lina relays it. */
  private ownerAnswer(): void {
    const ot = this.ownerTyping;
    if (!ot) return;
    if (this.ownerTimer) { clearTimeout(this.ownerTimer); this.ownerTimer = null; }
    this.ownerTyping = null;
    const agent = this.pipeline.ownerAgent as unknown as {
      simulate?: (chatId: string, eb: number, action: 'ok' | 'sold' | 'rented' | 'counter', ownerTime?: string) => boolean;
    };
    agent.simulate?.(ot.chatId, ot.eb, ot.action, ot.ownerTime);
    this.renderStatus();
    this.box.screen.render();
  }

  private appendMsg(chatId: string, msg: Msg): void {
    const lead = this.leads.find(l => l.chatId === chatId);
    if (!lead) return;
    lead.msgs.push(msg);
    this.renderChat();
  }

  private refreshLeadState(chatId: string): void {
    const lead = this.leads.find(l => l.chatId === chatId);
    if (!lead) return;
    const s: ChatSession | null = this.sessions.get(chatId);
    if (s) {
      lead.state = s.state;
      lead.strikes = s.strikes;
      lead.outbound = s.outboundCount;
    }
  }

  // ---------------- F2 menu ----------------

  private openMenu(): void {
    if (this.mode !== 'chat') return;
    this.mode = 'menu';
    this.menuIndex = 0;
    this.renderMenu();
  }

  private closeMenu(): void {
    this.mode = 'chat';
    if (this.menuBox) {
      this.box.screen.remove(this.menuBox);
      this.menuBox.destroy();
      this.menuBox = null;
    }
    this.renderInput();
    this.renderStatus();
    this.box.screen.render();
  }

  private renderMenu(): void {
    const { screen } = this.box;
    if (!this.menuBox) {
      this.menuBox = blessed.box({
        parent: screen,
        tags: true,
        border: { type: 'line', fg: 'yellow' },
        style: { fg: 'white', border: { fg: 'yellow' } },
        label: ' БРЗ ПОЧЕТОК — само го пополнува полето, Вие испраќате ',
        width: '70%',
        height: QUICK_INTROS.length + 4,
        top: 'center',
        left: 'center',
      } as any);
    }
    const lines = QUICK_INTROS.map((q, i) =>
      i === this.menuIndex ? `{inverse}${esc(q.label)}{/inverse}` : esc(q.label)
    );
    this.menuBox.setContent(lines.join('\n'));
    screen.render();
  }

  // ---------------- rendering ----------------

  private renderTop(): void {
    const lead = this.activeLead();
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const banner = this.banner ? ` · ${this.banner}` : '';
    this.box.topBar.setContent(
      ` METROPOLIS · ЛИНА · TUI   ${time}   клиенти: ${this.leads.length}   активен: ${lead ? lead.name : '—'}   испратено: ${this.channel.sends}${banner}`
    );
  }

  private renderLeads(): void {
    const { leadsBox } = this.box;
    if (!this.leads.length) {
      leadsBox.setContent('\n{gray-fg}(нема клиенти — притиснете Space за нов клиент){/gray-fg}');
      return;
    }
    const lines = this.leads.map((l, i) => {
      const sel = i === this.selected;
      const busyMark = this.busy.has(l.chatId) ? ' …' : '';
      const strikes = l.strikes > 0 ? ` ⚑${l.strikes}` : '';
      const row = `${sel ? '▸' : ' '} ${l.name}${busyMark}\n   ${l.chatId} · ${l.state}${strikes} · ${l.outbound}/100`;
      return sel ? `{inverse}${esc(row)}{/inverse}` : esc(row);
    });
    leadsBox.setContent(lines.join('\n') + '\n');
    leadsBox.setScrollPerc(100);
  }

  private renderChat(): void {
    const { chatBox } = this.box;
    const lead = this.activeLead();
    if (!lead) {
      chatBox.setContent('{gray-fg}Нема активен разговор.{/gray-fg}\n{gray-fg}Притиснете [Space] за да започнете нов клиент — потоа пишувајте како тој клиент.{/gray-fg}');
      return;
    }
    const lines = lead.msgs.map(m => {
      const t = hhmm(m.at);
      switch (m.role) {
        case 'user':
          return `{cyan-fg}[${t}] ${esc(m.text)}{/cyan-fg}`;
        case 'assistant':
          return `[${t}] {white-fg}ЛИНА:{/white-fg} ${esc(m.text)}`;
        case 'system':
          return `{yellow-fg}[${t}] — ${esc(m.text)} —{/yellow-fg}`;
        case 'error':
          return `{red-fg}[${t}] ✗ ${esc(m.text)}{/red-fg}`;
      }
    });
    const perc = chatBox.getScrollPerc(); // preserve position if the user scrolled up
    chatBox.setContent(lines.join('\n\n'));
    if (this.chatFollow || perc >= 100) chatBox.setScrollPerc(100);
    else chatBox.setScrollPerc(perc);
  }

  private renderInput(): void {
    const { inputBox } = this.box;
    if (this.mode === 'naming') {
      inputBox.setLabel(' НОВ КЛИЕНТ — име (Enter=ок, Esc=откажи) ');
      inputBox.setContent(`{green-fg}Име: {/green-fg}${esc(this.nameBuf)}█`);
      return;
    }
    inputBox.setLabel(' ПОРАКА ');
    inputBox.setContent(`{green-fg}› {/green-fg}${esc(this.inputBuf)}█`);
  }

  private renderStatus(): void {
    const { statusBar } = this.box;
    const lead = this.activeLead();
    let s = '';
    if (this.ownerTyping) {
      const rem = Math.max(0, this.ownerTyping.until - Date.now()) / 1000;
      const who = this.ownerTyping.chatId === lead?.chatId ? '' : ` (${this.ownerTyping.chatId})`;
      s += `{white-bg}{black-fg} ⏳ сопственикот пишува…${who} ${rem.toFixed(1)}s — [Enter] инстант {/black-fg}{/white-bg} · `;
    }
    if (this.clientWindow) {
      const rem = Math.max(0, this.clientWindow.until - Date.now()) / 1000;
      const who = this.clientWindow.chatId === lead?.chatId ? '' : ` (${this.clientWindow.chatId})`;
      s += `{white-bg}{black-fg} ⏳ клиентот пишува…${who} ${rem.toFixed(1)}s — [Enter] инстант {/black-fg}{/white-bg} · `;
    }
    if (this.typing) {
      const rem = Math.max(0, this.typing.until - Date.now()) / 1000;
      const who = this.typing.chatId === lead?.chatId ? '' : ` (${this.typing.chatId})`;
      s += `{white-bg}{black-fg} ⏳ Лина пишува… ${rem.toFixed(1)}s — [Enter] инстант {/black-fg}{/white-bg} · `;
    } else if (lead && this.busy.has(lead.chatId)) {
      s += '{white-bg}{black-fg} ⏳ Лина размислува… {/black-fg}{/white-bg} · ';
    }
    if (lead && !this.chatFollow) {
      s += '{white-bg}{black-fg} ▲ нови пораки — PgDn за долу {/black-fg}{/white-bg} · ';
    }
    s += 'antiban: 9/s бакет · 100/час по клиент';
    s += ' · [Space] нов клиент · [↑/↓] префрли · [Enter] испрати/bypass · [F2] брз почеток · [PgUp/PgDn] скрол · [/reset] · [/owner] · [C-q] излез';
    statusBar.setContent(s);
  }

  private renderAll(): void {
    this.renderTop();
    this.renderLeads();
    this.renderChat();
    this.renderInput();
    this.renderStatus();
    this.forceFullInputRedraw();
    this.box.screen.render();
  }

  /**
   * blessed's screen.render() is cell-diff based: after a keystroke it emits
   * only the changed cells as cursor-jump + single-character writes. Web-based
   * terminal brokers (Freebuff) drop those tiny writes — the reason letters
   * never appear while typing. Blanking the OLD frame buffer (olines) for the
   * input rows makes every cell "changed", so blessed re-emits the whole input
   * line from column 0 — the same full-line writes that demonstrably work.
   */
  private forceFullInputRedraw(): void {
    const { screen, inputBox } = this.box;
    const lpos = inputBox.lpos;
    const top = lpos ? lpos.yi : inputBox.atop;
    const bottom = lpos ? lpos.yl : inputBox.abottom; // exclusive
    for (let y = top; y < bottom; y++) {
      const old = screen.olines[y];
      if (!old) continue;
      for (let x = 0; x < old.length; x++) old[x] = [screen.dattr, '\x00'];
    }
  }

  // ---------------- quit ----------------

  private quit(): void {
    if (this.quitting) return;
    this.quitting = true;
    if (this.clock) clearInterval(this.clock);
    if (this.ticker) clearInterval(this.ticker);
    if (this.ownerTimer) clearTimeout(this.ownerTimer);
    if (this.clientTimer) clearTimeout(this.clientTimer);
    this.box.screen.destroy();
    process.exit(0);
  }
}
