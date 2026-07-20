import { describe, expect, test } from "bun:test";
import type { DomainEvent } from "@codegent/protocol";
import { Watchdog } from "../src/orchestrator/watchdog";

describe("manual override detection watchdog", () => {
  test("persistent running-versus-blocked disagreement emits one textless mismatch notice", () => {
    let now = 1_000;
    const events: DomainEvent[] = [];
    const watchdog = new Watchdog({
      clock: () => now,
      thresholdMs: 5_000,
      emit: event => events.push(event),
    });
    const observation = {
      cardId: 7,
      manual: { state: "running", since: 1_000 } as const,
      detected: { state: "blocked", since: 1_000 } as const,
    };

    watchdog.tick([observation]);
    now = 6_001;
    watchdog.tick([observation]);
    watchdog.tick([observation]);

    expect(events).toEqual([{ t: "notice", cardId: 7, kind: "mismatch" }]);
    expect(Object.keys(events[0]!).sort()).toEqual(["cardId", "kind", "t"]);
    expect(JSON.stringify(events[0])).not.toMatch(/text|message|content|screen|terminal/i);
  });

  test("agreement emits no notice", () => {
    let now = 10_000;
    const events: DomainEvent[] = [];
    const watchdog = new Watchdog({
      clock: () => now,
      thresholdMs: 1_000,
      emit: event => events.push(event),
    });

    watchdog.tick([{
      cardId: 3,
      manual: { state: "running", since: 10_000 },
      detected: { state: "working", since: 10_000 },
    }]);
    now = 20_000;
    watchdog.tick([{
      cardId: 3,
      manual: { state: "running", since: 10_000 },
      detected: { state: "working", since: 10_000 },
    }]);

    expect(events).toEqual([]);
  });

  test("persistent needs-input-versus-working disagreement uses the inverse rule", () => {
    let now = 30_000;
    const events: DomainEvent[] = [];
    const watchdog = new Watchdog({
      clock: () => now,
      thresholdMs: 2_000,
      emit: event => events.push(event),
    });
    const observation = {
      cardId: 11,
      manual: { state: "needs-input", since: 30_000 } as const,
      detected: { state: "working", since: 30_000 } as const,
    };

    watchdog.tick([observation]);
    now = 32_001;
    watchdog.tick([observation]);

    expect(events).toEqual([{ t: "notice", cardId: 11, kind: "mismatch" }]);
  });
});
