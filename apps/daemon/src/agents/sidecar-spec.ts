import { existsSync } from "node:fs";
import { join } from "node:path";

/** Spawn spec for the MCP sidecar (mcp-entry). The predicate is "can an
 * EXTERNAL process read the sidecar source?": in dev it exists on disk and
 * execPath is bun, so `bun <entry>` works. In the compiled binary the source
 * lives only inside the executable's virtual bundle, so the installed `rvmp`
 * re-invokes ITSELF with the hidden `mcp-sidecar` subcommand — end users have
 * no bun and no repo (the launch-day install bug: agents spawned an MCP server
 * that could never start, so task_complete never arrived and cards hung). */
export function sidecarSpec(
  execPath = process.execPath,
  entryDir = import.meta.dir,
): { command: string; args: string[] } {
  const entry = join(entryDir, "mcp-entry.ts");
  if (existsSync(entry)) return { command: execPath, args: [entry] };
  return { command: execPath, args: ["mcp-sidecar"] };
}
