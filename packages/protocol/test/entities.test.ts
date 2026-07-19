import { test, expect } from "bun:test";
import { CardSchema, ProjectSchema } from "../src/entities";

test("card schema accepts a valid card and rejects bad phase", () => {
  const ok = CardSchema.safeParse({
    id: 1, projectId: "p1", title: "t", body: "", phase: "queued",
    agent: "claude", worktreeId: null, position: 0, createdAt: 1, updatedAt: 1,
  });
  expect(ok.success).toBe(true);
  const bad = CardSchema.safeParse({ ...ok.data, phase: "flying" } as any);
  expect(bad.success).toBe(false);
});

test("project schema requires absolute-ish path", () => {
  expect(ProjectSchema.safeParse({ id: "p", name: "n", path: "/tmp/x", baseBranch: "main", createdAt: 1 }).success).toBe(true);
});
