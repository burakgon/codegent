import React, { useEffect, useRef, useState } from "react";
import { CardAgent } from "@codegent/protocol";
import type { Card, Project } from "@codegent/protocol";
import { api } from "../api";

// §8 add-project sheet: daemon-side path autocomplete (the browser may be
// remote — never a native picker), a git-clone tab, base branch, default
// agent, execution mode, and the worktree bootstrap (setup script +
// copy-globs). Non-git folder → one-click "git init"; clone creates the path.

const field: React.CSSProperties = { width: "100%", padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 6, outline: "none", background: "var(--bg)", color: "var(--text)", font: "inherit", fontSize: 11 };
const label: React.CSSProperties = { fontSize: 10, fontWeight: 650, letterSpacing: ".6px", color: "var(--dim)", textTransform: "uppercase", margin: "10px 0 4px" };

export function ProjectSheet({ onDone, onClose }: { onDone: (project: Project) => void; onClose?: () => void }) {
  const [tab, setTab] = useState<"path" | "clone">("path");
  const [path, setPath] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [agent, setAgent] = useState<Card["agent"]>("claude");
  const [mode, setMode] = useState<Project["mode"]>("auto");
  const [setupScript, setSetupScript] = useState("");
  const [copyGlobs, setCopyGlobs] = useState("");
  const [suggest, setSuggest] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [canInit, setCanInit] = useState(false);
  const [busy, setBusy] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Daemon-side autocomplete, debounced; home-anchored by the server.
  useEffect(() => {
    if (tab !== "path") return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      void api.get<{ paths: string[] }>(`/api/state/path-complete?q=${encodeURIComponent(path)}`)
        .then(r => setSuggest(r.paths)).catch(() => setSuggest([]));
    }, 150);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [path, tab]);

  const submit = async (gitInit = false) => {
    if (busy) return; // Enter during a slow POST must not double-create (review B-Imp)
    setErr("");
    setBusy(true);
    try {
      const target = path.replace(/\/+$/, "");
      const name = target.split("/").pop() || "project";
      const body: Record<string, unknown> = { name, path: target };
      if (baseBranch.trim()) body.baseBranch = baseBranch.trim();
      if (tab === "clone") body.clone = cloneUrl.trim();
      if (gitInit) body.gitInit = true;
      const globs = copyGlobs.split(",").map(s => s.trim()).filter(Boolean);
      // ONE request (review B-Imp): create + settings land atomically — a
      // failed second call can never strand a default-configured project.
      body.settings = { defaultAgent: agent, mode, setupScript, copyGlobs: globs };
      const project = await api.post<Project>("/api/projects", body);
      onDone(project);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setCanInit(message.includes("not a git repository"));
      setErr(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-project-sheet style={{ width: 460, padding: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>Add a project</div>
        <div style={{ display: "flex", gap: 2, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 2 }}>
          {(["path", "clone"] as const).map(t => (
            <button key={t} type="button" onClick={() => setTab(t)}
              style={{ padding: "3px 10px", border: 0, borderRadius: 6, cursor: "pointer", fontSize: 10, font: "inherit",
                background: tab === t ? "var(--violet)" : "transparent",
                color: tab === t ? "var(--text-on-accent)" : "var(--ctrl)" }}>
              {t === "path" ? "Local path" : "git clone"}
            </button>
          ))}
        </div>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ marginLeft: "auto", border: 0, background: "none", color: "var(--dim)", fontSize: 13, cursor: "pointer" }}>×</button>
        )}
      </div>

      {tab === "clone" && (
        <>
          <div style={label}>Repository URL</div>
          <input value={cloneUrl} onChange={e => setCloneUrl(e.target.value)} placeholder="https://github.com/you/repo.git" style={field} />
        </>
      )}
      <div style={label}>{tab === "clone" ? "Clone into" : "Path"}</div>
      <input value={path} onChange={e => { setPath(e.target.value); setCanInit(false); }}
        placeholder={tab === "clone" ? "~/code/repo (created by the clone)" : "~/code/your-repo"}
        onKeyDown={e => { if (e.key === "Enter" && path.trim()) void submit(); }} style={field} />
      {suggest.length > 0 && tab === "path" && (
        <div data-path-suggest style={{ marginTop: 3, border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", maxHeight: 130, overflow: "auto" }}>
          {suggest.map(s => (
            <div key={s} onClick={() => { setPath(s); setSuggest([]); }}
              style={{ padding: "5px 9px", fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-2)", cursor: "pointer" }}>{s}</div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={label}>Base branch</div>
          <input value={baseBranch} onChange={e => setBaseBranch(e.target.value)} placeholder="auto (origin/HEAD)" style={field} />
        </div>
        <div>
          <div style={label}>Default agent</div>
          <select value={agent} onChange={e => setAgent(e.target.value as Card["agent"])} aria-label="Default agent"
            style={{ ...field, width: 110, padding: "5px 8px" }}>
            {CardAgent.options.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <div style={label}>Mode</div>
          <div style={{ display: "flex", gap: 4 }}>
            {(["auto", "host", "ask"] as const).map(m => (
              <button key={m} type="button" onClick={() => setMode(m)} title={m === "host" ? "run agents without a sandbox" : undefined}
                style={{ padding: "5px 8px", border: `1px solid ${mode === m ? "var(--violet-2)" : "var(--border)"}`, borderRadius: 6, background: "var(--bg)", color: mode === m ? "var(--violet-2)" : "var(--ctrl)", font: "inherit", fontSize: 10, cursor: "pointer" }}>{m}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={label}>Worktree setup script (runs in every fresh worktree)</div>
      <textarea value={setupScript} onChange={e => setSetupScript(e.target.value)} rows={2}
        placeholder="bun install" style={{ ...field, resize: "vertical", fontFamily: "var(--font-mono)" }} />
      <div style={label}>Copy into worktrees (comma-separated globs)</div>
      <input value={copyGlobs} onChange={e => setCopyGlobs(e.target.value)} placeholder=".env, .env.local" style={{ ...field, fontFamily: "var(--font-mono)" }} />

      {err && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, color: "var(--red)", fontSize: 11 }}>
          {err}
          {canInit && (
            <button type="button" onClick={() => void submit(true)}
              style={{ padding: "3px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--green)", font: "inherit", fontSize: 10, cursor: "pointer" }}>
              git init
            </button>
          )}
        </div>
      )}
      <button type="button" disabled={busy || !path.trim() || (tab === "clone" && !cloneUrl.trim())} onClick={() => void submit()}
        style={{ marginTop: 12, padding: "7px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--violet)", color: "var(--text-on-accent)", font: "inherit", fontSize: 11, fontWeight: 500, cursor: busy ? "default" : "pointer" }}>
        {busy ? "Adding…" : tab === "clone" ? "Clone + add" : "Add project"}
      </button>
    </div>
  );
}
