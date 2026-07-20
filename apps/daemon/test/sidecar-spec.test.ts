import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sidecarSpec } from "../src/agents/sidecar-spec";

// The launch-day install bug: generated agent configs said `bun <bundled .ts>`,
// which no installed machine can spawn (no bun, and the source only exists
// inside the compiled binary). The spec must self-exec in that world.
describe("sidecarSpec", () => {
  test("dev: entry source on disk → run it with the current runtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-dev-"));
    const entry = join(dir, "mcp-entry.ts");
    writeFileSync(entry, "// stub");
    expect(sidecarSpec("/opt/homebrew/bin/bun", dir)).toEqual({
      command: "/opt/homebrew/bin/bun",
      args: [entry],
    });
  });

  test("compiled: no on-disk source → the binary re-invokes itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-pkg-")); // no mcp-entry.ts inside
    expect(sidecarSpec("/Users/u/.rvmp/bin/rvmp", dir)).toEqual({
      command: "/Users/u/.rvmp/bin/rvmp",
      args: ["mcp-sidecar"],
    });
  });

  test("default call resolves the real dev entry under bun test", () => {
    const spec = sidecarSpec();
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]!.endsWith("mcp-entry.ts")).toBe(true);
  });
});
