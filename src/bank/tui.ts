/**
 * BANK:TUI — the dedicated review screen for the learning loop.
 *
 * Deliberately a SEPARATE process from the chat TUI: the operator can review,
 * edit and approve bank material without touching the live funnel, and the
 * screen has room for a list + full reply + key editor.
 *
 * Tabs (1–4 or Tab):
 *   ENRICHMENT  queue turns — E/F9 edits, K changes the target key,
 *               A pushes to the bank (STAGED), X discards the turn.
 *   DYNAMIC     bank_dynamic captures — E/F9 edits, K key, A push, X delete.
 *   STAGED      bank_variants awaiting approval — E edits, A promotes, X discards.
 *   ACTIVE      live learned variants — read-only; X retires (reversible).
 *
 * Every action goes through BankReview (src/bank/review.ts). Nothing here
 * serves a client: a push is always STAGED until the operator promotes it.
 */
import blessed from 'blessed';
import * as path from 'path';
import { BankReview, ReviewCategory, ReviewItem, REVIEW_CATEGORIES, validateBankKey } from './review';
import { codeSourceFor, isCodeConstant } from './codeSource';
import { BankStore, DATA_DRIVEN_KEYS, FROZEN_BANK_KEYS, isExcludedFromEnrichment } from '../store/bank';
import { runAutoReject, runRekey } from './autoPass';
import { relearnFromCorrections } from './loopB';

/** ORANGE = the answer is code.
 *
 *  Palette index, NOT hex: blessed's hex-in-tag path calls colors.match with
 *  replace()'s extra arguments and collapses #ff8700 to plain yellow (verified
 *  on a real pty). 208 is the xterm orange (#ff8700), and the tput layer maps
 *  it to the nearest colour on a 16-colour terminal. */
const ORANGE = '{208-fg}';
const ORANGE_END = '{/208-fg}';
const orange = (s: string): string => `${ORANGE}${s}${ORANGE_END}`;
import { caretLine, editLayout, moveVertical, paintCaret } from './editModel';
import { dayLabel, groupByDay } from './dateGroups';
import { clearProvenanceCache } from './provenance';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Db } from '../store/db';
import { countSourceApprovals, examplesFromImportNote, sourceIdFromImportNote, fetchAtomSnapshot, FleetSource, buildFleetSources, parseAtomSources, saveDatedDatabaseSnapshot, saveDatedMasterSnapshot, stageMissingBankRows, markImportDecision, syncSharedBank, exportLinaDatabase, importSourceEnrichmentLog } from './fleet';

const LABEL: Record<ReviewCategory, string> = {
  enrichment: 'ENRICHMENT',
  dynamic: 'DYNAMIC',
  staged: 'STAGED',
  active: 'ACTIVE',
};

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const safe = (s: string): string => s.replace(/[{}]/g, '');
const clean = (s: unknown): string => String(s ?? '');
const execFileAsync = promisify(execFile);

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\n/)) {
    const words = raw.split(/\s+/).filter(Boolean);
    if (words.length === 0) { out.push(''); continue; }
    let line = '';
    for (const w of words) {
      if (line.length === 0) line = w;
      else if (line.length + 1 + w.length <= width) line += ` ${w}`;
      else { out.push(line); line = w; }
    }
    if (line) out.push(line);
  }
  return out;
}

type Mode = 'browse' | 'edit' | 'key' | 'fleet' | 'autos';

export interface BankTuiOptions { projectRoot?: string; atomConfigPath?: string; }

/** What the list actually shows: a batch-day header, or a review row.
 *  Headers are NOT selectable — move()/reload() skip them, so E/A/K/X can
 *  never fire on a date. */
type ListRow =
  | { kind: 'day'; date: string; count: number }
  | { kind: 'item'; item: ReviewItem };

export class BankReviewTui {
  private screen: any;
  private header: any;
  private list: any;
  private detail: any;
  private editor: any;
  private keyBox: any;
  private status: any;

  private cat: ReviewCategory = 'enrichment';
  /** The real rows, in query order (identity/target of every action). */
  private items: ReviewItem[] = [];
  /** items interleaved with one date header per batch day (what the list
   *  draws); `idx` indexes THIS array so the highlight and the header rows
   *  stay aligned, but current() never returns a header. */
  private rows: ListRow[] = [];
  private idx = 0;
  private mode: Mode = 'browse';
  private keyBuf = '';
  /** The edit buffer and the caret's index into it (see renderEditor). */
  private editBuf = '';
  private editPos = 0;
  private message = '';
  private confirm: { at: number; id: number } | null = null;
  /**
   * [K] keys chosen for a queue/dynamic row, kept OUTSIDE the row and applied
   * on every reload.
   *
   * K used to assign `it.key` on the in-memory item and then reload — which
   * rebuilds the list from the database, so the chosen key was gone before the
   * next E/A. The screen SAID "#195 → learn.x" while edit/push still targeted
   * fee.ask.buy and were refused as frozen: on the real queue that blocked 74%
   * of the rows with no visible reason. The override is keyed by category+id
   * because ids are per table; it is session-scoped on purpose (the queue row's
   * bank_key is the cron's target and must not be rewritten by a review
   * keystroke).
   */
  private keyOverrides = new Map<string, string>();
  /** The poll that keeps the screen on the database's CURRENT state — see
   *  syncNow(). Cleared by quit(). */
  private syncTimer: NodeJS.Timeout | null = null;
  private masterDb: Db | null = null;
  private projectRoot: string;
  private atomConfigPath: string;
  private fleetSources: FleetSource[] = [];
  private sourceIdx = 0;
  private sourcePending = new Map<string, number>();
  private fleetBusy = false;
  private fleetNotice = '';
  /** P-menu (auto-passes + Loop B): the SAME runners the CLI scripts call,
   *  driven by a selection instead of argv. One implementation, two entry
   *  points — an apply from this screen must write exactly what the CLI
   *  would write on the same master DB. */
  private autoEntries: Array<{ title: string; body: string; run: (apply: boolean) => Promise<string> }> = [];
  private autoIdx = 0;
  private autoBusy = false;
  private autoNotice = '';
  private autoLog: string[] = [];
  /** Signature of the last rendered list: an unchanged DB causes NO repaint
   *  (a 2 s full-screen rewrite is exactly the flicker this screen avoids). */
  private lastDataSig = '';
  /** When the data last actually changed — the header's freshness stamp. */
  private lastSyncAt = 0;

