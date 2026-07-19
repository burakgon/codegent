import { test, expect } from "bun:test";
import { PtySession, scrubAgentEnv } from "../src/pty/session";

/** Poll until `read()` contains `marker`, bounded by a deadline (Task-2 spike style). */
async function waitFor(
  read: () => string,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  const start = performance.now();
  while (!read().includes(marker)) {
    if (performance.now() - start > timeoutMs) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${JSON.stringify(marker)}; ` +
          `last output: ${JSON.stringify(read().slice(-500))}`,
      );
    }
    await Bun.sleep(20);
  }
}

test("pty session: data flows, ring accumulates, write works", async () => {
  const ringPath = `/tmp/codegent-s-${crypto.randomUUID()}.bin`;
  const s = new PtySession({ id: "s1", cwd: "/tmp", ringPath });
  const got: Uint8Array[] = [];
  const off = s.onData((b) => got.push(b));
  // Marker split in the input ("SESSION_%s" + "OK"): PTY input echo alone can
  // never contain the contiguous "SESSION_OK" — only real execution produces it.
  s.write("printf 'SESSION_%s\\n' OK\r");
  await waitFor(() => new TextDecoder().decode(s.snapshot()), "SESSION_OK", 10_000);
  s.write("exit\r");
  await s.exited;
  off();
  const all = new TextDecoder().decode(s.snapshot());
  expect(all).toContain("SESSION_OK");
  expect(got.length).toBeGreaterThan(0);
  // `exited` resolves only after the final ring flush — scrollback persisted.
  const persisted = new Uint8Array(await Bun.file(ringPath).arrayBuffer());
  expect(new TextDecoder().decode(persisted)).toContain("SESSION_OK");
}, 15000);

test("pty session: kill() terminates the shell and resolves exited", async () => {
  const ringPath = `/tmp/codegent-k-${crypto.randomUUID()}.bin`;
  const s = new PtySession({ id: "k1", cwd: "/tmp", ringPath });
  // Wait for first output (prompt) so we kill a fully started interactive shell —
  // interactive shells ignore SIGTERM, which is exactly what this test pins down.
  await waitFor(() => (s.snapshot().length > 0 ? "up" : ""), "up", 10_000);
  s.kill();
  const code = await s.exited;
  expect(typeof code).toBe("number");
}, 15000);

test("scrubAgentEnv drops CLAUDE* keys and pins TERM", () => {
  const env = scrubAgentEnv({
    PATH: "/usr/bin",
    CLAUDE_CODE_CHILD_SESSION: "x", // the leak that breaks --resume (contract doc)
    CLAUDE_TEST: "1",
    CLAUDECODE: "1",
    TERM: "dumb",
    EMPTY_OK: "",
    GONE: undefined,
  });
  expect(env.PATH).toBe("/usr/bin");
  expect(env.EMPTY_OK).toBe("");
  expect(env.TERM).toBe("xterm-256color");
  expect(Object.keys(env).some(k => /^CLAUDE/.test(k))).toBe(false);
  expect("GONE" in env).toBe(false); // undefined values don't materialize
});

test("pty session: cmd spawns a non-shell binary (cat) and terminate() after exit is a no-op", async () => {
  const ringPath = `/tmp/codegent-cmd-${crypto.randomUUID()}.bin`;
  const s = new PtySession({ id: "cmd1", cwd: "/tmp", cmd: ["cat"], ringPath });
  s.write("CMD_ROUNDTRIP\r");
  await waitFor(() => new TextDecoder().decode(s.snapshot()), "CMD_ROUNDTRIP", 10_000);
  // Two copies prove cat executed: tty input echo produces one, cat's own
  // output the other. Echo alone (cat broken) would leave exactly one.
  await waitFor(
    () => {
      const n = new TextDecoder().decode(s.snapshot()).split("CMD_ROUNDTRIP").length - 1;
      return n >= 2 ? "twice" : "";
    },
    "twice",
    10_000,
  );
  s.write("\x04"); // ^D at line start = EOF in canonical mode → cat exits cleanly
  const code = await s.exited;
  expect(code).toBe(0);
  // ladder on an already-dead child resolves immediately with the same code
  expect(await s.terminate()).toBe(0);
}, 15000);

test("pty session: base env is scrubbed — CLAUDE* never reaches the child", async () => {
  const ringPath = `/tmp/codegent-env-${crypto.randomUUID()}.bin`;
  process.env.CLAUDE_TEST = "1"; // must be dropped
  process.env.CODEGENT_ENV_PROBE = "kept"; // positive control: proves capture worked
  try {
    const s = new PtySession({ id: "env1", cwd: "/tmp", cmd: ["/usr/bin/env"], ringPath });
    // Wait on the ring, not exited: the positive control doubles as the
    // "output actually captured" gate (an empty snapshot could never pass).
    await waitFor(() => new TextDecoder().decode(s.snapshot()), "CODEGENT_ENV_PROBE=kept", 10_000);
    await s.exited;
    const out = new TextDecoder().decode(s.snapshot());
    expect(out).toContain("CODEGENT_ENV_PROBE=kept");
    expect(out).toContain("TERM=xterm-256color");
    expect(out).not.toContain("CLAUDE_TEST");
  } finally {
    delete process.env.CLAUDE_TEST;
    delete process.env.CODEGENT_ENV_PROBE;
  }
}, 15000);

test("pty session: opts.env merges over the scrubbed base", async () => {
  const ringPath = `/tmp/codegent-envm-${crypto.randomUUID()}.bin`;
  const s = new PtySession({
    id: "envm1", cwd: "/tmp", cmd: ["/usr/bin/env"], ringPath,
    env: { CODEGENT_DISPATCH_ID: "d-42" }, // what adapters will inject
  });
  await waitFor(() => new TextDecoder().decode(s.snapshot()), "CODEGENT_DISPATCH_ID=d-42", 10_000);
  await s.exited;
}, 15000);

test("pty session: terminate() escalates past an ignored SIGHUP within budget", async () => {
  const ringPath = `/tmp/codegent-term-${crypto.randomUUID()}.bin`;
  // SIGHUP-immune child: the ladder's first rung must fail, SIGTERM must land.
  const s = new PtySession({ id: "term1", cwd: "/tmp", cmd: ["sh", "-c", "trap '' HUP; sleep 30"], ringPath });
  await Bun.sleep(250); // let sh install the trap, else SIGHUP wins the race and rung 1 kills it
  const t0 = performance.now();
  const code = await s.terminate();
  const dt = performance.now() - t0;
  expect(typeof code).toBe("number");
  // ≥ ladder step: SIGHUP was ignored (rung 1 did not kill it).
  expect(dt).toBeGreaterThanOrEqual(1900);
  // < 2·step budget (brief: ≤5s) and well under the SIGKILL rung at 4s:
  // SIGTERM is what ended it.
  expect(dt).toBeLessThan(3800);
}, 10000);
