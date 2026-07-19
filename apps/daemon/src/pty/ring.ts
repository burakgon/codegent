export const RING_CAP = 200 * 1024;

/**
 * Fixed-capacity circular byte buffer holding the most recent `cap` bytes
 * of PTY output (scrollback). `snapshot()` returns bytes in arrival order.
 */
export class Ring {
  private buf: Uint8Array;
  private len = 0; // valid bytes
  private head = 0; // write index (== oldest byte index once full)
  private flushChain: Promise<unknown> = Promise.resolve();

  constructor(private cap: number) {
    this.buf = new Uint8Array(cap);
  }

  push(b: Uint8Array): void {
    if (b.length >= this.cap) {
      this.buf.set(b.subarray(b.length - this.cap));
      this.head = 0;
      this.len = this.cap;
      return;
    }
    const tail = Math.min(b.length, this.cap - this.head);
    this.buf.set(b.subarray(0, tail), this.head);
    if (b.length > tail) this.buf.set(b.subarray(tail), 0);
    this.head = (this.head + b.length) % this.cap;
    this.len = Math.min(this.cap, this.len + b.length);
  }

  snapshot(): Uint8Array {
    const out = new Uint8Array(this.len);
    if (this.len < this.cap) {
      out.set(this.buf.subarray(0, this.len));
      return out;
    }
    out.set(this.buf.subarray(this.head));
    out.set(this.buf.subarray(0, this.head), this.cap - this.head);
    return out;
  }

  flushTo(path: string): Promise<void> {
    // Serialized on a promise chain: the 3s interval flush and the final
    // on-exit flush must never interleave writes to the same file (Plan-1
    // race). Snapshot is taken when the chained step runs — latest data wins.
    const p = this.flushChain.then(() => Bun.write(path, this.snapshot())).then(() => {});
    this.flushChain = p.catch(() => {}); // one failed flush must not poison the chain
    return p;
  }

  static async load(path: string, cap: number): Promise<Ring> {
    const r = new Ring(cap);
    const f = Bun.file(path);
    if (await f.exists()) r.push(new Uint8Array(await f.arrayBuffer()));
    return r;
  }
}
