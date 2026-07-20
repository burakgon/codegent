import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db";
import {
  startHookReceiver, writeEndpointFile, writeHookScript, HOOK_BODY_CAP,
  type HookDelivery,
} from "../src/agents/receiver";

const dataDir = mkdtempSync(join(tmpdir(), "cg-recv-"));
const db = openDb(":memory:");
const rx = startHookReceiver({ dataDir, db });
const url = (p: string) => `http://127.0.0.1:${rx.port}${p}`;
const auth = { "x-rvmp-hook-token": rx.token };

afterAll(() => {
  rx.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Deadline-bounded poll (pty-session test style). */
async function waitFor(read: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = performance.now();
  while (!read()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

test("binds 127.0.0.1 on a random port with a minted token", () => {
  expect(rx.port).toBeGreaterThan(0);
  expect(rx.token).toMatch(/^[0-9a-f]{32}$/);
});

test("rejects missing and bad tokens with 401", async () => {
  const missing = await fetch(url("/hook/claude"), { method: "POST", body: "{}" });
  expect(missing.status).toBe(401);
  const bad = await fetch(url("/hook/claude"), {
    method: "POST", headers: { "x-rvmp-hook-token": "wrong" }, body: "{}",
  });
  expect(bad.status).toBe(401);
});

test("caps the body at 1MB with 413", async () => {
  const body = `{"pad":"${"x".repeat(HOOK_BODY_CAP)}"}`; // JSON-valid but over the cap
  const r = await fetch(url("/hook/claude"), { method: "POST", headers: auth, body });
  expect(r.status).toBe(413);
});

test("accepts and forwards a valid hook; pane identity from the session header", async () => {
  const got: HookDelivery[] = [];
  const off = rx.onHook(h => got.push(h));
  const r = await fetch(url("/hook/claude"), {
    method: "POST",
    headers: { ...auth, "x-rvmp-session-id": "sess-77" },
    body: JSON.stringify({ hook_event_name: "Stop", session_id: "native" }),
  });
  expect(r.status).toBe(200);
  off();
  expect(got).toEqual([
    { agent: "claude", sessionId: "sess-77", event: { hook_event_name: "Stop", session_id: "native" } },
  ]);
});

test("falls back to a RVMP_SESSION_ID body field when the header is absent", async () => {
  const got: HookDelivery[] = [];
  const off = rx.onHook(h => got.push(h));
  await fetch(url("/hook/codex"), {
    method: "POST", headers: auth,
    body: JSON.stringify({ RVMP_SESSION_ID: "sess-body", hook_event_name: "Stop" }),
  });
  off();
  expect(got.length).toBe(1);
  expect(got[0]!.agent).toBe("codex");
  expect(got[0]!.sessionId).toBe("sess-body");
});

test("always 200 after auth: throwing subscriber never leaks, later subscribers still fire", async () => {
  const off1 = rx.onHook(() => { throw new Error("subscriber boom"); });
  const got: HookDelivery[] = [];
  const off2 = rx.onHook(h => got.push(h));
  const r = await fetch(url("/hook/claude"), { method: "POST", headers: auth, body: '{"e":1}' });
  expect(r.status).toBe(200);
  expect(got.length).toBe(1); // the throw was contained per-subscriber
  off1(); off2();
});

test("always 200 after auth: malformed JSON is dropped, not an error", async () => {
  const got: HookDelivery[] = [];
  const off = rx.onHook(h => got.push(h));
  const r = await fetch(url("/hook/claude"), { method: "POST", headers: auth, body: "not json {" });
  expect(r.status).toBe(200);
  off();
  expect(got.length).toBe(0);
});

test("non-hook paths and non-POST hooks are 404 (still authed)", async () => {
  expect((await fetch(url("/hook/claude"), { headers: auth })).status).toBe(404); // GET
  expect((await fetch(url("/nope"), { method: "POST", headers: auth, body: "{}" })).status).toBe(404);
});

test("handle() serves the same contract when invoked directly (no HTTP)", async () => {
  const got: HookDelivery[] = [];
  const off = rx.onHook(h => got.push(h));
  const r = await rx.handle(new Request(url("/hook/claude"), {
    method: "POST", headers: { ...auth, "x-rvmp-session-id": "direct" }, body: '{"k":1}',
  }));
  expect(r.status).toBe(200);
  off();
  expect(got[0]!.sessionId).toBe("direct");
});

test("endpoint file: 0600 mode, sourceable values, atomic rewrite leaves no tmp litter", () => {
  expect(rx.endpointFile).toBe(join(dataDir, "agents", "endpoint.env"));
  expect(statSync(rx.endpointFile).mode & 0o777).toBe(0o600);
  const text = readFileSync(rx.endpointFile, "utf8");
  expect(text).toContain(`RVMP_HOOK_PORT=${rx.port}\n`);
  expect(text).toContain(`RVMP_HOOK_TOKEN=${rx.token}\n`);
  // Rewrite as a restarted daemon would: fresh values, same mode, no *.tmp left.
  writeEndpointFile(dataDir, 65001, "tok-after-restart");
  expect(readFileSync(rx.endpointFile, "utf8")).toContain("RVMP_HOOK_PORT=65001\n");
  expect(statSync(rx.endpointFile).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(dataDir, "agents")).filter(f => f.endsWith(".tmp"))).toEqual([]);
  writeEndpointFile(dataDir, rx.port, rx.token); // restore for the script tests below
});

test("hook script: 0755, Orca curl budgets, posts stdin JSON against the live receiver, exit 0", async () => {
  const script = writeHookScript(dataDir);
  expect(statSync(script).mode & 0o777).toBe(0o755);
  const src = readFileSync(script, "utf8");
  expect(src).toContain("--connect-timeout 0.5");
  expect(src).toContain("--max-time 1.5");
  expect(src.trim().endsWith("exit 0")).toBe(true);

  const got: HookDelivery[] = [];
  const off = rx.onHook(h => got.push(h));
  const p = Bun.spawn({
    cmd: [script, "claude"],
    env: { PATH: process.env.PATH!, RVMP_SESSION_ID: "sess-script" },
    stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "PermissionRequest" })),
    stdout: "ignore", stderr: "ignore",
  });
  expect(await p.exited).toBe(0);
  await waitFor(() => got.length === 1, "hook delivery from script");
  off();
  expect(got[0]).toEqual({
    agent: "claude", sessionId: "sess-script",
    event: { hook_event_name: "PermissionRequest" },
  });
}, 15000);