  constructor(private review: BankReview, private dbLabel: string, options: BankTuiOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.atomConfigPath = options.atomConfigPath ?? path.join(this.projectRoot, 'scripts', 'atoms.conf');
    this.masterDb = review.database;
    this.screen = blessed.screen({ smartCSR: true, fullUnicode: true, title: 'METROPOLIS · BANK REVIEW' });

    // 5 rows = 3 content lines (title / tabs / key hint) + borders. At height 3
    // the box clipped everything past the title, so the tab bar and its counts
    // were never on screen.
    this.header = blessed.box({
      parent: this.screen, top: 0, left: 0, width: '100%', height: 5,
      border: { type: 'line' }, tags: true,
    });
    this.list = blessed.list({
      parent: this.screen, top: 5, left: 0, width: '58%', height: '100%-15',
      border: { type: 'line' }, label: ' ITEMS ', tags: true,
      // NEGATIVE STRIP: the selected row is drawn as a solid inverse bar the
      // full width of the list, so "where am I" needs no squinting. Every item
      // string is padded to the inner width (renderList) — without that the
      // highlight only covers the text and the bar ends mid-row.
      style: { selected: { bg: 'white', fg: 'black' } },
    });
    this.detail = blessed.box({
      parent: this.screen, top: 5, left: '58%', width: '42%', height: '100%-15',
      border: { type: 'line' }, label: ' DETAIL ', tags: true, scrollable: true, alwaysScroll: true,
    });
    // NOT a blessed.textarea: its own source has `// TODO: Handle directional
    // keys`, so arrows are swallowed and the caret can only ever sit at the
    // end. The editor below is a plain box driven by our own buffer + caret
    // index (editBuf/editPos) — that is what lets the operator arrow back to
    // the one wrong word instead of retyping the answer.
    this.editor = blessed.box({
      parent: this.screen, top: '100%-10', left: 0, width: '100%', height: 5,
      border: { type: 'line' }, label: ' EDIT — F2/Ctrl-S = запиши · Esc = откажи ',
      tags: true, hidden: true,
    });
    this.keyBox = blessed.box({
      parent: this.screen, top: '100%-9', left: 0, width: '100%', height: 3,
      border: { type: 'line' }, label: ' KEY — Enter = запиши · Esc = откажи ',
      tags: false, hidden: true,
    });
    this.status = blessed.box({
      // 5 rows = 3 content lines (tally / message / hint) + the two borders.
      // At height 3 only the tally survived, so "запишано #…" and every
      // refusal reason were written to a row the operator could not see.
      parent: this.screen, top: '100%-5', left: 0, width: '100%', height: 5,
      border: { type: 'line' }, tags: true,
    });

    // EVERY key reaches this handler: the editor is a box, not a widget that
    // grabs input, so arrows/Home/End/Delete are ours to implement.
    this.screen.on('keypress', (ch: string | undefined, key: any) => this.onKey(ch, key));
    this.screen.on('resize', () => this.renderAll());
  }

  start(): void {
    this.reload();
    this.reloadFleetSources();
    // Master is the opening view. M opens the live machine/source selector.
    // Review rows stay on the workstation DB; remote DBs are snapshots that
    // stage only novel bank answers into this master.
    this.syncTimer = setInterval(() => this.syncNow(), 2000);
    this.syncTimer.unref?.();
  }

  /** Re-read the active category; repaint ONLY when something changed.
   *
   *  Selection follows the ROW, not the index: new queue turns arrive at the
   *  top, so an index-based refresh would silently slide the operator onto a
   *  different reply mid-read.
   */
  private syncNow(): void {
    if (this.mode !== 'browse') return;
    const cur = this.current();
    const keepId = cur ? this.oid(cur) : null;
    let items: ReviewItem[];
    try {
      items = this.loadItems();
    } catch {
      return; // a writer holds the lock this instant — retry on the next tick
    }
    const sig = this.sigOf(items);
    if (sig === this.lastDataSig) {
      // Nothing changed — the frame is already the truth. Refresh only the
      // freshness stamp, at most once a minute, so "синхр." cannot look stale
      // without repainting a 40-row screen every 2 s.
      if (Date.now() - this.lastSyncAt >= 60_000) {
        this.lastSyncAt = Date.now();
        this.renderHeader();
        this.screen.render();
      }
      return;
    }
    this.items = items;
    this.rows = this.buildRows();
    if (keepId) {
      const at = this.rows.findIndex(r => r.kind === 'item' && this.oid(r.item) === keepId);
      if (at >= 0) this.idx = at;
    }
    this.settleIdx();
    this.lastDataSig = sig;
    this.lastSyncAt = Date.now();
    this.renderAll();
  }

  /** Query the active category; K overrides the action target but never the
   *  source row's stored key. Keeping both lets the detail pane distinguish a
   *  retarget from the original frozen answer it must not rewrite. */
  private loadItems(): ReviewItem[] {
    return this.review.list(this.cat);
  }

  private sigOf(items: ReviewItem[]): string {
    return items.map(it => `${this.oid(it)}|${it.key ?? ''}|${it.text.length}|${it.status}|${it.createdAt}|${it.meta}`).join('\n');
  }

  /** Flatten the batch days into header + item rows, newest day first. */
  private buildRows(): ListRow[] {
    const out: ListRow[] = [];
    for (const batch of groupByDay(this.items)) {
      out.push({ kind: 'day', date: batch.date, count: batch.count });
      for (const item of batch.items) out.push({ kind: 'item', item });
    }
    return out;
  }

  /** Keep `idx` on a real row: a header can never be edited/approved/rejected. */
  private settleIdx(): void {
    if (this.rows.length === 0) { this.idx = 0; return; }
    this.idx = Math.max(0, Math.min(this.idx, this.rows.length - 1));
    if (this.rows[this.idx].kind === 'item') return;
    for (let j = this.idx; j < this.rows.length; j++) {
      if (this.rows[j].kind === 'item') { this.idx = j; return; }
    }
    for (let j = this.idx; j >= 0; j--) {
      if (this.rows[j].kind === 'item') { this.idx = j; return; }
    }
    this.idx = 0;
  }

  // ---------------- data / render ----------------

  private reload(keepIndex = true): void {
    const cur = this.current();
    const keepId = keepIndex && cur ? this.oid(cur) : null;
    try {
      this.items = this.loadItems();
    } catch (e) {
      this.items = [];
      this.message = `DB error: ${clean((e as Error).message)}`;
    }
    this.rows = this.buildRows();
    if (keepId) {
      const at = this.rows.findIndex(r => r.kind === 'item' && this.oid(r.item) === keepId);
      this.idx = at >= 0 ? at : 0;
    } else {
      this.idx = 0;
    }
    this.settleIdx();
    this.lastDataSig = this.sigOf(this.items);
    this.lastSyncAt = Date.now();
    this.renderAll();
  }

  /** Identity of a review row across reloads (ids repeat between tables). */
  private oid(it: { category: ReviewCategory; id: number }): string {
    return `${it.category}:${it.id}`;
  }

  private current(): ReviewItem | undefined {
    const row = this.rows[this.idx];
    return row && row.kind === 'item' ? row.item : undefined;
  }

  private renderAll(): void {
    if (this.mode === 'autos') { this.renderAutos(); this.screen.render(); return; }
    if (this.mode === 'fleet') {
      this.renderFleet();
      this.screen.render();
      return;
    }
    this.rows = this.buildRows();
    this.settleIdx();
    this.renderHeader();
    this.renderList();
    this.renderDetail();
    this.renderStatus();
    this.screen.render();
  }

  private renderHeader(): void {
    if (this.mode === 'fleet') { this.renderFleet(); return; }
    let counts: Record<ReviewCategory, number>;
    try { counts = this.review.counts(); } catch { counts = { enrichment: 0, dynamic: 0, staged: 0, active: 0 }; }
    const tabs = REVIEW_CATEGORIES.map((c, i) => {
      // DYNAMIC's badge is a pending-work count, not the size of its audit
      // history. Omit it at zero so retained processed captures are not shown
      // as \"0 to process\" while their gray rows remain visible below.
      const label = c === 'dynamic' && counts[c] === 0
        ? `${i + 1} ${LABEL[c]}`
        : `${i + 1} ${LABEL[c]} (${counts[c]})`;
      // blessed's tag is {inverse} — {reverse} is printed verbatim.
      return c === this.cat ? `{inverse} ${label} {/inverse}` : ` ${label} `;
    }).join(' · ');
    // Freshness is part of the header: which file, and when its state last
    // changed on screen. "live" means the poll is reading the same WAL the
    // writer uses — the operator never has to wonder if this is a copy.
    //
    // The DB is named by its path RELATIVE to the working directory: the
    // absolute path is ~100 columns here, which clipped exactly the stamp this
    // line exists to show (seen in the pty frame). A path outside the project
    // falls back to its basename.
    const stamp = this.lastSyncAt ? new Date(this.lastSyncAt).toTimeString().slice(0, 8) : '—';
    const rel = path.relative(process.cwd(), this.dbLabel);
    const shown = rel && !rel.startsWith('..') ? rel : path.basename(this.dbLabel);
    this.header.setContent(`{bold}METROPOLIS · BANK REVIEW{/bold}  MASTER ${safe(shown)}`
      + `  {green-fg}live · синхр. ${stamp}{/green-fg}\n${tabs}\n`
      + '{gray-fg}1–4/Tab категории · M машини/merge · P автопасс+Loop B · ↑/↓·PgUp/PgDn · E/F9 уреди · K клуч · A одобри · X одбиј · R освежи · Ctrl-Q излез{/gray-fg}');
  }

