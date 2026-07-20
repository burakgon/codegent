import { describe, expect, test } from "bun:test";
import type { Card, SessionMeta } from "@codegent/protocol";
import {
  cardRoutesToTerminal,
  columnOf,
  interruptedMessage,
  railSessionEntries,
  terminalSessionForCard,
} from "../projection";

const base: Card = {
  id: 1,
  projectId: "p",
  title: "Task",
  body: "",
  phase: "queued",
  agent: "claude",
  worktreeId: null,
  position: 1,
  createdAt: 1,
  updatedAt: 1,
  workingSub: null,
  errorKind: null,
  reviewSub: null,
  inputKind: null,
  inputSince: null,
  round: 1,
  auto: true,
  attemptId: null,
};

describe("columnOf", () => {
  test("projects every phase and orchestration-flag combination", () => {
    const phases: Card["phase"][] = ["queued", "working", "review", "done", "cancelled"];
    const inputKinds: Card["inputKind"][] = [null, "question", "permission", "silent"];
    const workingSubs: Card["workingSub"][] = [null, "starting", "running", "stopped", "error"];
    const errorKinds: Card["errorKind"][] = [null, "start_failed", "crashed", "interrupted"];

    for (const phase of phases) {
      for (const inputKind of inputKinds) {
        for (const workingSub of workingSubs) {
          for (const errorKind of errorKinds) {
            const card: Card = { ...base, phase, inputKind, workingSub, errorKind };
            const expected = phase === "queued" ? "queue"
              : phase === "working" ? (inputKind === null ? "running" : "waiting")
              : phase === "review" ? "review"
              : phase === "done" ? "done"
              : null;
            expect(columnOf(card)).toBe(expected);
          }
        }
      }
    }
  });

  test("keeps queued start failures in Queue", () => {
    expect(columnOf({ ...base, errorKind: "start_failed" })).toBe("queue");
  });
});

test("interruptedMessage pluralizes a project banner", () => {
  expect(interruptedMessage(1)).toBe("1 card interrupted — resume from its card");
  expect(interruptedMessage(2)).toBe("2 cards interrupted — resume from their cards");
});

const session = (over: Partial<SessionMeta> & Pick<SessionMeta, "id" | "kind" | "live" | "createdAt">): SessionMeta => ({
  id: over.id,
  projectId: "p",
  kind: over.kind,
  title: over.title ?? over.id,
  cwd: "/tmp",
  worktreeId: null,
  live: over.live,
  createdAt: over.createdAt,
  adapterSessionId: null,
  attemptId: over.attemptId ?? null,
});

describe("terminal session projections", () => {
  test("rail puts live agents then the replayable current-attempt ring above unchanged shells", () => {
    const sessions = [
      session({ id: "shell-a", kind: "shell", live: true, createdAt: 1 }),
      session({ id: "dead-old", kind: "agent", live: false, createdAt: 2, attemptId: 7 }),
      session({ id: "shell-dead", kind: "shell", live: false, createdAt: 3 }),
      session({ id: "dead-new", kind: "agent", live: false, createdAt: 4, attemptId: 7 }),
      session({ id: "live-agent", kind: "agent", live: true, createdAt: 5, attemptId: 7 }),
      session({ id: "dead-stale", kind: "agent", live: false, createdAt: 6, attemptId: 99 }),
      session({ id: "shell-b", kind: "shell", live: true, createdAt: 7 }),
    ];
    const entries = railSessionEntries(sessions, [{ ...base, attemptId: 7, agent: "codex" }]);

    expect(entries.map(entry => entry.session.id)).toEqual(["live-agent", "dead-new", "shell-a", "shell-b"]);
    expect(entries.map(entry => entry.agent)).toEqual(["codex", "codex", null, null]);
    expect(entries.map(entry => entry.previous)).toEqual([false, true, false, false]);
  });

  test("card routing covers running/waiting and errors, with live focus precedence", () => {
    expect(cardRoutesToTerminal({ phase: "working", workingSub: "running" })).toBe(true);
    expect(cardRoutesToTerminal({ phase: "working", workingSub: "error" })).toBe(true);
    expect(cardRoutesToTerminal({ phase: "working", workingSub: "starting" })).toBe(false);
    expect(cardRoutesToTerminal({ phase: "working", workingSub: "stopped" })).toBe(false);
    expect(cardRoutesToTerminal({ phase: "review", workingSub: null })).toBe(false);

    const frozen = session({ id: "frozen", kind: "agent", live: false, createdAt: 20, attemptId: 7 });
    const live = session({ id: "live", kind: "agent", live: true, createdAt: 10, attemptId: 7 });
    expect(terminalSessionForCard({ attemptId: 7 }, [live, frozen])?.id).toBe("live");
    expect(terminalSessionForCard({ attemptId: 7 }, [frozen])?.id).toBe("frozen");
    expect(terminalSessionForCard({ attemptId: null }, [live])).toBeNull();
  });
});
