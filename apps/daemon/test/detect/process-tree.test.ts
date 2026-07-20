import { describe, expect, test } from "bun:test";
import { AGENT_REGISTRY } from "../../src/detect/agent-registry";
import {
  AGENT_MISS_LIMIT,
  AGENT_POLL_IDENTIFIED_MS,
  AGENT_POLL_UNIDENTIFIED_MS,
  AgentTracker,
  PS_SNAPSHOT_TTL_MS,
  foregroundAgent,
  parsePsSnapshot,
  type PsSnapshot,
  type PsSnapshotRow,
} from "../../src/detect/process-tree";

const row = (overrides: Partial<PsSnapshotRow> & Pick<PsSnapshotRow, "pid">): PsSnapshotRow => ({
  ppid: 1,
  pgid: overrides.pid,
  stat: "S",
  command: "unknown",
  ...overrides,
});

const shell = (pid = 100): PsSnapshotRow =>
  row({ pid, ppid: 1, pgid: pid, stat: "Ss", command: "/bin/zsh -i" });

describe("agent registry", () => {
  test("starts with the seven universal agents and a generic fallthrough", () => {
    expect(AGENT_REGISTRY.map((entry) => entry.name)).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
      "aider",
      "amp",
      "goose",
      "generic",
    ]);
  });
});

describe("foregroundAgent", () => {
  test.each(["claude", "codex", "gemini", "opencode", "aider", "amp", "goose"])(
    "recognizes the direct %s binary",
    (agent) => {
      const snapshot: PsSnapshot = [
        shell(),
        row({ pid: 101, ppid: 100, pgid: 101, stat: "S+", command: agent }),
      ];

      expect(foregroundAgent(100, snapshot)).toEqual({ agent, pid: 101 });
    },
  );

  test("walks a shell -> node -> claude tree and returns the deepest agent", () => {
    const snapshot: PsSnapshot = [
      shell(),
      row({
        pid: 101,
        ppid: 100,
        pgid: 101,
        stat: "S+",
        command: "node /opt/claude/bin/claude",
      }),
      row({
        pid: 102,
        ppid: 101,
        pgid: 101,
        stat: "S+",
        command: "/Users/test/.local/bin/claude",
      }),
    ];

    expect(foregroundAgent(100, snapshot)).toEqual({ agent: "claude", pid: 102 });
  });

  test.each([
    [
      "node package",
      "node /opt/lib/node_modules/@openai/codex/dist/cli.js --model gpt-5",
      "codex",
    ],
    ["bun script", "bun /Users/test/.local/bin/opencode", "opencode"],
    ["python module", "python3 -m aider.main --model sonnet", "aider"],
    ["shell command", "/bin/sh -c 'goose session'", "goose"],
    ["cmd command", 'cmd.exe /D /S /C "amp.cmd"', "amp"],
    [
      "PowerShell file",
      'powershell.exe -NoProfile -File "C:\\Users\\test\\Scripts\\claude.ps1"',
      "claude",
    ],
    ["nix wrapped argv0", "/nix/store/hash/bin/.codex-wrapped --model gpt-5", "codex"],
    ["packaged binary prefix", "/opt/codex-aarch64-apple-darwin --model gpt-5", "codex"],
  ])("unwraps %s invocations", (_kind, command, agent) => {
    const snapshot: PsSnapshot = [
      shell(),
      row({ pid: 101, ppid: 100, pgid: 101, stat: "S+", command }),
    ];

    expect(foregroundAgent(100, snapshot)).toEqual({ agent, pid: 101 });
  });

  test("foreground-group scoring beats a deeper background sibling", () => {
    const snapshot: PsSnapshot = [
      shell(),
      row({ pid: 110, ppid: 100, pgid: 110, stat: "S+", command: "codex" }),
      row({ pid: 120, ppid: 100, pgid: 120, stat: "S", command: "node claude" }),
      row({ pid: 121, ppid: 120, pgid: 120, stat: "S", command: "claude" }),
    ];

    expect(foregroundAgent(100, snapshot)).toEqual({ agent: "codex", pid: 110 });
  });

  test("uses a CODEGENT_AGENT environment label before command recognition", () => {
    const snapshot: PsSnapshot = [
      shell(),
      row({
        pid: 101,
        ppid: 100,
        pgid: 101,
        stat: "S+",
        command: "claude",
        env: { CODEGENT_AGENT: "sandbox-agent" },
      }),
    ];

    expect(foregroundAgent(100, snapshot)).toEqual({ agent: "sandbox-agent", pid: 101 });
  });

  test("returns generic for an unknown foreground command", () => {
    const snapshot: PsSnapshot = [
      shell(),
      row({ pid: 101, ppid: 100, pgid: 101, stat: "S+", command: "vim README.md" }),
    ];

    expect(foregroundAgent(100, snapshot)).toEqual({ agent: "generic", pid: 101 });
  });

  test("returns null for a bare foreground shell", () => {
    expect(foregroundAgent(100, [shell()])).toEqual({ agent: null, pid: null });
  });

  test("does not mistake a background child for a foreground agent when the shell owns +", () => {
    const snapshot: PsSnapshot = [
      row({ pid: 100, ppid: 1, pgid: 100, stat: "Ss+", command: "/bin/zsh -i" }),
      row({ pid: 101, ppid: 100, pgid: 101, stat: "S", command: "claude" }),
    ];

    expect(foregroundAgent(100, snapshot)).toEqual({ agent: null, pid: null });
  });

  test("filters headless claude -p out of Claude TUI recognition", () => {
    const snapshot: PsSnapshot = [
      shell(),
      row({
        pid: 101,
        ppid: 100,
        pgid: 101,
        stat: "S+",
        command: "claude -p 'summarize this repository' --output-format json",
      }),
    ];

    expect(foregroundAgent(100, snapshot)).toEqual({ agent: "generic", pid: 101 });
  });

  test("handles malformed roots and descendant cycles without hanging", () => {
    const snapshot: PsSnapshot = [
      row({ pid: 100, ppid: 101, pgid: 100, stat: "Ss", command: "zsh" }),
      row({ pid: 101, ppid: 100, pgid: 101, stat: "S+", command: "codex" }),
    ];

    expect(foregroundAgent(100, snapshot)).toEqual({ agent: "codex", pid: 101 });
    expect(foregroundAgent(0, snapshot)).toEqual({ agent: null, pid: null });
  });
});

