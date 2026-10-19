// THE PTY FUNNEL — the real TUI process driven through a real pty, asserting on
// the emulated SCREEN.
//
// WHAT THIS COVERS THAT NOTHING ELSE DOES: the headless frame check drives
// buildLayout() + FramePainter with fake streams; the in-process tests drive
// InboundHandler directly. Neither exercises blessed's real startup, the kernel
// line discipline switching to raw mode, the real winsize, the app's key
// routing, the 100 ms ticker, the client typing window, or the send/typing
// waits writing into a live tty. This module runs THE shipped entry point
// (src/tui/run.ts) under `script(1)` and reads the result the way an operator
// does: as rows of a terminal.
//
// The funnel it drives is the RENT/300-ден money path, because that is the one
// with two independent ladders (visit fee + rent commission) and the longest
// prose — the copy that must arrive wrapped, in the right pane, without the
// frame scrolling. Offline by design: the property feed is a local HTTP fixture
// (tests/fixtures/pty-feed.json) served on 127.0.0.1, so a network outage can
// never be mistaken for a rendering bug.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { PtySession } from '../src/tui/pty';

export interface FunnelOptions {
  cols?: number;
  rows?: number;
  /** Where the TUI writes its data/ dir (default: a throwaway temp dir). */
  workDir?: string;
  /** Keep the temp work dir instead of deleting it (debugging). */
  keepWorkDir?: boolean;
  /** Write the pty's byte-exact output here (offline replay of a field session). */
  rawDumpPath?: string;
}

export interface FunnelReport {
  failures: string[];
  notes: string[];
  screen: string;
  /** Every pane text as captured at the end. */
  panes: Record<string, string>;
}

// Walk up to the directory that owns package.json. The compiled test run
// bundles this file into dist-test/tests/, where `__dirname/..` is NOT the
// repo root — a hard-coded parent would spawn a non-existent entry point.
const PROJECT_ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..');
})();
const FEED_FIXTURE = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'pty-feed.json');

