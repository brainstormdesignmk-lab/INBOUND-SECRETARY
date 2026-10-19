// PTY DRIVER — run the REAL TUI process on a REAL pseudo-terminal and assert on
// the SCREEN an operator would see.
//
// WHY: every other render check feeds blessed fake PassThrough streams. That
// proves layout/painter invariants, but not the parts only a real terminal
// exercises — blessed's startup handshake, termios raw-mode switching (until
// raw mode is on, keystrokes are line-buffered by the kernel and never reach
// the app), the real winsize, the app's own key routing, the 100 ms ticker and
// the send/typing waits writing into a live tty. Those are exactly the layers
// where field reports came from ("letters vanish while typing", "the frame
// shifts after a longer chat").
//
// HOW: `script(1)` (util-linux, present on every Linux box this appliance runs
// on) allocates the pty and connects our pipes to it; the child sets its OWN
// window size with `stty rows/cols` before exec()ing the app, so blessed sees
// the size the harness declares. Input is written to the pty master, output is
// replayed through the shared terminal emulator (src/tui/terminal.ts) — the
// same screen model the headless frame check uses.
//
// NO native dependency: this is child_process + stty, not node-pty.

import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import { Terminal } from './terminal';

export interface PtyOptions {
  /** Command line to run inside the pty (executed by the shell `script` spawns). */
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

export interface WaitOptions {
  timeoutMs?: number;
  /** Poll interval (ms). */
  intervalMs?: number;
  /** Human description used in the timeout error. */
  label?: string;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export class PtySession {
  readonly terminal: Terminal;
  readonly cols: number;
  readonly rows: number;
  /** Every byte the pty produced, in order. */
  readonly raw: string[] = [];

  private child: ChildProcess;
  private finished: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private stderr = '';
  /** Timestamp of the last byte the pty produced (see waitQuiet). */
  private lastOutputAt = Date.now();

  private constructor(opts: PtyOptions) {
    this.cols = opts.cols ?? 100;
    this.rows = opts.rows ?? 40;
    this.terminal = new Terminal({ cols: this.cols, rows: this.rows });

    // `script -q -e -f -c "<cmd>" /dev/null`:
    //   -q  quiet (no "Script started" banner on stdout)
    //   -e  exit with the CHILD's status (so a crashed TUI fails the check)
    //   -f  flush after each write — without it the pty output arrives in
    //       blocks and every waitFor() would race the buffer
    // The command first pins the pty's window size: `script` gives an
    // unsized (0x0) pty when its own stdin is a pipe, and blessed would then
    // lay out for a fallback size instead of the one the check declares.
    const inner = `stty rows ${this.rows} cols ${this.cols}; exec ${opts.command}`;
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    this.child = spawn('script', ['-qefc', inner, '/dev/null'], spawnOpts);

    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.lastOutputAt = Date.now();
      this.raw.push(chunk.toString('utf8'));
      // The Buffer goes in as-is: the emulator's carry buffer + incremental
      // UTF-8 decoder handle sequence/runes split across pty chunks.
      this.terminal.write(chunk);
    });
    this.child.stderr?.on('data', (chunk: Buffer) => { this.stderr += chunk.toString('utf8'); });
    this.child.on('exit', (code, signal) => { this.finished = { code, signal }; });
  }

  static start(opts: PtyOptions): PtySession {
    return new PtySession(opts);
  }

  /** True while the child process is alive. */
  get running(): boolean {
    return this.finished === null;
  }

  /** The child's exit code once it has exited (null while running). */
  get exitCode(): number | null {
    return this.finished?.code ?? null;
  }

  get stderrText(): string {
    return this.stderr;
  }

  /** The whole emulated screen as text. */
  screen(): string {
    return this.terminal.text();
  }

  /** Type text into the pty (no trailing newline unless the caller adds one). */
  write(text: string): void {
    if (!this.child.stdin?.writable) throw new Error('pty: stdin is closed');
    this.child.stdin.write(text);
  }

  /** Type a line and press Enter. */
  async typeLine(text: string): Promise<void> {
    this.write(text);
    await sleep(30);
    this.write('\r');
  }

  /** Send a raw control sequence (e.g. '\x11' for Ctrl-Q, '\x1bOP' for F1). */
  async key(seq: string): Promise<void> {
    this.write(seq);
    await sleep(30);
  }

  /**
   * Wait until the pty has been silent for `quietMs` — the terminal's own "the
   * frame is finished" signal. Reading a screen mid-write yields a torn frame
   * (half of a reply), which is a defect detector's false positive, not a
   * rendering bug: assert on settled frames.
   */
  async waitQuiet(quietMs = 350, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() - this.lastOutputAt >= quietMs) return;
      if (Date.now() > deadline) return;   // a chatty app (clock ticker) still has to time out
      await sleep(20);
    }
  }

  /**
   * Wait until `pred` holds on the emulated screen. Polls (a terminal has no
   * "done" signal) and on timeout dumps the screen so a failure is diagnosable
   * instead of just "timed out".
   */
  async waitForScreen(pred: (t: Terminal) => boolean, opts: WaitOptions = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const intervalMs = opts.intervalMs ?? 25;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (pred(this.terminal)) return;
      if (!this.running) {
        throw new Error(`pty: the child exited (code ${this.exitCode}) while waiting for ${opts.label ?? 'the screen'}\n${this.dump()}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`pty: timed out after ${timeoutMs}ms waiting for ${opts.label ?? 'the screen'}\n${this.dump()}`);
      }
      await sleep(intervalMs);
    }
  }

  /**
   * Wait until the labelled pane's visible text contains `needle`.
   *
   * Two deliberate normalisations: whitespace is collapsed (blessed word-wraps
   * a long reply across pane rows, so a phrase test must ignore the wrap points)
   * and case is folded (copy is capitalised by grammar, not by meaning —
   * "Надоместокот" is the same fact as "надомест").
   */
  async waitForPaneText(label: string, needle: string, opts: WaitOptions = {}): Promise<void> {
    const want = needle.replace(/\s+/g, '').toLowerCase();
    await this.waitForScreen(
      t => (t.paneCollapsed(label) ?? '').toLowerCase().includes(want),
      { ...opts, label: opts.label ?? `"${needle.slice(0, 40)}" in the ${label} pane` },
    );
  }

  /** Dump the current screen with a row ruler — for failure messages. */
  dump(): string {
    const rows = this.terminal.rowsText();
    const header = `--- pty screen ${this.cols}x${this.rows} (last ${Math.min(6, this.raw.length)} chunks) ---`;
    const body = rows.map((r, i) => String(i).padStart(2, ' ') + '│' + r.replace(/\s+$/, '')).join('\n');
    return `${header}\n${body}\n${this.stderr ? `--- stderr ---\n${this.stderr.slice(-2000)}\n` : ''}`;
  }

  /** Quit cleanly (Ctrl-Q) and reap; SIGKILL after `timeoutMs`. */
  async close(timeoutMs = 4000): Promise<number | null> {
    if (this.running) {
      try { this.write('\x11'); } catch { /* stdin already gone */ }
      const deadline = Date.now() + timeoutMs;
      while (this.running && Date.now() < deadline) await sleep(25);
      if (this.running) this.child.kill('SIGKILL');
    }
    try { this.child.stdin?.end(); } catch { /* already closed */ }
    return this.exitCode;
  }

  /** Hard kill (used in test cleanup when a check threw). */
  kill(): void {
    if (this.running) this.child.kill('SIGKILL');
  }
}
