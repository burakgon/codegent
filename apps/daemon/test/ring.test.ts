import { test, expect } from "bun:test";
import { Ring } from "../src/pty/ring";

test("ring keeps only last cap bytes", () => {
  const r = new Ring(10);
  r.push(new TextEncoder().encode("0123456789ABCDEF")); // 16 bytes into cap 10
  expect(new TextDecoder().decode(r.snapshot())).toBe("6789ABCDEF");
  r.push(new TextEncoder().encode("xy"));
  expect(new TextDecoder().decode(r.snapshot())).toBe("89ABCDEFxy");
});

test("ring flush/load roundtrip", async () => {
  const r = new Ring(1024);
  r.push(new TextEncoder().encode("persist me"));
  const p = `/tmp/rvmp-ring-${crypto.randomUUID()}.bin`;
  await r.flushTo(p);
  const r2 = await Ring.load(p, 1024);
  expect(new TextDecoder().decode(r2.snapshot())).toBe("persist me");
});

test("concurrent flushTo calls serialize — no torn file, every call resolves", async () => {
  // The Plan-1 race: interval flush vs final flush firing together. The chain
  // must (a) resolve every caller, (b) leave the file equal to a snapshot.
  const r = new Ring(64 * 1024);
  const p = `/tmp/rvmp-ring-race-${crypto.randomUUID()}.bin`;
  const flushes: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) {
    r.push(new TextEncoder().encode(`chunk-${i}|`.repeat(100)));
    flushes.push(r.flushTo(p));
  }
  await Promise.all(flushes);
  const onDisk = new Uint8Array(await Bun.file(p).arrayBuffer());
  // last serialized write carries the final state
  expect(new TextDecoder().decode(onDisk)).toBe(new TextDecoder().decode(r.snapshot()));
});