  private renderList(): void {
    if (this.mode === 'fleet') { this.renderFleet(); return; }
    const width = Math.max(20, Math.floor((this.screen.width || 100) * 0.58) - 4);
    // Short enough to FIT: the old legend was clipped mid-word at 120 columns,
    // so the one colour that matters (orange = code) never reached the screen
    // with its meaning attached.
    this.list.setLabel(' ITEMS — црвено · портокалово=код · сино=замрзнат ');
    this.list.setItems(this.rows.map(row => {
      if (row.kind === 'day') {
        // One header per generation day: the date and the size of that batch.
        // Ruled end-to-end so it reads as a divider, never as a selectable row.
        const label = `── ${dayLabel(row.date, row.count)} `;
        const padded = clip(label, width).padEnd(width, '─');
        return `{bold}{cyan-fg}${safe(padded)}{/cyan-fg}{/bold}`;
      }
      const it = row.item;
      const key = clip(this.keyOf(it), 24);
      // ENRICHMENT is a log: the row is identified by the QUESTION the turn
      // answered, and its state is a one-glyph mark (✓ digested, · pending,
      // ✗ refused) in front of the key.
      const mark = it.category === 'enrichment'
        ? it.flag === 'fail' ? '✗ ' : it.status === 'logged' ? '✓ ' : '· '
        : it.category === 'dynamic' && it.status === 'processed' ? '✓ ' : '';
      const subject = it.category === 'enrichment' ? oneLine(it.userMsg ?? '') || oneLine(it.text) : oneLine(it.text);
      const line = `${mark}#${it.id} ${key} · ${subject}`;
      // Padded to the inner width: the selection highlight is a bar, not a
      // ragged patch that stops at the last word.
      const padded = clip(line, width).padEnd(width, ' ');
      // WHOLE ROW COLOUR, not a tag: a refused turn is red end to end, a turn
      // whose answer is code-owned is orange end to end.
      // PROCESSED FAILURES REST GRAY: the verdict is recomputed from the
      // ORIGINAL reply text on every reload, so a refused row that has already
      // been pushed to STAGED (markEnriched → status 'logged') kept painting
      // red — the operator re-reviewed finished work and could not tell which
      // reds were still pending. They rest gray like processed dynamic
      // captures; the reason still shows in the detail pane.
      // A BANK-OWNED refusal paints ORANGE, not red: the pool already holds
      // the wording (duplicate/similarity refusal), so no E/push action can
      // change the serve — the fix is in the code lane that composed it
      // (#251/#252: budget-up asks served by the fixed price.negotiate lane).
      // Red stays for genuinely DIRTY text the operator can clean in place.
      if (it.composed && it.status !== 'logged') {
        // A composed serve (property-card batch, owner-relay ping) is never
        // client-voice learnable copy — even when it PASSES the text gates
        // (#244: the owner-bound counter relay validates as clean text and
        // still must not read as pending bankable work). Orange = code class.
        return orange(safe(padded));
      }
      if (it.flag === 'fail') {
        if (it.status === 'logged') return `{gray-fg}${safe(padded)}{/gray-fg}`;
        // Composed serves (property-card batches, owner-relay pings) share
        // the orange code class: their gate refusals name feed/protocol text,
        // not learnable copy.
        return (it.bankOwned || it.composed) ? orange(safe(padded)) : `{red-fg}${safe(padded)}{/red-fg}`;
      }
      // ORANGE IS FOR CODE ONLY: a key whose text exists nowhere but a
      // constant/function. A frozen key WITH a seed pool is bank material and
      // stays blue as before — painting every frozen key orange turned most of
      // this list orange and told the operator nothing.
      if (it.flag === 'key') {
        return isCodeConstant(this.keyOf(it)) ? orange(safe(padded)) : `{blue-fg}${safe(padded)}{/blue-fg}`;
      }
      // ACTIVE = live copy: green, whole row. A processed dynamic capture
      // remains in the audit list, but is dark gray like the merge instructions.
      if (it.category === 'active') return `{green-fg}${safe(padded)}{/green-fg}`;
      if (it.category === 'dynamic' && it.status === 'processed') return `{gray-fg}${safe(padded)}{/gray-fg}`;
      return safe(padded);
    }));
    this.list.select(this.idx);
  }