test("hook script: endpoint file beats stale spawn env (restart survival)", async () => {
  const script = writeHookScript(dataDir);
  const got: HookDelivery[] = [];
  const off = rx.onHook(h => got.push(h));
  const p = Bun.spawn({
    cmd: [script, "codex"],
    env: {
      PATH: process.env.PATH!, RVMP_SESSION_ID: "sess-stale-env",
      // Stale env baked into a PTY that outlived a daemon restart:
      RVMP_HOOK_PORT: "1", RVMP_HOOK_TOKEN: "dead-token",
    },
    stdin: new TextEncoder().encode('{"hook_event_name":"Stop"}'),
    stdout: "ignore", stderr: "ignore",
  });
  expect(await p.exited).toBe(0);
  await waitFor(() => got.length === 1, "delivery via endpoint file");
  off();
  expect(got[0]!.sessionId).toBe("sess-stale-env");
}, 15000);

test("hook script: env fallback when the endpoint file is missing", async () => {
  const script = writeHookScript(dataDir);
  const parked = rx.endpointFile + ".parked";
  renameSync(rx.endpointFile, parked);
  try {
    const got: HookDelivery[] = [];
    const off = rx.onHook(h => got.push(h));
    const p = Bun.spawn({
      cmd: [script, "claude"],
      env: {
        PATH: process.env.PATH!, RVMP_SESSION_ID: "sess-env-fallback",
        RVMP_HOOK_PORT: String(rx.port), RVMP_HOOK_TOKEN: rx.token,
      },
      stdin: new TextEncoder().encode('{"hook_event_name":"Stop"}'),
      stdout: "ignore", stderr: "ignore",
    });
    expect(await p.exited).toBe(0);
    await waitFor(() => got.length === 1, "delivery via env fallback");
    off();
    expect(got[0]!.sessionId).toBe("sess-env-fallback");
  } finally {
    renameSync(parked, rx.endpointFile);
  }
}, 15000);

test("hook script: fail-open — dead daemon still exits 0, within the curl budget", async () => {
  const deadDir = mkdtempSync(join(tmpdir(), "cg-dead-"));
  try {
    writeEndpointFile(deadDir, 1, "dead"); // port 1: connection refused instantly
    const script = writeHookScript(deadDir);
    const t0 = performance.now();
    const p = Bun.spawn({
      cmd: [script, "claude"],
      env: { PATH: process.env.PATH!, RVMP_SESSION_ID: "s" },
      stdin: new TextEncoder().encode("{}"),
      stdout: "ignore", stderr: "ignore",
    });
    expect(await p.exited).toBe(0); // ALWAYS exit 0 — the agent must never see a hook failure
    expect(performance.now() - t0).toBeLessThan(4000); // 0.5s connect + 1.5s total budgets, generous margin
  } finally {
    rmSync(deadDir, { recursive: true, force: true });
  }
}, 15000);

test("hook script: missing endpoint config (no file, no env) still exits 0", async () => {
  const bareDir = mkdtempSync(join(tmpdir(), "cg-bare-"));
  try {
    const script = writeHookScript(bareDir); // no endpoint file was ever written here
    const p = Bun.spawn({
      cmd: [script, "claude"],
      env: { PATH: process.env.PATH! }, // no RVMP_* at all
      stdin: new TextEncoder().encode("{}"),
      stdout: "ignore", stderr: "ignore",
    });
    expect(await p.exited).toBe(0);
  } finally {
    rmSync(bareDir, { recursive: true, force: true });
  }
}, 15000);
