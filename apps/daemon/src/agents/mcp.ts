import type { Database } from "bun:sqlite";
import { appendTimeline } from "../store/timeline";
import { markPendingComplete, touchDispatchProgress } from "../store/attempts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function getCard(db: Database, id: number): { id: number; title: string; body: string } | null {
  if (!Number.isInteger(id)) return null;
  return db.query(`SELECT id, title, body FROM cards WHERE id = ?1`).get(id) as any;
}

function getDispatch(db: Database, id: string): { id: string; status: string; worktreePath: string | null } | null {
  const r = db.query(
    `SELECT d.id AS id, d.status AS status, w.path AS wt_path
     FROM dispatches d JOIN attempts a ON a.id = d.attempt_id
     LEFT JOIN worktrees w ON w.id = a.worktree_id
     WHERE d.id = ?1`,
  ).get(id) as any;
  return r ? { id: r.id, status: r.status, worktreePath: r.wt_path ?? null } : null;
}

/** `git status --porcelain` in the attempt worktree; null when the check itself
 * cannot run (missing dir, not a repo) — an unverifiable worktree does not
 * block completion, T8 re-evaluates the attempt's real diff anyway. */
async function porcelain(cwd: string): Promise<string | null> {
  try {
    const p = Bun.spawn({ cmd: ["git", "status", "--porcelain"], cwd, stdout: "pipe", stderr: "pipe" });
    if ((await p.exited) !== 0) return null;
    return (await new Response(p.stdout).text()).replace(/\n$/, "");
  } catch {
    return null;
  }
}

/**
 * The agent-plane API consumed by the MCP sidecar (`mcp-entry.ts`), mounted on
 * the loopback hook receiver — sidecars authenticate with the signal-plane
 * token, and the daemon's UI token never crosses into agent processes. Unlike
 * the hook plane this surface returns real errors: they land in the agent's
 * own conversation as MCP tool errors, which is §6.1's single sanctioned echo
 * channel. Nothing here emits domain events or touches card phase — that is
 * the engine's job (T8).
 */
export async function handleAgentApi(req: Request, url: URL, body: unknown, db: Database): Promise<Response> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  if (url.pathname === "/api/agent/task" && req.method === "GET") {
    const card = getCard(db, Number(url.searchParams.get("card")));
    if (!card) return json({ error: "card not found" }, 404);
    // `acceptance` has no column yet — kept in the shape so the tool contract
    // (spec §6: title / description / acceptance notes) is stable when it lands.
    return json({ title: card.title, body: card.body, acceptance: null });
  }

  if (url.pathname === "/api/agent/progress" && req.method === "POST") {
    // Existence before body validation — same 404-before-400 precedence as the
    // project-scoped routes in http/server.ts.
    const card = getCard(db, Number(b.card));
    if (!card) return json({ error: "card not found" }, 404);
    if (typeof b.dispatch !== "string" || !b.dispatch) return json({ error: "dispatch required" }, 400);
    if (typeof b.note !== "string" || !b.note.trim()) return json({ error: "note required" }, 400);
    appendTimeline(db, card.id, "progress", b.note);
    touchDispatchProgress(db, b.dispatch, Date.now()); // the heartbeat the engine reads
    return json({ ok: true });
  }

  if (url.pathname === "/api/agent/complete" && req.method === "POST") {
    const card = getCard(db, Number(b.card));
    if (!card) return json({ error: "card not found" }, 404);
    const dispatch = typeof b.dispatch === "string" && b.dispatch ? getDispatch(db, b.dispatch) : null;
    if (!dispatch) return json({ error: "dispatch not found" }, 404);
    if (typeof b.summary !== "string") return json({ error: "summary required" }, 400);
    // Dirty-worktree gate (VK stop-gate, spec §6.1): the porcelain echoed here
    // reaches ONLY the agent's conversation via the sidecar's tool error — it
    // must never surface in our UI or on the event bus.
    if (dispatch.worktreePath) {
      const status = await porcelain(dispatch.worktreePath);
      if (status) return json({ error: `worktree has uncommitted changes:\n${status}` }, 409);
    }
    // Latch-guarded pending-complete marker (pre-T8): only a running dispatch
    // records it. A stale retry is acknowledged and dropped — never an error,
    // the agent already did its part ("report completion exactly once").
    const recorded = markPendingComplete(db, dispatch.id);
    return json(recorded ? { ok: true, pending: true } : { ok: true, stale: true });
  }

  return json({ error: "not found" }, 404);
}