describe("parsePsSnapshot", () => {
  test("parses pid, ppid, pgid, stat, and the complete command tail", () => {
    const output = [
      "  100     1   100 Ss   /bin/zsh -i",
      "  101   100   101 S+   node /opt/node_modules/@openai/codex/bin/codex.js --model gpt-5",
      "malformed row",
      "  102   100   101 Z+   [defunct]",
      "",
    ].join("\r\n");

    expect(parsePsSnapshot(output)).toEqual([
      { pid: 100, ppid: 1, pgid: 100, stat: "Ss", command: "/bin/zsh -i" },
      {
        pid: 101,
        ppid: 100,
        pgid: 101,
        stat: "S+",
        command: "node /opt/node_modules/@openai/codex/bin/codex.js --model gpt-5",
      },
      { pid: 102, ppid: 100, pgid: 101, stat: "Z+", command: "[defunct]" },
    ]);
  });
});

describe("AgentTracker", () => {
  const miss = { agent: null, pid: null } as const;

  test("holds an identified agent for five misses and declares it gone on the sixth", () => {
    const tracker = new AgentTracker();
    expect(tracker.update({ agent: "claude", pid: 101 })).toEqual({
      agent: "claude",
      pid: 101,
      gone: false,
    });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(tracker.update(miss)).toEqual({ agent: "claude", pid: 101, gone: false });
    }
    expect(tracker.update(miss)).toEqual({ agent: null, pid: null, gone: true });
    expect(tracker.update(miss)).toEqual({ agent: null, pid: null, gone: false });
  });

  test("re-acquisition resets the consecutive-miss counter", () => {
    const tracker = new AgentTracker();
    tracker.update({ agent: "codex", pid: 201 });
    for (let attempt = 1; attempt <= 5; attempt += 1) tracker.update(miss);

    expect(tracker.update({ agent: "codex", pid: 202 })).toEqual({
      agent: "codex",
      pid: 202,
      gone: false,
    });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(tracker.update(miss)).toEqual({ agent: "codex", pid: 202, gone: false });
    }
    expect(tracker.update(miss).gone).toBe(true);
  });
});

test("exports the adopted caller cadence, snapshot TTL, and hysteresis numbers", () => {
  expect(AGENT_POLL_IDENTIFIED_MS).toBe(300);
  expect(AGENT_POLL_UNIDENTIFIED_MS).toBe(500);
  expect(PS_SNAPSHOT_TTL_MS).toBe(500);
  expect(AGENT_MISS_LIMIT).toBe(6);
});