  private renderDetail(): void {
    if (this.mode === 'fleet') {
      const source = this.fleetSources[this.sourceIdx];
      this.detail.setContent(source ? `\n  SOURCE: ${safe(source.label)}\n\n  Current master: data/tui.db\n  Active source: ${safe(source.dbPath ?? source.note ?? 'unavailable')}\n\n  Only active bank key+answer pairs are compared.\n  New answers become STAGED in the master; none auto-serve.\n  Questions become retrieval examples only when approved.\n\n  Appliance export: data/lina.db\n  Atom sources: read-only SQLite backups over SSH\n\n  Deployment uses shared bank tables only; client history,\n  sessions and each machine’s enrichment queue stay local.` : 'No source selected');
      return;
    }
    const it = this.current();
    if (!it) {
      this.detail.setContent('\n  (нема записи во оваа категорија)');
      return;
    }
    const width = Math.max(24, Math.floor((this.screen.width || 100) * 0.42) - 6);
    const refused = it.flag === 'fail';
    const lines: string[] = [
      `#${it.id}  ${LABEL[it.category]} · ${it.status}`,
      `key: ${this.keyOf(it)}${it.category === 'dynamic' && it.key ? ` · group: ${it.key}` : ''}`,
      safe(it.meta),
    ];
    // EVIDENCE CHIPS (P5.2): the negative rules and the route tuple, replayed
    // where the operator decides — the veto the money lanes apply at serve
    // time, visible before an E/A/K decision touches the row.
    const chips = this.review.evidenceChips(it);
    if (chips.length > 0) lines.push(`{cyan-fg}${safe('ЕВИДЕНЦ: ' + chips.join(' · '))}{/cyan-fg}`);
    const key = it.key ?? this.review.suggestKey(it);
    const retargeted = !!this.keyOverrides.get(this.oid(it))
      && this.keyOverrides.get(this.oid(it)) !== it.key;
    // AUTO-RETARGET: no manual override, but the served key is frozen and the
    // question is capturable — say so instead of showing a dead frozen row.
    const autoRetarget = !this.keyOverrides.get(this.oid(it))
      && it.category === 'enrichment' && !!it.key
      && isExcludedFromEnrichment(it.key)
      && this.keyOf(it) !== it.key;
    const codeOwned = it.flag === 'key' && isCodeConstant(key);
    // RETARGET FIRST, refusal second: a re-homed question is the important
    // fact; the old (wrong) answer failing the gates is expected and is shown
    // under it as "rewrite the text", not as a dead row.
    if (retargeted || autoRetarget) {
      lines.push(retargeted
        ? `{green-fg}КЛИЕНТСКОТО ПРАШАЊЕ Е ПРЕНАСОЧЕНО → ${safe(this.keyOf(it))}{/green-fg}`
        : `{green-fg}ЗАМРЗНАТ ОДГОВОР — прашањето се преусвојува кон ${safe(this.keyOf(it))}{/green-fg}`,
        '{green-fg}E: внесете го вистинскиот одговор · A: стагирајте за проверка{/green-fg}');
      if (refused) lines.push(`{red-fg}ТЕКСТОТ СÈ УШТЕ НЕ ПОМИНУВА: ${safe(it.verdict ?? '')}{/red-fg}`);
    }
    else if (refused) lines.push(`{red-fg}REFUSED: ${safe(it.verdict ?? '')}{/red-fg}`);
    if ((it.bankOwned || it.composed) && it.status !== 'logged') {
      // The refusal's cause is not dirty learnable copy: bank-owned wording
      // (duplicate/similarity) or a composed serve (card batch / owner-relay
      // protocol). Name the actionable class up front — code side first).
      lines.push(orange(it.bankOwned
        ? 'ПОСТОЕЌКОВ ОТГОВОР — банката веќе ја има оваа формулација.'
        : 'КОМПОНУВАНО СЕРВИРАЊЕ (картачка/релеј протокол) — не се учи од овде.'),
        orange('Фиксот е во кодот (serve/податоци), не овде — или X за затворање.'));
    }
    else if (codeOwned) {
      // NAME THE SOURCE, not a refusal. The operator's complaint (2026-10-21):
      // a frozen row said "cannot edit" and offered a retarget that changes
      // nothing. The honest answer is where the text actually lives.
      const src = codeSourceFor(key);
      lines.push(orange(src ? `ВО КОДОТ: ${safe(src.file)} → ${safe(src.symbol)}` : 'ВО КОДОТ (локацијата не е мапирана)'));
      if (src?.note) lines.push(orange(safe(src.note)));
      lines.push(orange('E/A не го менуваат одговорот — се менува во кодот и се deploy-ира.'));
    } else if (it.flag === 'key') {
      // FROZEN, but with a seed pool: name the pool instead of promising a
      // retarget that would not change this answer.
      const src = codeSourceFor(key);
      lines.push(`{blue-fg}ЗАМРЗНАТ КЛУЧ: ${safe(it.verdict ?? '')}{/blue-fg}`,
        `{blue-fg}${safe(src ? `${src.file} → ${src.symbol}` : key)}{/blue-fg}`,
        '{blue-fg}E/A не го менуваат одговорот{/blue-fg}');
    }
    // The question that produced this wording: the corrected turn's row, the
    // key's examples, or the queue turns that reached this key.
    if (it.userMsg && it.category !== 'active' && it.category !== 'staged') lines.push('', 'QUESTION:', ...wrap(it.userMsg, width).map(safe));
    else if (it.userMsg) lines.push('', 'EXAMPLE QUESTION:', ...wrap(it.userMsg, width).map(safe));
    else {
      // Genuinely nowhere: not in this DB, and no sibling chat log remembers
      // the key either. Say which sources were checked so the blank is a fact.
      const src = this.review.questionSources(it);
      lines.push('', 'QUESTION: (нема запишано клиентско прашање)',
        `{gray-fg}проверено: bank_examples=${src.examples} · enrichment_queue=${src.queue} · note=${src.note ? 'да' : 'не'} · други бази=${src.sibling}{/gray-fg}`);
    }
    if (it.generationContext) {
      lines.push('', 'GENERATOR CONTEXT (not a client quote):',
        ...wrap(`Reference: ${it.generationContext.reference.join(' | ')}`, width).map(safe),
        ...wrap(`Instruction: ${it.generationContext.instruction}`, width).map(safe));
    }
    lines.push('', it.category === 'active' ? 'SERVING TEXT:' : 'TEXT:');
    const body = wrap(it.text, width).map(safe);
    if (refused) lines.push(`{red-fg}${body.join('\n')}{/red-fg}`);
    else if (it.category === 'active') lines.push(`{green-fg}${body.join('\n')}{/green-fg}`);
    else lines.push(...body);
    if (it.category === 'active' && !codeOwned) lines.push('', '(E = замени текстот (стариот се retire-ира) · X = retire)');
    this.detail.setContent(lines.join('\n'));
    this.detail.setScrollPerc(0);
  }

  private renderStatus(): void {
    if (this.mode === 'fleet') {
      this.status.setContent(`{gray-fg}${this.fleetBusy ? 'Working…' : 'Tab/↑↓ Enter=select · S=snapshot · E=export lina.db · P=deploy · Esc=back'}{/gray-fg}\n${safe(this.fleetNotice)}\n{gray-fg}Source pending answers count excludes existing master key+answer matches{/gray-fg}`);
      return;
    }
    let counts: Record<ReviewCategory, number>;
    try { counts = this.review.counts(); } catch { counts = { enrichment: 0, dynamic: 0, staged: 0, active: 0 }; }
    const tally = REVIEW_CATEGORIES.map(c => `${LABEL[c]}=${counts[c]}`).join(' · ');
    const pos = this.rows.slice(0, this.idx + 1).filter(r => r.kind === 'item').length;
    const hint = this.mode === 'edit'
      ? 'EDIT: typing goes into the reply · F2/Ctrl-S=запиши · Esc=откажи'
      : this.mode === 'key'
        ? 'KEY: Enter=запиши · Esc=откажи'
        : `${pos}/${this.items.length} · E/F9=${this.cat === 'active' ? 'замени' : 'уреди'} · K=клуч · A=${this.cat === 'staged' ? 'одобри' : this.cat === 'active' ? '—' : 'пушти во банка'} · X=${this.cat === 'active' ? 'retire' : 'одбиј'}`;
    this.status.setContent(`{gray-fg}${tally}{/gray-fg}\n${safe(this.message)}\n{gray-fg}${hint}{/gray-fg}`);
  }

  // ---------------- keys ----------------

  private onKey(ch: string | undefined, key: any): void {
    const name = key?.name;

    // Quit always works, including from the editor (nothing is auto-saved).
    if (key?.ctrl && name === 'q') { this.quit(); return; }

    if (this.mode === 'edit') {
      if (name === 'escape') { this.cancelEdit(); return; }
      if (name === 'f2' || (key?.ctrl && name === 's')) { this.saveEdit(); return; }
      const lines = editLayout(this.editBuf, this.editorWidth());
      const cur = caretLine(lines, this.editPos);
      if (name === 'left') this.editPos = Math.max(0, this.editPos - 1);
      else if (name === 'right') this.editPos = Math.min(this.editBuf.length, this.editPos + 1);
      else if (name === 'home') this.editPos = lines[cur].start;
      else if (name === 'end') this.editPos = lines[cur].end;
      else if (name === 'up' || name === 'down') {
        this.editPos = moveVertical(lines, this.editPos, name === 'up' ? -1 : 1);
      } else if (name === 'backspace') {
        if (this.editPos > 0) {
          this.editBuf = this.editBuf.slice(0, this.editPos - 1) + this.editBuf.slice(this.editPos);
          this.editPos--;
        }
      } else if (name === 'delete') {
        if (this.editPos < this.editBuf.length) {
          this.editBuf = this.editBuf.slice(0, this.editPos) + this.editBuf.slice(this.editPos + 1);
        }
      } else if (name === 'enter') {
        this.editBuf = this.editBuf.slice(0, this.editPos) + '\n' + this.editBuf.slice(this.editPos);
        this.editPos++;
      } else if (key?.ctrl && name === 'u') {
        this.editBuf = '';
        this.editPos = 0;
      } else if (ch && !key?.ctrl && !key?.meta) {
        this.editBuf = this.editBuf.slice(0, this.editPos) + ch + this.editBuf.slice(this.editPos);
        this.editPos += ch.length;
      }
      this.renderEditor();
      this.screen.render();
      return;
    }

    if (this.mode === 'key') {
      if (name === 'enter') { this.saveKey(); return; }
      if (name === 'escape') { this.cancelKey(); return; }
      if (key?.ctrl && name === 'u') this.keyBuf = '';
      else if (name === 'backspace') this.keyBuf = this.keyBuf.slice(0, -1);
      else if (ch && !key.ctrl && !key.meta) this.keyBuf += ch;
      this.keyBox.setContent(`KEY: ${this.keyBuf}█`);
      this.screen.render();
      return;
    }

    if (this.mode === 'fleet') { void this.onFleetKey(ch, key); return; }
    if (this.mode === 'autos') { void this.onAutosKey(ch, key); return; }
    if (name === 'q') { this.quit(); return; }
    if (name === 'm') { this.openFleet(); return; }
    if (name === 'p') { this.openAutos(); return; }
    if (ch === '1' || ch === '2' || ch === '3' || ch === '4') {
      this.setCategory(REVIEW_CATEGORIES[Number(ch) - 1]);
      return;
    }
    if (name === 'tab') {
      const i = REVIEW_CATEGORIES.indexOf(this.cat);
      this.setCategory(REVIEW_CATEGORIES[(i + 1) % REVIEW_CATEGORIES.length]);
      return;
    }
    if (name === 'up') this.move(-1);
    else if (name === 'down') this.move(1);
    else if (name === 'pageup') this.move(-10);
    else if (name === 'pagedown') this.move(10);
    else if (name === 'e' || name === 'f9' || name === 'enter') this.startEdit();
    else if (name === 'a') this.approveOrPush();
    else if (name === 'x') this.rejectWithConfirm();
    else if (name === 'k') this.startKey();
    else if (name === 'r') {
      // MANUAL refresh bypasses the 30 s cross-DB question cache too: if the
      // operator presses R, they mean "read everything again now", not "redraw
      // what you already had".
      clearProvenanceCache();
      this.message = 'освежено';
      this.reload();
    }
  }

