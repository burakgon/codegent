import { describe, test, expect } from "bun:test";
import { nextDelay, Resubscriber } from "../wsCore";

// Reconnect backoff: 1s → 2s → 4s → 8s, capped at 15s, ±20% jitter.
describe("nextDelay", () => {
  const mid = () => 0.5; // jitter factor exactly 1.0

  test("doubles from 1s and caps at 15s", () => {
    expect(nextDelay(0, mid)).toBe(1000);
    expect(nextDelay(1, mid)).toBe(2000);
    expect(nextDelay(2, mid)).toBe(4000);
    expect(nextDelay(3, mid)).toBe(8000);
    expect(nextDelay(4, mid)).toBe(15000); // 16000 hits the cap
    expect(nextDelay(30, mid)).toBe(15000);
    expect(nextDelay(1e6, mid)).toBe(15000); // 2**1e6 = Infinity still capped
  });

  test("jitter spans exactly ±20% of the capped base", () => {
    expect(nextDelay(0, () => 0)).toBe(800);
    expect(nextDelay(0, () => 1)).toBe(1200);
    expect(nextDelay(4, () => 0)).toBe(12000);
    expect(nextDelay(4, () => 1)).toBe(18000);
  });

  test("real rng stays inside the jitter band", () => {
    for (let i = 0; i < 1000; i++) {
      const first = nextDelay(0);
      expect(first).toBeGreaterThanOrEqual(800);
      expect(first).toBeLessThanOrEqual(1200);
      const capped = nextDelay(9);
      expect(capped).toBeGreaterThanOrEqual(12000);
      expect(capped).toBeLessThanOrEqual(18000);
    }
  });
});

describe("Resubscriber", () => {
  const frame = (sid: string) => new TextEncoder().encode(sid);

  test("tracks sids and routes term frames to the right handler", () => {
    const r = new Resubscriber();
    const got: string[] = [];
    r.add("a", b => got.push("a:" + new TextDecoder().decode(b)));
    r.add("b", b => got.push("b:" + new TextDecoder().decode(b)));
    expect(r.sids().sort()).toEqual(["a", "b"]);
    r.dispatch("a", frame("x"));
    r.dispatch("b", frame("y"));
    r.dispatch("ghost", frame("z")); // unknown sid is silently dropped
    expect(got).toEqual(["a:x", "b:y"]);
  });

  test("remove drops the sid from routing and from the resub set", () => {
    const r = new Resubscriber();
    let hits = 0;
    r.add("a", () => hits++);
    r.remove("a");
    r.dispatch("a", frame(""));
    expect(hits).toBe(0);
    expect(r.sids()).toEqual([]);
  });

  test("re-add replaces the handler for a sid", () => {
    const r = new Resubscriber();
    const got: string[] = [];
    r.add("a", () => got.push("old"));
    r.add("a", () => got.push("new"));
    r.dispatch("a", frame(""));
    expect(got).toEqual(["new"]);
    expect(r.sids()).toEqual(["a"]); // still one sub, not two
  });

  test("queue drains in order and empties", () => {
    const r = new Resubscriber();
    r.enqueue("one");
    r.enqueue("two");
    expect(r.drain()).toEqual(["one", "two"]);
    expect(r.drain()).toEqual([]);
  });

  // close() empties handlers + queue — the v0.1 leak was a queue that kept
  // accepting sends forever after close and handlers that were never cleared.
  test("close empties handlers and queue", () => {
    const r = new Resubscriber();
    r.add("a", () => {});
    r.enqueue("pending");
    r.close();
    expect(r.isClosed).toBe(true);
    expect(r.sids()).toEqual([]);
    expect(r.drain()).toEqual([]);
  });

  test("nothing registers or queues after close", () => {
    const r = new Resubscriber();
    r.close();
    r.add("late", () => {});
    r.enqueue("late-frame");
    expect(r.sids()).toEqual([]);
    expect(r.drain()).toEqual([]);
  });
});
