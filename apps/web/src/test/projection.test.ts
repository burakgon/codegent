import { describe, expect, test } from "bun:test";
import type { Card } from "@codegent/protocol";
import { columnOf } from "../projection";

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