  private setCategory(c: ReviewCategory): void {
    if (c === this.cat) return;
    this.cat = c;
    this.idx = 0;
    this.confirm = null;
    this.message = '';
    this.reload(false);
  }

  private move(delta: number): void {
    if (this.items.length === 0) return;
    // Step over the date headers: they are dividers, not rows you act on.
    const dir = Math.sign(delta);
    let i = this.idx;
    for (let step = 0; step < Math.abs(delta); step++) {
      let j = i + dir;
      while (j >= 0 && j < this.rows.length && this.rows[j].kind !== 'item') j += dir;
      if (j < 0 || j >= this.rows.length) break;
      i = j;
    }
    this.idx = i;
    this.confirm = null;
    this.renderAll();
  }

  // ---------------- edit ----------------

  /** The key an action would use for this row. */
  private keyOf(it: ReviewItem): string {
    const override = this.keyOverrides.get(this.oid(it));
    if (override) return override;
    // The service owns the routing-open rule: a frozen ORIGINAL key on a queue
    // turn suggests a learn.* target (the question is capturable); code-owned
    // and data-carried keys keep their own key.
    return this.review.suggestKey(it);
  }

  /** True when the served wording is code: no edit here can change it. */
  private isCodeOwned(it: ReviewItem): boolean {
    return isExcludedFromEnrichment(this.keyOf(it));
  }

  /** Refuse BEFORE the editor opens, naming the file/constant.
   *  Refusing after the operator typed a fix threw the work away silently. */
  private refuseCodeOwned(it: ReviewItem, verb: string): boolean {
    if (!this.isCodeOwned(it)) return false;
    const key = this.keyOf(it);
    const src = codeSourceFor(key);
    const where = src ? `${src.file} → ${src.symbol}` : key;
    this.message = `${isCodeConstant(key) ? 'ВО КОДОТ' : 'ЗАМРЗНАТ'}: ${where} — ${verb} не го менува одговорот (клуч ${key})`;
    this.renderStatus();
    this.screen.render();
    return true;
  }

  private startEdit(): void {
    const it = this.current();
    if (!it) return;
    if (it.category === 'dynamic' && it.status === 'processed') {
      this.message = 'DYNAMIC capture е веќе обработен — сивата историја не се уредува.';
      this.renderStatus();
      this.screen.render();
      return;
    }
    if (this.refuseCodeOwned(it, 'E')) return;
    if (it.category === 'active') {
      const kerr = validateBankKey(this.suggestedKey(it));
      if (kerr) {
        this.message = `НЕ Е УРЕДЛИВО: ${kerr}`;
        this.renderStatus();
        this.screen.render();
        return;
      }
    }
    this.mode = 'edit';
    this.editBuf = it.text;
    this.editPos = this.editBuf.length;
    this.editor.show();
    this.message = it.category === 'active'
      ? `замена на ACTIVE #${it.id} — стариот се retire-ира, новиот служи веднаш`
      : `уредување #${it.id} — ${LABEL[it.category]}`;
    this.editor.setLabel(` EDIT #${it.id} (${LABEL[it.category]}) — F2/Ctrl-S = запиши · Esc = откажи · ↑↓←→ Home/End `);
    this.renderEditor();
    this.renderStatus();
    this.screen.render();
  }

  private suggestedKey(it: ReviewItem): string {
    return it.key ?? this.review.suggestKey(it);
  }

  /** Edit viewport: 3 content rows (the box is 5 with its borders). */
  private editorWidth(): number {
    return Math.max(20, (Number(this.screen.width) || 100) - 6);
  }

  /** Paint the buffer with an inverse caret block at editPos.
   *  Layout/caret math lives in editModel.ts so it is unit-tested. */
  private renderEditor(): void {
    const lines = editLayout(this.editBuf, this.editorWidth());
    const cur = caretLine(lines, this.editPos);
    const visible = 3;
    const from = Math.max(0, Math.min(cur - 1, Math.max(0, lines.length - visible)));
    const out: string[] = [];
    for (let i = from; i < Math.min(lines.length, from + visible); i++) {
      const l = lines[i];
      out.push(i === cur
        ? paintCaret(l, this.editBuf, this.editPos)
        : safe(this.editBuf.slice(l.start, l.end)));
    }
    this.editor.setContent(out.join('\n'));
  }

  private saveEdit(): void {
    const it = this.current();
    if (!it) return this.cancelEdit();
    const r = this.review.edit(it, this.editBuf, this.keyOverrides.get(this.oid(it)));
    if (!r.ok) {
      this.message = `НЕ Е ЗАПИШАНО: ${r.reason}`;
      this.renderStatus();
      this.screen.render();
      return; // keep the editor open with the text intact
    }
    const wasActive = it.category === 'active';
    this.cancelEdit();
    this.message = wasActive
      ? `ЗАМЕНЕТО #${it.id} → ${r.key ?? it.key} (стариот retire-иран, новиот служи)`
      : `запишано #${it.id}${r.key ? ` → ${r.key}` : ''}`;
    this.reload();
  }

  private cancelEdit(): void {
    this.mode = 'browse';
    this.editBuf = '';
    this.editPos = 0;
    this.editor.hide();
    this.renderAll();
  }

  // ---------------- key ----------------

  private startKey(): void {
    const it = this.current();
    if (!it) return;
    if (it.category === 'dynamic' && it.status === 'processed') {
      this.message = 'DYNAMIC capture е веќе обработен — сивата историја не се пренасочува.';
      this.renderStatus();
      this.screen.render();
      return;
    }
    // A code-composed/data-carried answer cannot be redirected: the deterministic
    // lane will still own it. A seeded frozen pool (fee/contact policy), however,
    // is an answer policy rather than a unique routing function; ENRICHMENT may
    // retarget that QUESTION to its own learn.* route without changing the pool.
    const sourceKey = it.key ?? '';
    const canRetargetFrozenQuestion = it.category === 'enrichment'
      && FROZEN_BANK_KEYS.has(sourceKey)
      && !DATA_DRIVEN_KEYS.has(sourceKey)
      && !isCodeConstant(sourceKey);
    if (this.isCodeOwned(it) && !canRetargetFrozenQuestion) {
      this.refuseCodeOwned(it, 'K');
      return;
    }
    if (it.category !== 'enrichment' && it.category !== 'dynamic') {
      this.message = 'K е достапно за ENRICHMENT и DYNAMIC (STAGED/ACTIVE веќе имаат клуч).';
      this.renderStatus();
      this.screen.render();
      return;
    }
    this.mode = 'key';
    this.keyBuf = this.keyOf(it);
    this.keyBox.setContent(`KEY: ${this.keyBuf}█`);
    this.keyBox.show();
    this.message = `клуч за #${it.id}`;
    this.renderStatus();
    this.screen.render();
  }

