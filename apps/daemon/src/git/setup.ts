import { cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Project, Worktree } from "@codegent/protocol";

// §8 worktree bootstrap (Part 4): a fresh worktree without .env/node_modules
// is unusable — before the agent spawns, [1] copy-globs bring untracked
// config files over from the main checkout, [2] the per-project setup script
// runs inside the worktree. Script output goes to a daemon log file, never a
// card surface (principle 1); failures throw and land as start_failed.

const SETUP_TIMEOUT_MS = 120_000;

export class WorktreeSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeSetupError";
  }
}

/** Copy files matching the project's copy-globs from the main checkout into
 * the worktree (paths preserved, parents created). `.git`/`.codegent` never
 * cross. Returns the copied relative paths (tests + log). */
export function copyGlobsInto(project: Pick<Project, "path" | "copyGlobs">, wtPath: string): string[] {
  const copied: string[] = [];
  for (const pattern of project.copyGlobs) {
    const glob = new Bun.Glob(pattern);
    for (const rel of glob.scanSync({ cwd: project.path, dot: true, onlyFiles: true })) {
      if (rel.startsWith(".git/") || rel.startsWith(".codegent/") || rel === ".git") continue;
      const dst = join(wtPath, rel);
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(join(project.path, rel), dst);
      copied.push(rel);
    }
  }
  return copied;
}

/** Run the project's setup script in the worktree via the user's shell.
 * Output → `<logDir>/setup-<wtId>.log`; non-zero exit or timeout throws. */
export async function runSetupScript(
  project: Pick<Project, "setupScript">,
  wt: Pick<Worktree, "id" | "path">,
  logDir: string,
): Promise<void> {
  const script = project.setupScript.trim();
  if (!script) return;
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `setup-${wt.id}.log`);
  const log = Bun.file(logPath);
  const shell = process.env.SHELL || "/bin/sh";
  const proc = Bun.spawn({
    cmd: [shell, "-lc", script],
    cwd: wt.path,
    env: { ...process.env, CODEGENT_WORKTREE: wt.path },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), SETUP_TIMEOUT_MS);
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  await Bun.write(log, `$ ${script}\n--- stdout ---\n${out}\n--- stderr ---\n${err}\n--- exit ${code} ---\n`);
  if (code !== 0) {
    throw new WorktreeSetupError(`worktree setup script failed (exit ${code}) — see ${logPath}`);
  }
}

/** The full bootstrap, in order. `logDir` defaults keep tests self-contained. */
export async function bootstrapWorktree(
  project: Pick<Project, "path" | "copyGlobs" | "setupScript">,
  wt: Pick<Worktree, "id" | "path">,
  logDir = join(tmpdir(), "codegent-setup-logs"),
): Promise<{ copied: string[] }> {
  const copied = copyGlobsInto(project, wt.path);
  await runSetupScript(project, wt, logDir);
  return { copied };
}
