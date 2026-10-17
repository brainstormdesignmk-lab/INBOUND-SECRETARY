// Node 16 compatibility bootstrap.
//
// The ATOM cluster runs Node 16 (max), while this codebase was written against
// Node 18+, where `fetch`, `Headers`, `Request`, `Response`, `FormData` and the
// Web Streams globals are built in. On Node 16 they are absent (verified:
// fetch/ReadableStream/FormData are all undefined on 16.20). This module
// installs the undici implementations into globalThis so the same code runs on
// both.
//
// Import this FIRST in every entry point (src/index.ts, src/tui/run.ts,
// boot_check, scripts/*) — it is a no-op on Node 18+.
//
// groq-sdk's own shim (internal/shims.js) requires exactly this: a global
// `fetch` (and, when streaming, a global `ReadableStream`), and documents
// polyfilling globalThis as the supported path.

// undici is the Node 16 polyfill, but it is OPTIONAL at runtime: on Node 18+/
// 22 every global below is native and the package may not be installed at all
// (the T60 deployment runs Node 22 and keeps its own dependency set). A
// module-scope `import` made that tree fail to BOOT with MODULE_NOT_FOUND
// before it ever reached the guard below, even though it needed no polyfill.
// Load it lazily, and only when a global is actually missing.
let undici: any = null;
function loadUndici(): any {
  if (undici) return undici;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    undici = require('undici');
  } catch {
    undici = {};
  }
  return undici;
}

// node:stream/web exists on Node 16.5+ and is the same Web Streams
// implementation Node 18 exposes globally. Best-effort: if it is unavailable
// for any reason, streaming-only paths fail loudly later, everything else works.
let streamWeb: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  streamWeb = require('node:stream/web');
} catch {
  streamWeb = null;
}

// Guarded: on Node 18+ these exist natively — leave them alone so native
// behavior (and Node's own keep-alive agent) is preserved.
if (typeof (globalThis as any).fetch !== 'function') {
  const u = loadUndici();
  if (typeof u.fetch !== 'function') {
    throw new Error(
      'fetch is unavailable and the optional undici polyfill is not installed — run "npm install undici" on Node < 18',
    );
  }
  const g = globalThis as any;
  g.fetch = u.fetch;
  g.Headers = u.Headers;
  g.Request = u.Request;
  g.Response = u.Response;
  g.FormData = u.FormData;
  g.File = g.File ?? u.File;
  if (streamWeb) {
    g.ReadableStream = g.ReadableStream ?? streamWeb.ReadableStream;
    g.WritableStream = g.WritableStream ?? streamWeb.WritableStream;
    g.TransformStream = g.TransformStream ?? streamWeb.TransformStream;
  }
}

export {};