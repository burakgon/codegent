import type { Database } from "bun:sqlite";
import type { Project } from "@rvmp/protocol";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const rowToProject = (r: any): Project => ({
  id: r.id, name: r.name, path: r.path, baseBranch: r.base_branch, createdAt: r.created_at,
  workerLimit: r.worker_limit ?? 1,
  defaultAgent: r.default_agent ?? null,
  setupScript: r.setup_script ?? "",
  copyGlobs: JSON.parse(r.copy_globs ?? "[]"),
  mode: r.mode ?? "auto",
});

export function createProject(db: Database, p: { name: string; path: string; baseBranch: string }): Project {
  const id = `${slug(p.name)}-${crypto.randomUUID().slice(0, 4)}`;
  const now = Date.now();
  db.query(`INSERT INTO projects (id, name, path, base_branch, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`)
    .run(id, p.name, p.path, p.baseBranch, now);
  return {
    id, name: p.name, path: p.path, baseBranch: p.baseBranch, createdAt: now, workerLimit: 1,
    defaultAgent: null, setupScript: "", copyGlobs: [], mode: "auto",
  };
}

/** §8 project settings (Part 4) — engine reads these on every worktree create. */
export function updateProjectSettings(
  db: Database, id: string,
  patch: Partial<Pick<Project, "defaultAgent" | "setupScript" | "copyGlobs" | "mode">>,
): Project | null {
  const cur = getProject(db, id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  db.query(`UPDATE projects SET default_agent = ?2, setup_script = ?3, copy_globs = ?4, mode = ?5 WHERE id = ?1`)
    .run(id, next.defaultAgent, next.setupScript, JSON.stringify(next.copyGlobs), next.mode);
  return getProject(db, id);
}

export function getProject(db: Database, id: string): Project | null {
  const r = db.query(`SELECT * FROM projects WHERE id = ?1`).get(id) as any;
  return r ? rowToProject(r) : null;
}

export function setWorkerLimit(db: Database, id: string, n: number): Project | null {
  const r = db.query(`UPDATE projects SET worker_limit = ?2 WHERE id = ?1 RETURNING *`).get(id, n) as any;
  return r ? rowToProject(r) : null;
}

export function listProjects(db: Database): Project[] {
  return db.query(`SELECT * FROM projects ORDER BY created_at`).all().map(rowToProject);
}
