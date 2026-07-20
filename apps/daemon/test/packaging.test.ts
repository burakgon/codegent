import { test, expect, describe } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWebDist } from "../src/http/server";

// T3 packaging seams. The full compile smoke lives in scripts/package.ts
// (exercised at release time + the project-end live pass) — tests here lock
// the pure resolution logic every packaged binary depends on.

describe("resolveWebDist", () => {
  test("env override wins unconditionally", () => {
    process.env.CODEGENT_WEB_DIST = "/custom/web";
    try {
      expect(resolveWebDist("/whatever/bin/codegent")).toBe("/custom/web");
    } finally {
      delete process.env.CODEGENT_WEB_DIST;
    }
  });
  test("packaged layout: share/web beside the binary wins when it exists", () => {
    const pkg = mkdtempSync(join(tmpdir(), "cg-pkg-"));
    mkdirSync(join(pkg, "share", "web"), { recursive: true });
    mkdirSync(join(pkg, "bin"), { recursive: true });
    expect(resolveWebDist(join(pkg, "bin", "codegent"))).toBe(join(pkg, "share", "web")); // join() normalizes
    rmSync(pkg, { recursive: true, force: true });
  });
  test("dev fallback: monorepo web/dist path derived from the source dir", () => {
    const got = resolveWebDist("/nonexistent/bin/codegent", "/repo/apps/daemon/src/http");
    expect(got).toBe("/repo/apps/web/dist"); // join() normalizes the ../ hops
  });
});

describe("install.sh", () => {
  const sh = (args: string[], env: Record<string, string> = {}) => {
    const p = Bun.spawnSync({
      cmd: ["sh", join(import.meta.dir, "../../../scripts/install.sh"), ...args],
      env: { ...process.env, ...env },
      stdout: "pipe", stderr: "pipe",
    });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
  };
  test("dry-run prints the full plan without touching the system", () => {
    const r = sh(["--dry-run"], { CODEGENT_DOWNLOAD_BASE: "https://example.test/rel" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("https://example.test/rel/codegent-");
    expect(r.out).toContain(".codegent/bin");
    expect(r.out).toContain("codegent service enable");
  });
  test("--no-service is honored; unknown flags reject", () => {
    expect(sh(["--dry-run", "--no-service"]).out).toContain("skipped (--no-service)");
    expect(sh(["--bogus"]).code).toBe(2);
  });
});

describe("Part-4 review-fix regressions", () => {
  test("pathComplete: prefix-collision and symlink escapes are contained", async () => {
    const { pathComplete } = await import("../src/http/server");
    const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = mkdtempSync(join(tmpdir(), "cg-anchor-"));
    const home = join(base, "alice");
    mkdirSync(join(home, "code"), { recursive: true });
    mkdirSync(join(base, "alice-private", "secret"), { recursive: true }); // prefix collision
    mkdirSync(join(base, "outside", "etcish"), { recursive: true });
    symlinkSync(join(base, "outside"), join(home, "link-out")); // symlink escape
    expect(pathComplete(join(home, "co"), home)).toEqual([join(home, "code")]);
    expect(pathComplete(join(base, "alice-private") + "/", home)).toEqual([]); // startsWith(home) but NOT home/
    expect(pathComplete(join(home, "link-out") + "/", home)).toEqual([]); // resolves outside → nothing
    rmSync(base, { recursive: true, force: true });
  });

  test("copyGlobsInto: traversal globs and symlinked files never cross the boundary", async () => {
    const { copyGlobsInto } = await import("../src/git/setup");
    const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = mkdtempSync(join(tmpdir(), "cg-globs-"));
    const repo = join(base, "repo");
    const wt = join(base, "wt");
    mkdirSync(repo, { recursive: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(base, "victim.txt"), "outside");
    writeFileSync(join(repo, ".env"), "IN=1");
    symlinkSync(join(base, "victim.txt"), join(repo, "sneaky-link"));
    const copied = copyGlobsInto({ path: repo, copyGlobs: ["../victim.txt", ".env", "sneaky-link"] }, wt);
    expect(copied).toEqual([".env"]); // traversal + symlink both skipped
    expect(existsSync(join(base, "wt", ".env"))).toBe(true);
    expect(existsSync(join(base, "victim.txt.copy"))).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  test("findDaemon uses the daemon-written port file, never a range scan", async () => {
    const { findDaemon } = await import("../src/cli");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dataDir = mkdtempSync(join(tmpdir(), "cg-pf-"));
    writeFileSync(join(dataDir, "token"), "tkn");
    const hit: number[] = [];
    const fetchFn = (async (url: string) => {
      hit.push(Number(new URL(url).port));
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    // no port file → no probe at all (token never sprayed)
    expect(await findDaemon({ dataDir, fetchFn })).toBeNull();
    expect(hit).toEqual([]);
    writeFileSync(join(dataDir, "port"), "4701");
    const found = await findDaemon({ dataDir, fetchFn });
    expect(found?.base).toBe("http://127.0.0.1:4701");
    expect(hit).toEqual([4701]); // exactly the recorded port
    rmSync(dataDir, { recursive: true, force: true });
  });
});