  private saveKey(): void {
    const it = this.current();
    if (!it) return this.cancelKey();
    const originalKey = this.keyOverrides.get(this.oid(it))
      ?? (it.key && !it.key.startsWith('dynamic:') ? it.key : this.review.suggestKey(it));
    const err = validateBankKey(this.keyBuf.trim());
    if (err) {
      this.message = `НЕ Е ЗАПИШАН КЛУЧ: ${err}`;
      this.renderStatus();
      this.screen.render();
      return; // keep the key box open
    }
    it.key = this.keyBuf.trim();
    this.keyOverrides.set(this.oid(it), it.key);
    this.cancelKey();
    this.message = `#${it.id} · ${originalKey} → ${it.key}`;
    this.reload();
  }

  private cancelKey(): void {
    this.mode = 'browse';
    this.keyBox.hide();
    this.renderAll();
  }

  // ---------------- actions ----------------

  private approveOrPush(): void {
    const it = this.current();
    if (!it) return;
    if (this.refuseCodeOwned(it, 'A')) return;
    if (it.category === 'dynamic' && it.status === 'processed') {
      this.message = 'DYNAMIC capture е веќе обработен — останува само како сива историја.';
      this.renderStatus();
      this.screen.render();
      return;
    }
    if (it.category === 'active') {
      this.message = 'ACTIVE не се одобрува (A = —). E го заменува, X го retire-ира.';
      this.renderStatus();
      this.screen.render();
      return;
    }
    if (it.category === 'staged') {
      const r = this.review.approve(it);
      const sourceId = sourceIdFromImportNote(it.meta);
      if (r.ok && sourceId && it.key) markImportDecision(this.masterDb!, sourceId, it.key, it.text, 'approved');
      this.message = r.ok ? `ОДОБРЕНО → ${it.key} (serving)` : `НЕ Е ОДОБРЕНО: ${r.reason}`;
      if (r.ok) this.reload();
      else { this.renderStatus(); this.screen.render(); }
      return;
    }
    const key = this.keyOf(it);
    const r = this.review.push(it, key, it.text);
    if (r.ok) {
      // The queue row is done — its chosen key must not leak onto a later row.
      this.keyOverrides.delete(this.oid(it));
      this.message = `СТАГИРАНО → ${key} (одобри во STAGED)`;
      this.reload();
    } else {
      this.message = `НЕ Е СТАГИРАНО: ${r.reason}`;
      this.renderStatus();
      this.screen.render();
    }
  }

  private rejectWithConfirm(): void {
    const it = this.current();
    if (!it) return;
    const now = Date.now();
    if (!this.confirm || this.confirm.id !== it.id || now - this.confirm.at > 3000) {
      this.confirm = { at: now, id: it.id };
      this.message = it.category === 'staged'
        ? 'повторно X = ОТФРЛИ (брише staged) — 3s'
        : it.category === 'active'
          ? 'повторно X = RETIRE (може да се врати) — 3s'
          : it.category === 'dynamic'
            ? 'повторно X = ИЗБРИШИ динамичен запис — 3s'
            : 'повторно X = ОТФРЛИ од редицата — 3s';
      this.renderStatus();
      this.screen.render();
      return;
    }
    this.confirm = null;
    const r = this.review.reject(it);
    const sourceId = sourceIdFromImportNote(it.meta);
    if (r.ok && it.category === 'staged' && sourceId && it.key) markImportDecision(this.masterDb!, sourceId, it.key, it.text, 'rejected');
    if (r.ok) {
      this.keyOverrides.delete(this.oid(it));
      this.message = it.category === 'active' ? `RETIRED #${it.id}` : `ОТФРЛЕНО #${it.id}`;
      this.reload();
    } else {
      this.message = `НЕ УСПЕА: ${r.reason}`;
      this.renderStatus();
      this.screen.render();
    }
  }

  // ---------------- fleet source selector ----------------

  private reloadFleetSources(): void {
    let config = '';
    try { config = fs.readFileSync(this.atomConfigPath, 'utf8'); } catch (e) {
      this.fleetNotice = `Cannot read scripts/atoms.conf: ${(e as Error).message}`;
    }
    this.fleetSources = buildFleetSources(config, this.projectRoot);
    this.sourcePending.clear();
    for (const source of this.fleetSources) {
      if (source.dbPath && fs.existsSync(source.dbPath)) {
        let sourceDb: Database.Database | null = null;
        try {
          sourceDb = new Database(source.dbPath, { readonly: true, fileMustExist: true });
          this.sourcePending.set(source.id, countSourceApprovals(sourceDb, this.masterDb!, source.id));
        } catch { this.sourcePending.set(source.id, 0); }
        finally { sourceDb?.close(); }
      } else this.sourcePending.set(source.id, 0);
    }
  }

  private openFleet(): void {
    if (this.mode !== 'browse') return;
    this.mode = 'fleet';
    this.reloadFleetSources();
    this.sourceIdx = 0;
    this.fleetNotice = 'WORKSTATION1 MASTER (data/tui.db) is open. Atom exports are read-only sources; each Enter stages only unseen answers.';
    this.renderAll();
  }

  private renderFleet(): void {
    const rows = this.fleetSources.map((source, index) => {
      const n = this.sourcePending.get(source.id) ?? 0;
      const availability = source.id === 'tui'
        ? (source.configured ? 'READY' : 'MISSING DB')
        : source.configured ? `configured${source.dbPath && fs.existsSync(source.dbPath) ? ' · snapshot ready' : ' · fetch on Enter'}` : 'not provisioned/configured';
      const label = `${source.label}  · ${availability} · pending approval: ${n}`;
      const safeLabel = safe(label);
      if (!source.configured) return `{gray-fg} ${safeLabel} {/gray-fg}`;
      return index === this.sourceIdx ? `{inverse} ${safeLabel} {/inverse}` : ` ${safeLabel} `;
    });
    this.header.setContent('{bold}LINA BANK · SOURCE SELECTOR{/bold}  MASTER: data/tui.db\n'
      + '{gray-fg}Tab/↑↓ Enter=select · S=snapshot · E=export lina.db · P=deploy · Esc=back{/gray-fg}');
    this.list.setLabel(' MACHINES / SOURCES ');
    this.list.setItems(rows.length ? rows : ['No sources configured']);
    this.list.select(this.sourceIdx);
    this.detail.setContent(`\n  MASTER DATABASE: data/tui.db\n  APPLIANCE EXPORT: data/lina.db\n\n  Only bank_variants and bank_examples are shared.\n  Client sessions, appointments and enrichment queues remain\n  local to each machine.\n\n  Import stages unmatched key+answer pairs; approval happens\n  in STAGED on the master. Nothing from a source auto-serves.`);
    const selectorHint = this.fleetBusy ? 'Working…' : 'Tab/↑↓ Enter=select · S=snapshot · E=export lina.db · P=deploy · Esc=back';
    this.status.setContent(selectorHint + '\n' + safe(this.fleetNotice) + '\nCounts are remaining unseen bank answers.');
  }

