import React from "react";
import type { Project } from "@codegent/protocol";

export function Sidebar({ projects, activeId, onSelect, onAdd }: {
  projects: Project[]; activeId: string | null; onSelect: (id: string) => void; onAdd?: () => void;
}) {
  return (
    <div style={{ width: 228, background: "var(--bg-deep)", borderRight: "1px solid var(--surface-2)", padding: "14px 10px", display: "flex", flexDirection: "column" }}>
      <div style={{ fontSize: 13, fontWeight: 500, padding: "0 8px 16px" }}>
        code<span style={{ background: "linear-gradient(90deg,var(--violet-2),var(--cyan))", WebkitBackgroundClip: "text", color: "transparent" }}>gent</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", fontSize: 10, fontWeight: 650, letterSpacing: ".8px", color: "var(--dim)", padding: "0 8px 8px" }}>
        PROJECTS
        {onAdd && (
          <button type="button" aria-label="Add project" onClick={onAdd}
            style={{ marginLeft: "auto", width: 18, height: 18, padding: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--ctrl)", font: "inherit", fontSize: 11, cursor: "pointer", lineHeight: 1 }}>+</button>
        )}
      </div>
      {projects.map(p => (
        <div key={p.id} onClick={() => onSelect(p.id)}
          style={{ padding: "9px 10px", borderRadius: 8, cursor: "pointer",
            background: p.id === activeId ? "var(--surface)" : "transparent",
            border: `1px solid ${p.id === activeId ? "var(--border)" : "transparent"}` }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: p.id === activeId ? "var(--text)" : "var(--text-2)" }}>{p.name}</div>
          <div className="mono" style={{ fontSize: 10, color: "var(--dim)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.path}</div>
        </div>
      ))}
    </div>
  );
}
