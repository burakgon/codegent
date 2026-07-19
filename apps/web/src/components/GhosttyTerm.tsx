import React, { useContext, useEffect, useRef } from "react";
// Real engine API per docs/research/ghostty-web-spike.md (Task 3):
// `await init()` loads the shared WASM before the first `new Terminal`;
// onData/onResize are IEvent<T> — subscribing returns an IDisposable.
import { init, Terminal, FitAddon } from "ghostty-web";
import { AppCtx } from "./Shell";

// Upstream init() has no concurrent-call guard (two panes mounting at once
// would each run Ghostty.load()) — single-flight it here.
let wasmReady: Promise<void> | null = null;
const ensureInit = () => (wasmReady ??= init());

// The engine theme wants concrete color strings; resolve them from the same
// theme.css tokens the rest of the UI uses.
const cssColor = (token: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(token).trim();

export function GhosttyTerm({ sid, focused, onFocus }: { sid: string; focused: boolean; onFocus: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const { socket } = useContext(AppCtx);

  useEffect(() => {
    const el = ref.current!;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      await ensureInit();
      if (cancelled) return; // unmounted (or StrictMode first pass) while WASM loaded
      const term = new Terminal({
        cols: 100, rows: 30, fontSize: 12,
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        theme: { background: cssColor("--bg"), foreground: cssColor("--text") },
      });
      termRef.current = term;
      term.open(el);
      // Upstream stale-memory bug: a fresh terminal can start with a disposed
      // one's screen contents, and reset() does not clear it. Sanitize before
      // any bytes arrive (spike §3 caveat 1).
      term.write("\x1b[H\x1b[2J\x1b[3J");
      // Real cell metrics via FitAddon (spike-recorded API) instead of
      // guessed px-per-cell divisors; observeResize() re-fits on pane resize.
      const fit = new FitAddon();
      term.loadAddon(fit);
      const onResize = term.onResize(({ cols, rows }) => socket.resize(sid, cols, rows));
      const onData = term.onData(d => {
        if (d.length > 0) socket.input(sid, new TextEncoder().encode(d));
      });
      fit.fit(); // size to the pane before replay arrives
      fit.observeResize();
      // sub only after init + open + sanitize: the first frame is the full
      // ring snapshot. Guard zero-length writes — write("") crashes the WASM
      // (spike §3 caveat 2), and a fresh session's ring snapshot IS empty.
      const offBytes = socket.sub(sid, bytes => {
        if (bytes.length > 0) term.write(bytes);
      });
      socket.resize(sid, term.cols, term.rows); // sync the PTY even if fit() no-oped
      cleanup = () => {
        offBytes(); // detach BEFORE dispose — no bytes may hit a disposed terminal
        onData.dispose();
        onResize.dispose();
        fit.dispose(); // disconnects its ResizeObserver
        term.dispose();
        termRef.current = null;
      };
    })();

    return () => { cancelled = true; cleanup?.(); cleanup = null; };
  }, [sid, socket]);

  // Rail picks focus an already-open pane without a click; on first mount the
  // engine's open() self-focuses, so the null termRef during init is fine.
  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  return (
    <div data-term ref={ref} onMouseDown={onFocus}
      style={{ flex: 1, minWidth: 0, opacity: focused ? 1 : .75, transition: "opacity .2s", background: "var(--bg)" }} />
  );
}