  private async onFleetKey(ch: string | undefined, key: any): Promise<void> {
    if (this.fleetBusy) return;
    const name = key?.name;
    if (name === 'escape' || name === 'm' || name === 'q') {
      this.mode = 'browse'; this.fleetNotice = ''; this.renderAll(); return;
    }
    if (name === 'up' || name === 'down' || name === 'tab') {
      const dir = name === 'up' ? -1 : 1;
      this.sourceIdx = (this.sourceIdx + dir + this.fleetSources.length) % this.fleetSources.length;
      this.renderAll(); return;
    }
    if (name === 's') {
      this.fleetBusy = true; this.fleetNotice = 'Saving consistent, dated master DB copy…'; this.renderAll();
      try {
        const file = await saveDatedMasterSnapshot(this.masterDb!, this.projectRoot);
        this.fleetNotice = `Master snapshot saved and integrity-checked: ${path.relative(this.projectRoot, file)}`;
      } catch (e) { this.fleetNotice = `Snapshot failed: ${(e as Error).message}`; }
      this.fleetBusy = false; this.renderAll(); return;
    }
    if (name === 'p') { await this.deploySharedBank(); return; }
    if (name === 'e') { await this.exportApplianceDatabase(); return; }
    if (name !== 'enter') return;
    const source = this.fleetSources[this.sourceIdx];
    if (!source) return;
    if (source.id === 'tui') {
      if (!source.dbPath || !fs.existsSync(source.dbPath)) {
        this.fleetNotice = `TUI source DB missing: ${source.dbPath ?? 'data/tui.db'}`;
        this.renderAll(); return;
      }
      // TUI is the first source, not an overwrite: differences are staged in
      // the master and nothing enters the serve path without explicit approval.
      this.fleetBusy = true; this.fleetNotice = 'Comparing TUI bank answers with master; staging only unseen pairs…'; this.renderAll();
      let sourceDb: Database.Database | null = null;
      try {
        sourceDb = new Database(source.dbPath, { readonly: true, fileMustExist: true });
        const report = stageMissingBankRows(sourceDb, this.masterDb!, 'tui');
        this.fleetNotice = `TUI source reviewed: ${report.added} new answer(s) staged · ${report.duplicates} already in master · ${report.excluded} protected/code keys skipped. Approve under STAGED.`;
        this.reload();
        this.reloadFleetSources();
      } catch (e) { this.fleetNotice = `TUI merge failed: ${(e as Error).message}`; }
      finally { sourceDb?.close(); }
      this.fleetBusy = false; this.renderAll(); return;
    }
    this.fleetBusy = true; this.fleetNotice = `${source.label}: fetching a consistent SQLite snapshot…`; this.renderAll();
    try {
      const atom = parseAtomSources(fs.readFileSync(this.atomConfigPath, 'utf8')).find(item => item.id === source.id);
      if (!atom) throw new Error('atom missing from scripts/atoms.conf');
      const snapshot = await fetchAtomSnapshot(atom, this.projectRoot);
      const sourceDb = new Database(snapshot, { readonly: true, fileMustExist: true });
      let report;
      let imported = { added: 0, duplicates: 0 };
      try {
        report = stageMissingBankRows(sourceDb, this.masterDb!, source.id);
        imported = importSourceEnrichmentLog(sourceDb, this.masterDb!, source.id);
      } finally { sourceDb.close(); }
      source.dbPath = snapshot;
      source.configured = true;
      const countDb = new Database(snapshot, { readonly: true, fileMustExist: true });
      try { this.sourcePending.set(source.id, countSourceApprovals(countDb, this.masterDb!, source.id)); }
      finally { countDb.close(); }
      this.fleetNotice = `${source.label}: ${report.added} staged for approval · ${report.duplicates} existing · ${report.excluded} protected/code keys skipped; ${imported.added} audit rows imported (${imported.duplicates} duplicates). Review bank answers in STAGED.`;
      this.reload(); this.reloadFleetSources();
    } catch (e) { this.fleetNotice = (e as Error).message; }
    this.fleetBusy = false; this.renderAll();
  }

  // ---------------- P menu: auto-passes + Loop B ----------------
  /**
   * THE COMMANDS, NOT A REIMPLEMENTATION. Each entry calls the same runner
   * the CLI scripts call (src/bank/autoPass.ts, src/bank/loopB.ts), so the
   * dry report AND the apply write are identical to:
   *   npm run bank:autoreject [-- --apply]
   *   npm run bank:rekey [-- --apply]
   *   npm run bank:relearn -- --from-corrections [-- --dry]
   * …on this master DB. The audit trail cannot diverge between the screen
   * and the shell, because there is only one write path.
   */
  private buildAutoEntries(): void {
    const review = this.review;
    this.autoEntries = [
      {
        title: 'PASS 1 · AUTO-REJECT — genre-mismatched serves → bank_corrections (new)',
        body: 'Money-lane keys that served a RESOLVED price evaluation are dismissed\n  from the pending queue and recorded as corrections — the Loop-B signal\n  survives, unlike the X. Provable mismatches only; the rest stay with you.',
        run: async (apply) => {
          const r = runAutoReject(review, { apply });
          this.autoLog = r.lines;
          return [`${r.affected}/${r.total} pending row(s) ${apply ? 'BOUNCED → bank_corrections' : 'would bounce'}`, ...r.lines].join('\n');
        },
      },
      {
        title: 'PASS 2 · AUTO-REKEY — wording that validates under the resolved key → STAGED',
        body: 'The SAME guard chain the review screen applies for A (suggestKey →\n  flags → validateBankKey → push). Flagged rows stay visible; nothing\n  rewrites a key by force. Reverse an auto-stage with X under STAGED.',
        run: async (apply) => {
          const r = runRekey(review, { apply });
          this.autoLog = r.lines;
          return [`${r.affected}/${r.total} pending row(s) ${apply ? 'STAGED → review under STAGED' : 'would stage'}`, ...r.lines].join('\n');
        },
      },
      {
        title: 'LOOP B · RELEARN BATCH — every NEW correction regenerates its key (strict Gemini → STAGED)',
        body: 'One job per key, newest correction as the signal. Constraint-gated\n  candidates land STAGED; failed keys stay NEW for a retry. Needs the LLM\n  configured — run the DRY first when unsure of the plan.',
        run: async (apply) => {
          const log: string[] = [];
          const r = await relearnFromCorrections(new BankStore(review.database), {
            apply,
            limit: 10,
            log: (line: string) => log.push(line),
          });
          const head = `${r.jobs} job(s) · ok=${r.ok} · failed=${r.failed} · staged=${r.staged}${apply ? '' : ' (DRY)'}`;
          this.autoLog = [head, ...log];
          return this.autoLog.join('\n');
        },
      },
    ];
  }

  private openAutos(): void {
    if (this.autoEntries.length === 0) this.buildAutoEntries();
    this.mode = 'autos';
    this.autoIdx = 0;
    this.autoNotice = 'Enter = DRY (a pure report) · a = APPLY. The apply writes exactly what the dry listed.';
    this.renderAll();
  }

  private async onAutosKey(ch: string | undefined, key: any): Promise<void> {
    if (this.autoBusy) return;
    const name = key?.name;
    if (name === 'escape' || name === 'q' || name === 'p' || name === 'm') {
      this.mode = 'browse'; this.autoNotice = ''; this.autoLog = []; this.renderAll(); return;
    }
    if (name === 'up' || name === 'down' || name === 'tab') {
      const dir = name === 'up' ? -1 : 1;
      this.autoIdx = (this.autoIdx + dir + this.autoEntries.length) % this.autoEntries.length;
      this.renderAll(); return;
    }
    const entry = this.autoEntries[this.autoIdx];
    if (!entry) return;
    if (name === 'enter') { await this.runAutoEntry(entry, false); return; }
    if (ch === 'a') { await this.runAutoEntry(entry, true); return; }
  }

  private async runAutoEntry(entry: { title: string; run: (apply: boolean) => Promise<string> }, apply: boolean): Promise<void> {
    if (this.autoBusy) return;
    this.autoBusy = true;
    this.autoNotice = `${apply ? 'APPLY' : 'DRY'} — running ${entry.title} …`;
    this.renderAll();
    try {
      this.autoNotice = await entry.run(apply);
    } catch (e) {
      this.autoNotice = `FAILED: ${(e as Error).message}`;
    }
    this.autoBusy = false;
    this.renderAll();
  }

