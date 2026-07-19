// Pure, connection-independent core of the /ws client (api.ts owns the actual
// WebSocket, timers, and DOM globals — nothing here may touch any of those, so
// this file stays unit-testable under bare `bun test`).

/** Backoff for reconnect attempt n (0-based): 1s → 2s → 4s → 8s, capped at
 * 15s, then ±20% jitter so a daemon restart doesn't get a thundering herd of
 * perfectly synchronized tabs. `rand` is injectable for tests. */
export const nextDelay = (attempt: number, rand: () => number = Math.random): number => {
  const base = Math.min(1000 * 2 ** attempt, 15_000);
  return Math.round(base * (0.8 + rand() * 0.4));
};

export type TermHandler = (bytes: Uint8Array) => void;

/** Run a callback set as a snapshot so one broken subscriber cannot prevent
 * the remaining reconnect/state work from completing. */
export function callCallbacks<Args extends unknown[]>(
  callbacks: Iterable<(...args: Args) => void>,
  ...args: Args
): void {
  for (const cb of [...callbacks]) {
    try { cb(...args); } catch { /* subscriber failures are isolated */ }
  }
}

export const MAX_PENDING_FRAMES = 256;

/**
 * Sub bookkeeping + outbound queue. The handler map is the single source of
 * truth for which sids are subscribed: on every socket open (first or re-)
 * the connection layer re-sends `sub` for exactly `sids()`. Sub frames are
 * therefore never queued — a queued sub plus a map-driven resub would
 * double-subscribe, and the server replays the full ring snapshot per sub.
 * The bounded queue holds only input/resize frames awaiting an open socket;
 * resize frames coalesce by sid so reconnect sends only the newest geometry.
 *
 * `close()` empties both and rejects further use — v0.1's close() left the
 * handlers registered and the queue accepting sends forever (the leak this
 * type exists to make testable).
 */
export class Resubscriber {
  private handlers = new Map<string, TermHandler>();
  private pending: Array<{ frame: string; coalesceKey: string | null }> = [];
  private closed = false;

  add(sid: string, onData: TermHandler): void {
    if (!this.closed) this.handlers.set(sid, onData);
  }
  remove(sid: string): void {
    this.handlers.delete(sid);
  }
  /** Route an incoming term frame; frames for unknown sids are dropped. */
  dispatch(sid: string, bytes: Uint8Array): void {
    this.handlers.get(sid)?.(bytes);
  }
  sids(): string[] {
    return [...this.handlers.keys()];
  }
  enqueue(frame: string, coalesceKey: string | null = null): void {
    if (this.closed) return;
    if (coalesceKey !== null) {
      const prior = this.pending.findIndex(item => item.coalesceKey === coalesceKey);
      if (prior >= 0) this.pending.splice(prior, 1);
    }
    this.pending.push({ frame, coalesceKey });
    if (this.pending.length > MAX_PENDING_FRAMES) this.pending.splice(0, this.pending.length - MAX_PENDING_FRAMES);
  }
  /** Empty the queue and return the frames in enqueue order. */
  drain(): string[] {
    return this.pending.splice(0).map(item => item.frame);
  }
  close(): void {
    this.closed = true;
    this.handlers.clear();
    this.pending.length = 0;
  }
  get isClosed(): boolean {
    return this.closed;
  }
}