/** Serve the fixture feed on an ephemeral local port; returns its URL + closer. */
async function serveFeedFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const body = fs.readFileSync(FEED_FIXTURE, 'utf8');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('pty-funnel: fixture server has no port');
  return {
    url: `http://127.0.0.1:${addr.port}/properties`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

/**
 * Drive the rent funnel under a pty and return what the screen showed.
 * Never throws on a failed assertion — the caller decides (CLI prints, test
 * asserts): a thrown error inside a pty session would leak the child process.
 */
export async function runPtyFunnel(opts: FunnelOptions = {}): Promise<FunnelReport> {
  const cols = opts.cols ?? 100;
  const rows = opts.rows ?? 40;
  const failures: string[] = [];
  const notes: string[] = [];
  const panes: Record<string, string> = {};

  const feed = await serveFeedFixture();
  const workDir = opts.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lina-pty-'));
  fs.mkdirSync(path.join(workDir, 'data'), { recursive: true });

  const tsx = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
  const app = path.join(PROJECT_ROOT, 'src', 'tui', 'run.ts');
  // The child's STDERR goes to a file, not to the pty: a real terminal merges
  // both streams, and the RUNTIME's own noise (tsx's loader warning, node
  // deprecations) wraps and scrolls the physical screen before blessed draws
  // its first frame. The app itself never writes there — run.ts redirects
  // console.* into data/tui.log — so this hides the wrapper, not the program.
  // Post-boot scrolls are still counted and still fail the check.
  const stderrLog = path.join(workDir, 'pty-stderr.log');

  const session = PtySession.start({
    command: `${tsx} ${app} 2>${stderrLog}`,
    cwd: workDir,
    cols,
    rows,
    env: {
      ...process.env,
      // The TUI refuses to start without a brain; free mode is selected in the
      // UI right after boot, and a dummy key keeps the boot check green without
      // ever reaching a provider (every lane in this funnel is deterministic).
      GROQ_API_KEY: 'pty-check-not-a-real-key',
      LLM_PROVIDER: 'groq',
      // Speed knobs, not behaviour knobs: no typing waits and a 1-2 ms send
      // delay, so the check finishes in seconds. The ladder logic is identical.
      CLIENT_TYPING_DELAY_MS: '0',
      OWNER_TYPING_DELAY_MS: '0',
      MIN_DELAY_MS: '1',
      MAX_DELAY_MS: '2',
      // No learning side-effects from a check run, and no external geo calls.
      TUI_LEARN: '0',
      GOOGLE_MAPS_ENABLED: 'false',
      OSM_ENABLED: 'false',
      VIBER_OUTBOUND_MODE: 'direct',
      PROPERTY_DATA_URL: feed.url,
    },
  });

  /**
   * The NEWEST reply as the pane shows it — the last ЛИНА message BLOCK.
   *
   * On a small terminal the block's header scrolls off the top while the rest
   * of her reply is still on screen (a 24-row TUI leaves the chat pane ~10
   * rows), so when no header is visible the visible pane IS the tail of the
   * newest reply — the box follows the content. Returning '' there made the
   * funnel wait out its full timeout.
   */
  const lastReply = (): string => {
    const pane = session.terminal.paneText('РАЗГОВОР') ?? '';
    // Read the LAST MESSAGE BLOCK, by its header line — not "everything after
    // the last ЛИНА". During a repaint the newest reply's header can be one
    // frame behind its body, so the last ЛИНА still belongs to the PREVIOUS
    // reply and the slice mixed two replies together: under load the funnel
    // read the earlier fee disclosure as the answer to the next nag and the
    // rung's own copy was never asserted (the rung looked like "a figure in the
    // agency rule"). Every message starts with a [HH:MM] header, so slicing
    // from the last one is exact; when no header is visible at all (a long copy
    // fills a 24-row pane, the header scrolled off) the visible pane IS the
    // tail of the newest reply.
    const lines = pane.split('\n').map(l => l.trimEnd());
    const header = (l: string) => /^\[\d{2}:\d{2}\]/.test(l.trim());
    let start = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (header(lines[i]) && lines[i].includes('ЛИНА')) { start = i; break; }
    }
    if (start < 0) return pane.replace(/\s+/g, ' ').trim();
    // Stop at the NEXT header: the app also prints system rows ("— state:
    // idle → discovery —") right after a reply, and those are not her words.
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (header(lines[i])) { end = i; break; }
    }
    // Drop the [HH:MM] stamp: the rung contract checks count DIGITS, and a
    // timestamp would look like a figure in the agency-rule copy.
    const body = lines.slice(start, end).join(' ').replace(/\s+/g, ' ').trim();
    return body.replace(/^\[\d{2}:\d{2}\]\s*/, '');
  };

  /**
   * A client turn, from keystrokes to a SETTLED screen showing the reply.
   * Waiting is not politeness: without it the next message arrives while the
   * pipeline is still running and the app legitimately COALESCES the burst
   * (production behaviour), so the funnel would assert copy that had not been
   * served yet.
   *
   * Three details make this reliable on any terminal size, and each one was
   * forced by a real failure mode:
   *   • the wait is on the CHARACTER of the reply (`expect`), not on a counter —
   *     at 80 columns the top bar's "испратено: N" is truncated off the screen,
   *     and the chat pane scrolls, so neither is a dependable signal;
   *   • "the reply changed" is required as well, so a step whose expectation
   *     repeats the previous step's figure (300 денари disclosed, then 300
   *     денари defended) cannot pass on the OLD frame;
   *   • the screen is read only after the pty goes quiet — a reply caught
   *     mid-repaint is half a block, which would be reported as a rendering bug
   *     that does not exist (and would hide ones that do).
   */
  const turn = async (text: string, label: string, expect: RegExp): Promise<void> => {
    // Settle BEFORE capturing "before": the previous reply must already be fully
    // painted, or a frame caught mid-repaint can be mistaken for this turn's.
    await session.waitQuiet(400);
    const before = lastReply();
    await session.typeLine(text);
    const deadline = Date.now() + 30_000;
    for (;;) {
      await session.waitForScreen(
        () => {
          const reply = lastReply();
          return reply !== before && expect.test(reply);
        },
        { timeoutMs: Math.max(1, deadline - Date.now()), label: `ЛИна's reply to "${label}" (${expect.source})` },
      );
      await session.waitQuiet(400);
      // The match must SURVIVE the settle: a reply caught mid-repaint can match
      // on the previous block's text. If the settled frame no longer matches,
      // keep waiting instead of asserting on a half-painted screen.
      const settled = lastReply();
      if (settled !== before && expect.test(settled)) {
        notes.push(`${label} → ${settled.replace(/^\[[^\]]*\]\s*ЛИНА[^:]*:\s*/, '').slice(0, 90)}`);
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`the reply to "${label}" never settled on ${expect.source}: ${settled.slice(0, 140)}`);
      }
    }
  };

  let screen = '';
  let preCloseChunks = 0;
  try {
    // ── 1. boot: the layout is on screen and pane labels are unique ──────────
    await session.waitForPaneText('ПОРАКА', '›', { timeoutMs: 45_000, label: 'the TUI boot frame' });
    screen = session.screen();
    // The invariant is measured from the moment the app owns the screen: what a
    // shell or a process manager printed before it is not a frame defect. Every
    // scroll AFTER this line is one.
    const bootScrolls = session.terminal.scrolls;
    if (bootScrolls > 0) notes.push(`${bootScrolls} scroll(s) before the first frame (pre-boot output — not a frame defect)`);
    for (const label of ['ПОРАКА', 'РАЗГОВОР', 'СОПСТВЕНИК']) {
      const count = session.terminal.rowsText().filter(r => r.includes(`┌─ ${label}`)).length;
      if (count !== 1) failures.push(`pane label "${label}" appears ${count}× on the real terminal (must be exactly 1)`);
    }

    // ── 2. a new client, then the exam brain (no LLM: the bank must answer) ──
    await session.key(' ');                       // [Space] = new client
    await session.typeLine('Тест-Клиент');        // the naming prompt
    await session.typeLine('/brain free');
    await session.waitForPaneText('РАЗГОВОР', 'мозок: free', { timeoutMs: 20_000, label: 'the free-brain switch' });

    // ── 3. the property interest → availability → the RENT fee disclosure ────
    await turn('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79', 'the property interest', /Евидентен број\s*79/iu);
    await turn('DALI E SEUSTE DOSTAPEN ?', 'the availability question', /достап|слобод|цена|сопственик|евиденциј/iu);
    await turn('KONTAKTIRAJTE GO I KAZETE MI', 'the owner-contact request', /300\s*денари/u);
    // Asserted on the reply AT THE MOMENT it was served: further turns scroll the
    // pane, and "is the early disclosure still on screen at the end" would be a
    // statement about the scroll position, not about what the client was told.
    // The assertions are CONTRACT-level, never "the sentence I saw last week":
    // the bank holds several variants of every rung, and a check that pins one
    // variant's wording fails the first time the copy is regenerated. What is
    // invariant (and what the client must hear) is the sanctioned FIGURE, the
    // question shape, and which topic's copy it is.
    const feeCopy = lastReply();
    if (!/300\s*денари/u.test(feeCopy)) {
      failures.push(`the rent visit-fee disclosure (300 денари) never reached the chat pane: ${feeCopy.slice(0, 160)}`);
    }
    if (!/\?\s*$/u.test(feeCopy)) {
      failures.push(`the fee disclosure is missing its agreement question: ${feeCopy.slice(0, 160)}`);
    }
    if (/50\s*%/u.test(feeCopy)) {
      failures.push(`the fee disclosure leaked the commission tier (50%): ${feeCopy.slice(0, 160)}`);
    }

    // ── 4. the FEE ladder on the 300 script, driven with the [23:11]/[23:12]
    // FIELD BURST — the three turns an operator actually typed at Lina. The
    // owner's order for BOTH fees: disclose → nag#1 persuade → nag#2 the agency
    // rule → nag#3 the decision. Nag #1 is the charge QUESTION from the rent
    // capture ("PARI ZEMATE ZA POSETA ?") — before the fix it was read as the
    // commission/provision ask and the funnel jumped to contact collection
    // without one rung. Nag #2 disapproves of the PRACTICE ("NE MI SE DOPAGJA VAKOV
    // PRINCIP NA RABOTA"): it used to be answered from the explanation pool
    // WITHOUT advancing, so the ladder stopped one rung short of the decision.
    // Nag #3 is the fee-sized amount complaint that carries NO viewing noun and
    // NO fee-object noun ("SKAPO E TOA . ZA SEKOJ STAN PO 300DEN") — the one
    // that used to be read as a PROPERTY budget and dumped a cheaper-property
    // pair mid-ladder. Both are asserted on the real screen below, so this
    // funnel covers the field burst end to end, not just its handler shape.
    await turn('PARI ZEMATE ZA POSETA ?', 'the charge question (nag 1)', /300\s*денари/u);
    const feeRung1 = lastReply();
    if (!/300\s*денари/u.test(feeRung1)) {
      failures.push(`the visit-fee persuasion does not name the sanctioned rent fee: ${feeRung1.slice(0, 160)}`);
    }
    if (/50\s*%/u.test(feeRung1)) {
      failures.push(`the visit-fee rung served the COMMISSION argument: ${feeRung1.slice(0, 160)}`);
    }
    if (/име и презиме|телефонски број/iu.test(feeRung1)) {
      failures.push(`the charge question jumped to contact collection: ${feeRung1.slice(0, 160)}`);
    }

    await turn('NE MI SE DOPAGJA VAKOV PRINCIP NA RABOTA', 'the practice disapproval (nag 2)', /ценовник|правил|политик/iu);
    const feeRung2 = lastReply();
    if (!/ценовник|правил|политик/iu.test(feeRung2)) {
      failures.push(`the complaint did not reach the agency rule: ${feeRung2.slice(0, 160)}`);
    }
    if (/\d/u.test(feeRung2)) {
      failures.push(`the agency rule rung carries a figure: ${feeRung2.slice(0, 160)}`);
    }

    await turn('SKAPO E TOA . ZA SEKOJ STAN PO 300DEN', 'the fee-sized amount complaint (nag 3)', /дали да ја закажам посетата|одлуката е ваша/iu);
    const feeRung3 = lastReply();
    if (!/дали да ја закажам посетата|одлуката е ваша/iu.test(feeRung3)) {
      failures.push(`the fee-sized complaint did not reach the decision: ${feeRung3.slice(0, 160)}`);
    }
    // THE PIVOT REGRESSION, as the operator would see it: this message has no
    // viewing noun and no fee-object noun, so the cheaper-search interceptor
    // used to read "скапо + 300" as a property BUDGET and serve a property pair
    // ("Еве што е најпристапно таму во овој момент", EB 56 + EB 42) instead of
    // finishing the ladder. A card or that intro in the pane means the veto is
    // gone — the same failure the field transcript shows.
    if (/Евидентен број|најпристапно/iu.test(feeRung3)) {
      failures.push(`the fee nag pivoted into a cheaper property search: ${feeRung3.slice(0, 160)}`);
    }

    // ── 5. the COMMISSION ladder rung 1: the 50% tier, on ITS own counter ───
    // The refusal is typed as the COMMISSION refusal and must hear the tier,
    // not the visit fee — the isolation contract, now on a real terminal.
    await turn('50% E MNOGU', 'the commission complaint', /50\s*%/u);
    const rung1 = lastReply();
    if (!/50\s*%/u.test(rung1)) {
      failures.push(`the commission rung did not restate the 50% tier: ${rung1.slice(0, 160)}`);
    }
    if (!/\?\s*$/u.test(rung1)) {
      failures.push(`the commission persuasion is missing its agreement question: ${rung1.slice(0, 160)}`);
    }
    if (/300\s*денари|500\s*денари/u.test(rung1)) {
      failures.push(`the commission complaint was answered with the visit-fee copy: ${rung1.slice(0, 160)}`);
    }

    // ── 6. the COMMISSION rung 2: the published agency rule ─────────────────
    await turn('PROVIZIJATA E PREVISOKA', 'the second commission refusal', /ценовник|правил|политик|деловник/iu);
    const rung2 = lastReply();
    if (!/ценовник|правил|политик|деловник/iu.test(rung2)) {
      failures.push(`the commission rule rung is missing: ${rung2.slice(0, 160)}`);
    }
    // provision.rule.hold's contract forbids EVERY digit: the rule states the
    // policy, and re-quoting a figure would reopen the price debate.
    if (/\d/u.test(rung2)) {
      failures.push(`the commission rule rung carries a figure (its contract forbids all digits): ${rung2.slice(0, 160)}`);
    }
    if (/300\s*денари|500\s*денари/u.test(rung2)) {
      failures.push(`the commission rule rung fell back to the visit fee: ${rung2.slice(0, 160)}`);
    }

    // ── 7. a Cyrillic refusal shape (the прифаќам family) still climbs it ────
    // "НЕ САКАМ ПРОВИЗИЈА" carries no pay verb; before the object arm in
    // detectProvisionResistance it fell through to the visit-fee rungs. It must
    // reach the commission ladder's decision rung and never the fee copy.
    await turn('НЕ САКАМ ПРОВИЗИЈА', 'the Cyrillic commission refusal', /дали да продолжиме по наведените услови или не|50\s*%/iu);
    const rung3 = lastReply();
    if (!/дали да продолжиме по наведените услови или не|50\s*%/iu.test(rung3)) {
      failures.push(`the Cyrillic refusal did not reach the commission ladder: ${rung3.slice(0, 160)}`);
    }
    if (/300\s*денари|500\s*денари/u.test(rung3)) {
      failures.push(`the Cyrillic refusal was answered with the visit-fee copy: ${rung3.slice(0, 160)}`);
    }

    // ── 7b. the [22:03] CAPTURE on a real terminal — the fee challenge under
    // каде. "KAJ SE VIDELO PARI ZA OTVARANJE STAN" is a NAG (it denies the fee
    // and demands its source), and the field session answered it with the
    // landmark rotation — "Тоа се наоѓа во близина на Геолошки завод" + a maps
    // pin for a place the client never asked about. Both halves are asserted
    // here: the turn must climb the fee counter (the ladder's close rung, since
    // the fee was already naged three times) and the reply must carry NO
    // location at all.
    await turn('KAJ SE VIDELO PARI ZA OTVARANJE STAN', 'the fee challenge under каде', /пријатен ден|Убав ден|Благодарам/iu);
    const challengeReply = lastReply();
    if (/во близина на|мин пеш|населбата|Точната адреса|maps\.google|https?:\/\//iu.test(challengeReply)) {
      failures.push(`the fee challenge was answered with a LOCATION: ${challengeReply.slice(0, 160)}`);
    }

    // ── 7b2. THE NOTEBOOK, on the operator's screen ──────────────────────────
    // The pane assertions above prove what the CLIENT was told. They cannot
    // prove what the PIPELINE recorded — and until /state existed the real-
    // terminal harness had no way to read it, so a correct sentence with a
    // wrong counter was invisible. This is the same live session, read through
    // the TUI's own state store (no second implementation).
    await session.typeLine('/state');
    // Wait on the COMPACT row, not the readable header: at 80×24 the readable
    // block scrolls its first rows off, so `[state] state:` is not dependable.
    await session.waitForScreen(
      () => /\[slots\] fee=\d/.test(session.terminal.paneText('РАЗГОВОР') ?? ''),
      { timeoutMs: 15_000, label: 'the /state notebook' },
    );
    const notebook = (): string => {
      // The COMPACT probe rows (`[slots] …`) are the part that is always on
      // screen, at 80×24 too — the readable `[state]` block above them can
      // scroll off a short pane, and a counter you cannot see is a counter you
      // cannot assert. Two rows, each shorter than the smallest chat pane.
      const pane = session.terminal.paneText('РАЗГОВОР') ?? '';
      const start = pane.lastIndexOf('[slots] state=');
      return (start < 0 ? pane : pane.slice(start)).replace(/\s+/g, ' ');
    };
    // THE WHOLE NOTEBOOK, not the summary: /state also writes every slot —
    // arrays and objects included — to data/session-state.json. The pane rows
    // are for a human; this file is the contract the check can assert in full.
    const dumpPath = path.join(workDir, 'data', 'session-state.json');
    const readDump = (): { state: string; slots: Record<string, unknown> } | undefined => {
      try { return JSON.parse(fs.readFileSync(dumpPath, 'utf8')); } catch { return undefined; }
    };
    // Four: the three ladder rungs (persuade → rule → decision) plus the [22:03]
    // challenge, which is a nag too and closes the ladder (rung 4 = the graceful
    // close served above). Pinned as a NUMBER because that is the whole point of
    // reading the notebook — the copy alone cannot tell 3 from 4.
    if (!/\[slots\] fee=4 /.test(notebook())) {
      failures.push(`the notebook does not show the four visit-fee nags (3 rungs + the challenge): ${notebook().slice(-260)}`);
    }
    if (!/agreed=no/.test(notebook())) {
      failures.push('the notebook says the client AGREED to the fee, but he never did');
    }
    if (!/svc=rent/.test(notebook())) {
      failures.push(`the notebook does not hold the declared service: ${notebook().slice(-260)}`);
    }
    // The dump is the full record: every slot the session holds, arrays included.
    const feeDump = readDump();
    if (!feeDump) {
      failures.push(`/state did not write ${dumpPath}`);
    } else {
      // rung 4 IS the close: the decision was asked and refused, so the ladder
      // queues the chat (the same contract fee-serve-routing pins). The old
      // 'closing' expectation described the state BEFORE the close rung was
      // wired to the queue.
      if (feeDump.state !== 'queued') failures.push(`the dump state is ${feeDump.state}, expected queued after the close rung`);
      if ((feeDump.slots.feeRejections as number | undefined) !== 4) {
        failures.push(`the dump feeRejections is ${String(feeDump.slots.feeRejections)}, expected 4`);
      }
      if (feeDump.slots.viewingFeeAgreed !== undefined) {
        failures.push('the dump records fee consent the client never gave');
      }
      if (feeDump.slots.service !== 'rent') failures.push(`the dump service is ${String(feeDump.slots.service)}`);
      // COMPLETENESS: the summary rows cover six slots; the file must carry more.
      const summaryKeys = ['service', 'feeRejections', 'provisionRejections', 'viewingFeeAgreed', 'anywhere', 'budget'];
      const beyond = Object.keys(feeDump.slots).filter(k => !summaryKeys.includes(k) && feeDump.slots[k] !== undefined);
      if (beyond.length === 0) failures.push('the dump carries nothing beyond the summary rows — not the whole notebook');
      // ARRAYS/OBJECTS: the landmark list must survive serialization.
      if (!Array.isArray(feeDump.slots.nearbyLandmarks) || (feeDump.slots.nearbyLandmarks as unknown[]).length === 0) {
        failures.push('the dump did not serialize the landmark array');
      }
    }

    // ── 7c. the DISCOVERY notebook + the [23:47/23:48] capture, same terminal ─
    // A fresh client (the fee ladder above left its own session queued). The
    // point is the same one the handler test makes — a released area is an
    // ANSWER — but here it is proven on the real screen AND in the notebook:
    // "anywhere: true" after the dismissal, then the budget it named.
    await session.key(' ');                                    // [Space] = new client
    await session.typeLine('Втор-Клиент');
    await turn('SAKAM DA KUPAM KUKJA', 'the house interest', /дел од градот|населба/iu);
    await turn('NEBITNO KADE', 'the area dismissal', /цена|буџет|граница/iu);
    await session.typeLine('/state');
    await session.waitForScreen(
      () => /\[slots\] any=true/.test(session.terminal.paneText('РАЗГОВОР') ?? ''),
      { timeoutMs: 15_000, label: 'the notebook (any=true)' },
    );
    // The card BODY is the liveness marker, not the header: at 80×24 the
    // "Евидентен број 90" line scrolls off while the price row is still on the
    // pane, and an expectation the pane cannot show times out a healthy turn.
    await turn('VAZNO E DA E DO 80000', 'the budget that matters', /75\.?000|Евидентен број/iu);
    const budgetReply = lastReply();
    if (/Евидентен број 78/u.test(budgetReply)) {
      failures.push(`the over-budget property (EB 78, 185.000) served under an 80.000 budget: ${budgetReply.slice(0, 160)}`);
    }
    await session.typeLine('/state');
    await session.waitForScreen(
      () => /\[slots\] any=true bud=80000/.test(session.terminal.paneText('РАЗГОВОР') ?? ''),
      { timeoutMs: 15_000, label: 'the notebook (any=true bud=80000)' },
    );
    const discoveryDump = readDump();
    if (!discoveryDump) {
      failures.push('the discovery /state did not write the dump');
    } else {
      if (discoveryDump.slots.anywhere !== true) failures.push('the dump lost the released area (anywhere)');
      if (discoveryDump.slots.budget !== '80000') failures.push(`the dump budget is ${String(discoveryDump.slots.budget)}`);
      if (discoveryDump.slots.house !== true) failures.push('the dump lost the house type');
      // A SECOND array beside the landmarks: presentedIds is what the search
      // bookkeeping reads, and a dump that drops it cannot explain a batch.
      if (!Array.isArray(discoveryDump.slots.presentedIds) || (discoveryDump.slots.presentedIds as unknown[]).length === 0) {
        failures.push('the dump did not serialize the shown-ids array (presentedIds)');
      }
      if (discoveryDump.state !== 'presentation') failures.push(`the dump state is ${discoveryDump.state}`);
    }

    // ── 7d. THE [23:12] PIVOT, in the state the field session was really in ──
    // The client is looking at the batch above (presentation) and objects to
    // the fee. Before the fix this turn re-entered the criteria/present
    // machinery and answered a fee objection with ANOTHER batch of properties —
    // the exact pivot the field transcript shows. Asserted here on the real
    // terminal: the ladder takes the objection (its own counter), the state
    // stays presentation, and NO property card appears in the reply.
    await turn('SKAPO E TOA . ZA SEKOJ STAN PO 300DEN', 'the fee nag in presentation', /денари|евра|провизиј|симболич/iu);
    const presentationNag = lastReply();
    if (/Евидентен број|најпопуларните|најбараните/iu.test(presentationNag)) {
      failures.push(`a fee objection in presentation served PROPERTIES: ${presentationNag.slice(0, 160)}`);
    }
    await session.typeLine('/state');
    await session.waitForScreen(
      () => /\[slots\] fee=1 /.test(session.terminal.paneText('РАЗГОВОР') ?? ''),
      { timeoutMs: 15_000, label: 'the notebook (presentation nag)' },
    );
    const presDump = readDump();
    if (!presDump) failures.push('the presentation /state did not write the dump');
    else {
      if (presDump.state !== 'presentation') {
        failures.push(`a fee objection moved the session to ${presDump.state}`);
      }
      if ((presDump.slots.feeRejections as number | undefined) !== 1) {
        failures.push(`the presentation nag did not climb its own counter (fee=${String(presDump.slots.feeRejections)})`);
      }
    }

    // ── 7e. THE SAME PIVOT ON THE 300 SCRIPT, through a FRESH rent client ────
    // 7d proves the veto on a BUY session (500-ден copy). The rent script has
    // its own ladder copy and its own market backfill rule, so the objection is
    // driven again through a brand-new client who just found a rental: the
    // reply must be the rent rung (300), the state must stay presentation, the
    // batch must NOT grow, and no property card may appear. A fresh client also
    // proves the lane does not depend on any state the earlier sessions left.
    await session.key(' ');                                    // [Space] = new client
    await session.typeLine('Трет-Клиент');
    // The discovery-ask pool is SERVE-ROTATED (Math.random in pickVariant), so
    // pin the CONTRACT — "where in the city?" — not the nouns of one variant:
    // "…одредена локација во градот…" carries neither "населба" nor "дел од
    // градот" and read as a missing reply.
    await turn('SAKAM STAN POD KIRIJA', 'the rent search', /населба|дел од градот|локациј|реон|област/iu);
    await turn('NEBITNO KADE', 'the rent area dismissal', /буџет|месечен|кирија/iu);
    // The trailing question is the liveness marker: the intro/card header can
    // scroll off a 10-row pane, her closing question is always the last line.
    // The batch's CARD TEXT is not asserted here: at 80×24 it scrolls off the
    // 10-row pane, and the batch's identity is proven where it cannot scroll —
    // presentedIds in the dump after the objection (below).
    await turn('DO 300', 'the rent budget', /организирам посета|Што мислите/iu);

    await turn('SKAPO E TOA . ZA SEKOJ STAN PO 300DEN', 'the fee nag in a rent presentation', /300\s*денари/u);
    const rentNag = lastReply();
    if (!/300\s*денари/u.test(rentNag)) {
      failures.push(`the rent presentation nag did not serve the 300 sanction: ${rentNag.slice(0, 160)}`);
    }
    if (/500\s*денари/u.test(rentNag)) {
      failures.push(`the rent presentation nag served the BUY fee: ${rentNag.slice(0, 160)}`);
    }
    if (/Евидентен број|најпопуларните|најбараните|најпристапно/iu.test(rentNag)) {
      failures.push(`a fee objection in a rent presentation served PROPERTIES: ${rentNag.slice(0, 160)}`);
    }

    // The notebook rows AND the dump: the counter climbed, the state did not
    // move, and the batch is byte-for-byte the one the client was looking at.
    await session.typeLine('/state');
    await session.waitForScreen(
      () => /\[slots\] fee=1 /.test(session.terminal.paneText('РАЗГОВОР') ?? '')
        && /svc=rent/.test(session.terminal.paneText('РАЗГОВОР') ?? ''),
      { timeoutMs: 15_000, label: 'the notebook (rent presentation nag)' },
    );
    const rentNotebook = notebook();
    // A presentation batch does NOT arm the funnel anchor (eb stays '-'), and
    // the batch must stay exactly the ONE row the client was looking at: the
    // fee objection must not re-enter the present machinery and append.
    if (!/\[slots\] eb=- ghost=- shown=1/.test(rentNotebook)) {
      failures.push(`the rent notebook lost the anchor or grew the batch: ${rentNotebook.slice(-260)}`);
    }
    const rentDump = readDump();
    if (!rentDump) {
      failures.push('the rent presentation /state did not write the dump');
    } else {
      if (rentDump.state !== 'presentation') {
        failures.push(`a rent fee objection moved the session to ${rentDump.state}`);
      }
      if ((rentDump.slots.feeRejections as number | undefined) !== 1) {
        failures.push(`the rent presentation nag did not climb its own counter (fee=${String(rentDump.slots.feeRejections)})`);
      }
      if (rentDump.slots.service !== 'rent') failures.push(`the rent nag lost the market (service=${String(rentDump.slots.service)})`);
      const batch = rentDump.slots.presentedIds as number[] | undefined;
      if (!Array.isArray(batch) || batch.length !== 1 || batch[0] !== 79) {
        failures.push(`the rent objection MUTATED the batch bookkeeping: ${JSON.stringify(batch)}`);
      }
    }

    // ── 7f. `/state full` — the WHOLE notebook, on the pane, no file ────────
    // The compact rows are a projection (a 10-row pane cannot hold 46 slots).
    // An operator mid-call must not have to open data/session-state.json, so
    // the full view prints every defined slot as its own row: arrays included.
    await session.typeLine('/state full');
    await session.waitForScreen(
      () => /presentedIds=\[79\]/.test(session.terminal.paneText('РАЗГОВОР') ?? ''),
      { timeoutMs: 15_000, label: 'the full notebook (/state full)' },
    );
    const fullPane = session.terminal.paneText('РАЗГОВОР') ?? '';
    if (!/\[slots\] presentedIds=\[79\]/.test(fullPane)) {
      failures.push(`/state full did not put the shown-ids array on the pane: ${fullPane.slice(-260)}`);
    }
    if (!/\[slots\] dump=/.test(fullPane)) {
      failures.push('/state full did not keep the dump row (the read must still say where the record is)');
    }

    // ── 7g. `/state <chatId>` — another client's notebook, by name ──────────
    // The active lead is client-3; client-1 is the one the fee ladder left
    // queued. Reading it by id proves the operator can diagnose a chat that is
    // NOT on screen (the stale-snapshot misread) without switching clients.
    await session.typeLine('/state client-1');
    await session.waitForScreen(
      () => {
        const p = session.terminal.paneText('РАЗГОВОР') ?? '';
        return /\[slots\] fee=4 /.test(p) && /state=queued/.test(p);
      },
      { timeoutMs: 15_000, label: 'the notebook of client-1 (/state client-1)' },
    );
    const otherClientPane = session.terminal.paneText('РАЗГОВОР') ?? '';
    if (!/\[slots\] fee=4 /.test(otherClientPane) || !/state=queued/.test(otherClientPane)) {
      failures.push(`/state client-1 did not read the other client's session: ${otherClientPane.slice(-260)}`);
    }

    // ── 7h. THE [00:05]–[00:08] ANCHOR BURST on the real screen ─────────────
    // A fourth, fresh BUY client; EB 88 is in the fixture (Аеродром, 68 м²,
    // 133.000 евра — the row from the transcript). Four obligations, asserted
    // where the operator sees them:
    //   • the choice arms the flat and shows the FEE, never contact collection;
    //   • the WHICH-flat question names EB + neighbourhood + price and asks
    //     whether the choice stands — it used to repeat the fee;
    //   • the insult is the STRIKE (warning + ✗1 on the client row), never fee
    //     persuasion;
    //   • the fee objection climbs the ladder and never answers with the flat's
    //     price (133.000).
    await session.key(' ');                                    // [Space] = new client
    await session.typeLine('Анкор-Клиент');
    await turn('ZA EB 88', 'the EB 88 card', /Евидентен број\s*88/iu);
    await turn('E OVOJ MOZE', 'the choice', /500\s*денари/u);
    const choiceReply = lastReply();
    if (/Вашето име|телефонски број|број за контакт/iu.test(choiceReply)) {
      failures.push(`the choice jumped to contact collection before the fee gate: ${choiceReply.slice(0, 160)}`);
    }
    await turn('ZA KOJ STAN STANUVA ZBOR ?', 'the which-flat question', /Аеродром/iu);
    const anchorReply = lastReply();
    if (!/88/u.test(anchorReply) || !/133\.000/u.test(anchorReply)) {
      failures.push(`the which-flat answer lost the anchor: ${anchorReply.slice(0, 160)}`);
    }
    if (/500\s*денари|10\s*евра/iu.test(anchorReply)) {
      failures.push(`the which-flat question was answered with the FEE again: ${anchorReply.slice(0, 160)}`);
    }
    if (!/\?\s*$/u.test(anchorReply)) {
      failures.push(`the which-flat answer does not ask whether the choice stands: ${anchorReply.slice(0, 160)}`);
    }
    await turn('MA KAKVI 500 DEN , DALI SI TI NORMALNA', 'the insult', /професионал/iu);
    const insultReply = lastReply();
    if (/500\s*денари|10\s*евра|провизиј/iu.test(insultReply)) {
      failures.push(`the insult was answered with FEE persuasion: ${insultReply.slice(0, 160)}`);
    }
    const leadsPane = session.terminal.paneText('КЛИЕНТИ') ?? '';
    if (!/Анкор-Клиент/.test(leadsPane) || !/✗1/.test(leadsPane)) {
      failures.push(`the insult did not record a strike on the client row: ${leadsPane.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    await turn('KOJA SIMBOLICNA CENA . 500DEN SE PARI', 'the fee objection', /500\s*денари/u);
    const anchorFeeReply = lastReply();
    if (/133\.000|133000/u.test(anchorFeeReply)) {
      failures.push(`the fee objection was answered with the FLAT's price: ${anchorFeeReply.slice(0, 160)}`);
    }
    // End on the notebook: the final-screen invariant expects the newest thing
    // on the pane to be the /state dump row.
    await session.typeLine('/state');
    await session.waitForScreen(
      () => /\[slots\] eb=88/.test(session.terminal.paneText('РАЗГОВОР') ?? '')
        && /\[slots\] dump=/.test(session.terminal.paneText('РАЗГОВОР') ?? ''),
      { timeoutMs: 15_000, label: 'the notebook (anchor burst)' },
    );
    const anchorNotebook = notebook();
    if (!/\[slots\] eb=88/.test(anchorNotebook)) {
      failures.push(`the anchor burst lost the armed flat in the notebook: ${anchorNotebook.slice(-260)}`);
    }
    if (!/fee=1 /.test(anchorNotebook)) {
      failures.push(`the fee objection did not climb the visit-fee counter: ${anchorNotebook.slice(-260)}`);
    }

    // ── 7i. the [09:21]–[09:22] exchange: one hello, "недвижност" only ─────
    // A fifth, fresh client. Two owner rules from the transcript:
    //   • ZDRAVO → the opening greeting speaks of "недвижност", never "имот"
    //     ("имот" is land/a plot in the agency's vocabulary);
    //   • MI TREBA LOKAL → the business-space intro answers WITH THE BODY ONLY:
    //     she already greeted in the previous message, so a second "Добар ден!"
    //     reads like a new conversation.
    await session.key(' ');                                    // [Space] = new client
    await session.typeLine('Јазик-Клиент');
    await turn('ZDRAVO', 'the opening greeting', /куп|изнајм|недвижност/iu);
    const openingReply = lastReply();
    if (/(?:^|[^\p{L}])имот(?:от|ите|и)?(?:[^\p{L}]|$)/iu.test(openingReply)) {
      failures.push(`the opening greeting still says "имот": ${openingReply.slice(0, 160)}`);
    }
    await turn('MI TREBA LOKAL', 'the business-space request', /деловен простор/iu);
    const businessReply = lastReply();
    const businessBody = businessReply.replace(/^.*?ЛИНА[^:]*:\s*/u, '');
    if (/^(?:Здраво|Добар\s+ден|Добредојдовте|Добродојдовте|Повелете)/iu.test(businessBody)) {
      failures.push(`the second message greeted AGAIN instead of continuing the conversation: ${businessReply.slice(0, 160)}`);
    }
    if (/(?:^|[^\p{L}])имот(?:от|ите|и)?(?:[^\p{L}]|$)/iu.test(businessReply)) {
      failures.push(`the business-space intro still says "имот": ${businessReply.slice(0, 160)}`);
    }
    // End on the notebook: section 8 expects the newest chat row to be a dump.
    await session.typeLine('/state');
    await session.waitForScreen(
      () => /\[slots\] dump=/.test(session.terminal.paneText('РАЗГОВОР') ?? ''),
      { timeoutMs: 15_000, label: 'the notebook (language rules)' },
    );

    // Let the last frame settle: the send delay + one ticker pass.
    await new Promise(r => setTimeout(r, 800));

    // ── 8. the screen invariants ─────────────────────────────────────────────
    screen = session.screen();
    const term = session.terminal;
    const funnelScrolls = term.scrolls - bootScrolls;
    if (funnelScrolls > 0) {
      failures.push(`the physical terminal SCROLLED ${funnelScrolls}× during the funnel — blessed's cell-diff model is desynced from that point on`);
    }
    if (term.overflowCup) failures.push('blessed addressed a cursor position outside the real terminal');

    const screenRows = term.rowsText();
    for (const label of ['ПОРАКА', 'РАЗГОВОР', 'СОПСТВЕНИК']) {
      const n = screenRows.filter(r => r.includes(`┌─ ${label}`)).length;
      if (n !== 1) failures.push(`after the funnel the pane label "${label}" appears ${n}×`);
    }
    screenRows.forEach((r, i) => {
      const trimmed = r.trim();
      if (trimmed && !/^[│┌└ ]/.test(trimmed) && /[└┐]/.test(trimmed.slice(1, -1))) {
        failures.push(`stray box corner mid-content at row ${i}: ${trimmed.slice(0, 70)}`);
      }
    });

    // The chat pane must carry the exchange (the newest reply is what the
    // operator is looking at, so the pane must have followed the content); the
    // owner pane must never hold chat replies.
    const chat = term.paneText('РАЗГОВОР') ?? '';
    panes['РАЗГОВОР'] = chat;
    panes['СОПСТВЕНИК'] = term.paneText('СОПСТВЕНИК') ?? '';
    // The newest reply must be the one at the BOTTOM of the pane: the box has to
    // follow the content, or the operator reads a stale frame while Lina talks.
    // Case-insensitive: the pool carries both "Ви посакувам пријатен ден!" and
    // "Ви посакувам убав ден!", and the farewell word is lower-case in the copy.
    // The newest reply must still be the one the box shows: comparing with the
    // text captured right after the last turn proves the pane did not scroll
    // away from it — and works at any size, unlike matching a phrase that a
    // 10-row pane may have scrolled off.
    // The box must follow the content to the BOTTOM: after /state, the newest
    // thing on the pane is the notebook, so its last row must be the last
    // non-empty row. (The card's own presence at the bottom was already proven
    // by the turn's `expect` at the moment it was served; on a 10-row pane any
    // text printed after it necessarily pushes part of it up.)
    const lastVisible = (term.paneText('РАЗГОВОР') ?? '').split('\n')
      .map(l => l.trim()).filter(Boolean).pop() ?? '';
    if (!/^\[slots\] dump=/.test(lastVisible)) {
      failures.push(`the chat pane is not showing the newest content at the bottom: ${lastVisible.slice(0, 80)}`);
    }
    if (/ЛИНА/u.test(panes['СОПСТВЕНИК'])) failures.push('the owner pane carries chat replies');
    if (chat.length === 0) failures.push('the chat pane is empty after a full funnel');

    // The LAST reply must be fully on screen — the wrap must not push its tail
    // out of the pane (this is the "we only see half of her message" report).
    const tail = chat.trimEnd().split('\n').slice(-1)[0] ?? '';
    notes.push(`final chat pane line: ${tail.trim().slice(0, 80)}`);

    // ── 9. a clean quit: Ctrl-Q exits with the child's own status ───────────
    // Everything read so far is settled; note where the session ends so the raw
    // dump holds the LIVE frames (blessed clears the screen on its way out, so
    // a dump taken after the quit would replay as an empty terminal).
    preCloseChunks = session.raw.length;
    const code = await session.close();
    if (code !== 0) failures.push(`the TUI did not exit cleanly on Ctrl-Q (exit code ${code})`);
  } catch (e) {
    failures.push(`pty funnel error: ${(e as Error).message}`);
    session.kill();
  } finally {
    if (opts.rawDumpPath) {
      const upto = preCloseChunks > 0 ? preCloseChunks : session.raw.length;
      try { fs.writeFileSync(opts.rawDumpPath, session.raw.slice(0, upto).join('')); } catch { /* diagnostic only */ }
    }
    await feed.close();
    if (!opts.keepWorkDir && !opts.workDir) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  return { failures, notes, screen: screen || session.screen(), panes };
}