  private renderAutos(): void {
    const rel = path.relative(process.cwd(), this.dbLabel);
    const shown = rel && !rel.startsWith('..') ? rel : path.basename(this.dbLabel);
    this.header.setContent('{bold}METROPOLIS · AUTO-PASSES (P){/bold}  MASTER ' + safe(shown) + '\n'
      + '{gray-fg}↑↓/Tab=select · Enter=DRY · a=APPLY · Esc=back · Ctrl-Q излез{/gray-fg}');
    this.list.setLabel(' COMMANDS — the same runners the CLI scripts call ');
    this.list.setItems(this.autoEntries.map((entry, index) => (
      index === this.autoIdx ? `{inverse} ${safe(entry.title)} {/inverse}` : ` ${safe(entry.title)} `
    )));
    this.list.select(this.autoIdx);
    const entry = this.autoEntries[this.autoIdx];
    const result = this.autoLog.length
      ? ['  LAST RESULT:', ...this.autoLog.slice(-12).map(l => '  ' + safe(l))]
      : ['  (not run in this session)', '  ' + safe(this.autoNotice)];
    this.detail.setContent(`\n  ${safe(entry?.title ?? '')}\n\n  ${safe(entry?.body ?? '')}\n\n${result.join('\n')}`);
    this.status.setContent((this.autoBusy ? 'Working…' : '↑↓ select · Enter=DRY · a=APPLY · Esc=back')
      + '\n' + safe(this.autoNotice)
      + '\n{gray-fg}Apply writes the same tables as the CLI on this master DB.{/gray-fg}');
  }

  private async exportApplianceDatabase(): Promise<void> {
    if (!this.masterDb) { this.fleetNotice = 'Master DB handle is not available.'; this.renderAll(); return; }
    this.fleetBusy = true;
    this.fleetNotice = 'Backing up current data/lina.db and exporting reviewed shared bank…';
    this.renderAll();
    try {
      const output = await exportLinaDatabase(this.masterDb, path.join(this.projectRoot, 'data', 'lina.db'));
      this.fleetNotice = `Appliance export ready: ${path.relative(this.projectRoot, output.path)} (${output.variants} variants, ${output.examples} examples). Previous DB backed up.`;
    } catch (e) {
      this.fleetNotice = `Appliance export failed: ${(e as Error).message}`;
    }
    this.fleetBusy = false;
    this.renderAll();
  }

  private async deploySharedBank(): Promise<void> {
    const pending = this.masterDb?.db.prepare("SELECT COUNT(*) AS n FROM bank_variants WHERE lifecycle='staged'").get() as { n: number } | undefined;
    if (pending?.n) {
      this.fleetNotice = `Not deployed: ${pending.n} staged answer(s) still need approval.`;
      this.renderAll(); return;
    }
    if (!this.masterDb) { this.fleetNotice = 'Master DB handle is not available.'; this.renderAll(); return; }
    this.fleetBusy = true; this.fleetNotice = 'Saving the current master before shared-bank deployment…'; this.renderAll();
    try {
      const backup = await saveDatedMasterSnapshot(this.masterDb!, this.projectRoot);
      const tuiPath = path.join(this.projectRoot, 'data', 'tui.db');
      const masterPath = this.masterDb!.file === ':memory:' ? null : path.resolve(this.masterDb!.file);
      if (fs.existsSync(tuiPath) && path.resolve(tuiPath) !== masterPath) {
        const tuiDb = new Db(tuiPath);
        try {
          const before = await saveDatedDatabaseSnapshot(tuiDb.db, this.projectRoot, 'lina-tui-before-sync');
          const synced = syncSharedBank(this.masterDb!, tuiDb);
          this.fleetNotice = `TUI bank synchronized (${synced.variants} variants); local TUI sessions/queues preserved. Backup: ${path.relative(this.projectRoot, before)}`;
        } finally { tuiDb.close(); }
      }
      const config = fs.readFileSync(this.atomConfigPath, 'utf8');
      const sources = parseAtomSources(config).filter(atom => atom.configured);
      const failures: string[] = [];
      const bankVariants = this.masterDb!.db.prepare("SELECT key,text,source,created_at,lifecycle,note FROM bank_variants WHERE lifecycle='active'").all() as Array<{key:string;text:string;source:string;created_at:number;lifecycle:string;note:string|null}>;
      const bankExamples = this.masterDb!.db.prepare('SELECT key,msg,created_at FROM bank_examples').all() as Array<{key:string;msg:string;created_at:number}>;
      for (const atom of sources) {
        const keyBase = atom.keyToken!.replace(/_KEY$/, '').toLowerCase().replace(/_/g, '');
        const key = path.join(os.homedir(), '.ssh', `id_ed25519_${keyBase}`);
        if (!fs.existsSync(key)) { failures.push(`${atom.id}: SSH key missing`); continue; }
        const target = `${atom.user}@${atom.host}`;
        const stamp = Date.now();
        const sqlPath = path.join(this.projectRoot, 'data', 'master-snapshots', `bank-${atom.id}-${stamp}.sql`);
        let remoteSql = false;
        try {
          const args = ['-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=8','-i',key];
          const escapedRemotePath = atom.remotePath!.replace(/'/g, "'\\''");
          await execFileAsync('ssh', [...args, target, `cd '${escapedRemotePath}' && sqlite3 data/lina.db '.backup data/lina.db.bak-bank-deploy-${stamp}'`], { timeout: 20_000 });
          // Replace only shared bank tables inside one remote transaction;
          // atom-local sessions, appointments and enrichment queues stay local.
          const q=(x:string)=>`'${x.replace(/'/g,"''")}'`;
          const sql=['BEGIN IMMEDIATE;','DELETE FROM bank_variants;','DELETE FROM bank_examples;',...bankVariants.map(v=>`INSERT INTO bank_variants(key,text,source,created_at,lifecycle,note) VALUES(${q(v.key)},${q(v.text)},${q(v.source)},${v.created_at},${q(v.lifecycle)},${v.note===null?'NULL':q(v.note)});`),...bankExamples.map(e=>`INSERT INTO bank_examples(key,msg,created_at) VALUES(${q(e.key)},${q(e.msg)},${e.created_at});`),'COMMIT;'].join('\n');
          fs.writeFileSync(sqlPath,sql,{mode:0o600});
          await execFileAsync('scp',['-q',...args,sqlPath,`${target}:/tmp/lina-bank-${stamp}.sql`],{timeout:30_000});
          remoteSql = true;
          await execFileAsync('ssh', [...args, target, `cd '${escapedRemotePath}' && sqlite3 data/lina.db < /tmp/lina-bank-${stamp}.sql`], { timeout: 30_000 });
          await execFileAsync('ssh', [...args, target, `rm -f /tmp/lina-bank-${stamp}.sql`], { timeout: 10_000 });
          remoteSql = false;
          fs.rmSync(sqlPath,{force:true});
        } catch (error) {
          fs.rmSync(sqlPath,{force:true});
          if (remoteSql) {
            const args = ['-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=8','-i',key];
            void execFileAsync('ssh',[...args,target,`rm -f /tmp/lina-bank-${stamp}.sql`],{timeout:5_000}).catch(()=>undefined);
          }
          failures.push(`${atom.id}: ${(error as Error).message}`);
        }
      }
      this.fleetNotice = `Saved master: ${path.relative(this.projectRoot,backup)}. ` + (failures.length ? `Deployment incomplete: ${failures.join(' · ')}` : 'TUI and all configured atoms now share the master bank; local queues/history preserved.');
    } catch (e) { this.fleetNotice = `Deployment failed (master preserved): ${(e as Error).message}`; }
    this.fleetBusy = false; this.renderAll();
  }

  private quit(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.screen.destroy();
    process.exit(0);
  }
}
