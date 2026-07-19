import React, { useState } from "react";
import type { SessionMeta, Worktree } from "@codegent/protocol";

export function SessionRail({ sessions, worktrees, openIds, focusedId, onPick, onNew }: {
  sessions: SessionMeta[]; worktrees: Worktree[]; openIds: string[]; focusedId: string | null;
  onPick: (id: string) => void;
  onNew: (target: { kind: "main" } | { kind: "worktree"; id: string } | { kind: "new"; name: string; base?: string }) => void;
}) {
  const [picker, setPicker] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);
  return (
    <div style={{ width: 216, borderRight: "1px solid var(--surface-2)", background: "var(--bg-deep)", padding: 10, display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ fontSize: 10, fontWeight: 650, letterSpacing: ".8px", color: "var(--dim)", margin: "4px 0 8px" }}>SESSIONS</div>
      {sessions.filter(s => s.live).map(s => (
        <div key={s.id} onClick={() => onPick(s.id)}
          style={{ display: "flex", gap: 9, padding: "7px 9px", borderRadius: 8, cursor: "pointer",
            background: s.id === focusedId ? "var(--surface)" : "transparent",
            border: `1px solid ${s.id === focusedId ? "var(--border)" : "transparent"}` }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: s.worktreeId ? "#38bdf8" : "#6b7280", marginTop: 4, flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: s.id === focusedId ? "var(--text)" : "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
            <div style={{ fontSize: 10, color: "var(--dim)" }}>{openIds.includes(s.id) ? "on screen" : "shell"}</div>
          </div>
        </div>
      ))}
      <div style={{ position: "relative", marginTop: 6 }}>
        <div onClick={() => setPicker(p => !p)}
          style={{ display: "flex", justifyContent: "center", gap: 5, border: "1px dashed var(--border)", borderRadius: 8, color: "var(--dim)", fontSize: 11, padding: "7px 9px", cursor: "pointer" }}>
          + terminal · main
        </div>
        {picker && (
          <div style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, right: 0, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 6, zIndex: 30 }}>
            <div style={{ fontSize: 10, fontWeight: 650, color: "var(--dim)", padding: "4px 8px 6px", letterSpacing: ".6px" }}>OPEN WHERE?</div>
            <PickRow label="main" hint="default" onClick={() => { onNew({ kind: "main" }); setPicker(false); }} />
            {worktrees.filter(w => w.state === "active").map(w => (
              <PickRow key={w.id} label={w.branch} onClick={() => { onNew({ kind: "worktree", id: w.id }); setPicker(false); }} />
            ))}
            <div style={{ borderTop: "1px solid var(--surface-2)", margin: "5px 4px" }} />
            {newName === null
              ? <PickRow label="in a new worktree…" onClick={() => setNewName("")} />
              : <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
                  placeholder="branch name — e.g. spike"
                  onKeyDown={e => {
                    if (e.key === "Enter" && newName.trim()) { onNew({ kind: "new", name: newName.trim() }); setNewName(null); setPicker(false); }
                    if (e.key === "Escape") setNewName(null);
                  }}
                  style={{ width: "100%", boxSizing: "border-box", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 11, padding: "6px 8px", outline: "none", marginTop: 4 }} />}
          </div>
        )}
      </div>
    </div>
  );
}

function PickRow({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) {
  return (
    <div onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, fontSize: 11, color: "var(--text-2)", cursor: "pointer" }}
      onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
      {label}{hint && <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--dim)" }}>{hint}</span>}
    </div>
  );
}
