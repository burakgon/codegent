import React, { useContext, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, SessionMeta, Worktree } from "@codegent/protocol";
import { api } from "../api";
import { AppCtx } from "./Shell";
import { SessionRail } from "./SessionRail";
import { GhosttyTerm } from "./GhosttyTerm";

export function TerminalView({ project }: { project: Project }) {
  const { projectId } = useContext(AppCtx);
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["sessions", projectId], queryFn: () => api.get<SessionMeta[]>(`/api/projects/${projectId}/sessions`) });
  const worktrees = useQuery({ queryKey: ["worktrees", projectId], queryFn: () => api.get<Worktree[]>(`/api/projects/${projectId}/worktrees`) });
  const [open, setOpen] = useState<string[]>([]);       // ≤2 pane sids
  const [focused, setFocused] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Panes belong to a project — reset synchronously on project switch so a
  // pane from project A never renders inside project B's view (in-render
  // reset per React's "resetting state when a prop changes" pattern).
  const [prevPid, setPrevPid] = useState(projectId);
  if (prevPid !== projectId) { setPrevPid(projectId); setOpen([]); setFocused(null); setErr(null); }

  const show = (id: string) => {
    setOpen(prev => prev.includes(id) ? prev : prev.length < 2 ? [...prev, id] : [prev[1], id]);
    setFocused(id);
  };

  const openNew = async (t: { kind: "main" } | { kind: "worktree"; id: string } | { kind: "new"; name: string; base?: string }) => {
    setErr(null);
    try {
      let cwd = project.path, worktreeId: string | null = null, title = "main";
      if (t.kind === "worktree") {
        const w = worktrees.data!.find(w => w.id === t.id)!;
        cwd = w.path; worktreeId = w.id; title = w.branch;
      } else if (t.kind === "new") {
        // Daemon errors come back as { error } json — don't open a shell in the
        // wrong cwd on a failed worktree creation.
        const w = await api.post<Worktree | { error: string }>(`/api/projects/${projectId}/worktrees`, { name: t.name, base: t.base });
        if (!("id" in w)) { setErr(w.error); return; }
        qc.invalidateQueries({ queryKey: ["worktrees", projectId] });
        cwd = w.path; worktreeId = w.id; title = w.branch;
      }
      const meta = await api.post<SessionMeta | { error: string }>(`/api/projects/${projectId}/sessions`, { cwd, worktreeId, title });
      if (!("id" in meta)) { setErr(meta.error); return; }
      qc.invalidateQueries({ queryKey: ["sessions", projectId] });
      show(meta.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e)); // e.g. daemon unreachable
    }
  };

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <SessionRail sessions={sessions.data ?? []} worktrees={worktrees.data ?? []}
        openIds={open} focusedId={focused} onPick={show} onNew={openNew} />
      <div style={{ flex: 1, display: "flex", minWidth: 0, position: "relative" }}>
        {err && (
          <div style={{ position: "absolute", top: 10, left: 12, right: 12, zIndex: 20, fontSize: 11, color: "var(--red)", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px" }}>
            {err}
          </div>
        )}
        {open.length === 0 && (
          <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--dim)", fontSize: 12 }}>
            pick a session — or press “+ terminal · main”
          </div>
        )}
        {open.map((sid, i) => (
          <React.Fragment key={sid}>
            {i > 0 && <div style={{ width: 3, cursor: "col-resize", background: "var(--surface-2)" }} />}
            <GhosttyTerm sid={sid} focused={focused === sid} onFocus={() => setFocused(sid)} />
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
