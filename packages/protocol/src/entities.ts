import { z } from "zod";

export const CardPhase = z.enum(["queued", "running", "waiting", "review", "done", "cancelled"]);
export type CardPhase = z.infer<typeof CardPhase>;

export const ProjectSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), path: z.string().min(1),
  baseBranch: z.string().min(1), createdAt: z.number(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CardSchema = z.object({
  id: z.int(), projectId: z.string(), title: z.string().min(1),
  body: z.string(), phase: CardPhase, agent: z.enum(["claude", "codex", "none"]),
  worktreeId: z.string().nullable(), position: z.number(),
  createdAt: z.number(), updatedAt: z.number(),
});
export type Card = z.infer<typeof CardSchema>;

export const SessionMetaSchema = z.object({
  id: z.string(), projectId: z.string(), kind: z.literal("shell"),
  title: z.string(), cwd: z.string(), worktreeId: z.string().nullable(),
  live: z.boolean(), createdAt: z.number(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export const WorktreeSchema = z.object({
  id: z.string(), projectId: z.string(), branch: z.string(), path: z.string(),
  base: z.string(), state: z.enum(["active", "archived"]),
});
export type Worktree = z.infer<typeof WorktreeSchema>;
