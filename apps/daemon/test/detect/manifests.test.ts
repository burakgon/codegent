import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../../src/detect/manifest";
import type { Manifest } from "../../src/detect/manifest";
import {
  BUNDLED_MANIFEST_NAMES,
  manifestFor,
} from "../../src/detect/manifests";
import type { ScreenGrid } from "../../src/detect/types";

const grid = (overrides: Partial<ScreenGrid> = {}): ScreenGrid => ({
  rows: [],
  oscTitle: null,
  oscProgress: null,
  ...overrides,
});

function withOverrideDir(run: (overrideDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "codegent-manifests-"));
  const overrideDir = join(root, "agent-detection");
  mkdirSync(overrideDir);
  try {
    run(overrideDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function bundled(agent: string): Manifest {
  const root = mkdtempSync(join(tmpdir(), "codegent-manifests-bundled-"));
  const overrideDir = join(root, "agent-detection");
  mkdirSync(overrideDir);
  try {
    const manifest = manifestFor(agent, { overrideDir });
    if (manifest === null) throw new Error(`missing bundled manifest for ${agent}`);
    return manifest;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("bundled agent detection manifests", () => {
  test.each([...BUNDLED_MANIFEST_NAMES])("%s.toml is bundled and schema-valid", (agent) => {
    const manifest = bundled(agent);
    expect(manifest.rules.length).toBeGreaterThan(0);
  });

  const fixtures: {
    agent: string;
    name: string;
    provenance: "doc-grounded" | "DERIVED-per-doc";
    fixture: ScreenGrid;
    expected: "idle" | "working" | "blocked" | "unknown";
  }[] = [
    // docs/research/herdr-agent-state.md §6 and cc-codex-hook-contract.md §6-7.
    {
      agent: "claude",
      name: "bordered prompt at rest",
      provenance: "doc-grounded",
      fixture: grid({ rows: ["conversation", "────────", "  ❯ ", "────────"] }),
      expected: "idle",
    },
    {
      agent: "claude",
      name: "braille OSC title",
      provenance: "doc-grounded",
      fixture: grid({ oscTitle: "⠐ Writing manifest tests" }),
      expected: "working",
    },
    {
      agent: "claude",
      name: "numbered proceed confirmation",
      provenance: "doc-grounded",
      fixture: grid({
        rows: ["tool call", "────────", "Do you want to proceed?", "❯ 1. Yes", "  2. No"],
      }),
      expected: "blocked",
    },
    {
      agent: "claude",
      name: "transcript viewer",
      provenance: "doc-grounded",
      fixture: grid({ rows: ["Showing detailed transcript", "ctrl+o to toggle"] }),
      expected: "unknown",
    },
    {
      agent: "claude",
      name: "unknown screen",
      provenance: "doc-grounded",
      fixture: grid({ rows: ["unrecognized Claude screen"] }),
      expected: "idle",
    },

    // docs/research/herdr-agent-state.md §6 and cc-codex-hook-contract.md §7c.
    {
      agent: "codex",
      name: "plain non-spinner title",
      provenance: "doc-grounded",
      fixture: grid({ oscTitle: "proj-codex" }),
      expected: "idle",
    },
    {
      agent: "codex",
      name: "braille OSC title",
      provenance: "doc-grounded",
      fixture: grid({ oscTitle: "⠹ proj-codex" }),
      expected: "working",
    },
    {
      agent: "codex",
      name: "Action Required OSC title",
      provenance: "doc-grounded",
      fixture: grid({ oscTitle: "[ ! ] Action Required | proj-codex" }),
      expected: "blocked",
    },
    {
      agent: "codex",
      name: "screen working fallback",
      provenance: "doc-grounded",
      fixture: grid({ rows: ["answer", "", "• Working (12s • esc to interrupt)"] }),
      expected: "working",
    },
    {
      agent: "codex",
      name: "unknown screen",
      provenance: "doc-grounded",
      fixture: grid({ rows: ["unrecognized Codex screen"] }),
      expected: "idle",
    },

    // Gemini title glyphs are recorded in docs/research/orca-agent-state.md §2.2.
    {
      agent: "gemini",
      name: "diamond OSC title",
      provenance: "doc-grounded",
      fixture: grid({ oscTitle: "◇ Gemini" }),
      expected: "idle",
    },
    {
      agent: "gemini",
      name: "working OSC title",
      provenance: "doc-grounded",
      fixture: grid({ oscTitle: "✦ Gemini" }),
      expected: "working",
    },
    {
      agent: "gemini",
      name: "permission OSC title",
      provenance: "doc-grounded",
      fixture: grid({ oscTitle: "✋ Gemini" }),
      expected: "blocked",
    },
    {
      agent: "gemini",
      name: "bordered prompt at rest",
      provenance: "DERIVED-per-doc",
      fixture: grid({ rows: ["response", "────────", "> ", "────────"] }),
      expected: "idle",
    },
    {
      agent: "gemini",
      name: "spinner interrupt hint",
      provenance: "DERIVED-per-doc",
      fixture: grid({ rows: ["✦ Thinking (esc to interrupt)"] }),
      expected: "working",
    },
    {
      agent: "gemini",
      name: "explicit yes/no confirmation",
      provenance: "DERIVED-per-doc",
      fixture: grid({ rows: ["Allow this tool?", "> Yes", "  No"] }),
      expected: "blocked",
    },
    {
      agent: "gemini",
      name: "unknown screen",
      provenance: "doc-grounded",
      fixture: grid({ rows: ["unrecognized Gemini screen"] }),
      expected: "idle",
    },

    // OpenCode and Aider screen fixtures are conservative DERIVED-per-doc starters.
    {
      agent: "opencode",
      name: "bordered prompt at rest",
      provenance: "DERIVED-per-doc",
      fixture: grid({ rows: ["response", "────────", "❯ ", "────────"] }),
      expected: "idle",
    },
    {
      agent: "opencode",
      name: "spinner interrupt hint",
      provenance: "DERIVED-per-doc",
      fixture: grid({ rows: ["⠋ Working (esc to interrupt)"] }),
      expected: "working",
    },
    {
      agent: "opencode",
      name: "explicit yes/no confirmation",
      provenance: "DERIVED-per-doc",
      fixture: grid({ rows: ["Approve this action?", "❯ Yes", "  No"] }),
      expected: "blocked",
    },
    {
      agent: "opencode",
      name: "unknown screen",
      provenance: "doc-grounded",
      fixture: grid({ rows: ["unrecognized OpenCode screen"] }),
      expected: "idle",
    },
    {
      agent: "aider",
      name: "bordered prompt at rest",
      provenance: "DERIVED-per-doc",
      fixture: grid({ rows: ["response", "────────", "aider> ", "────────"] }),
      expected: "idle",
    },
    {
      agent: "aider",
      name: "spinner interrupt hint",
      provenance: "DERIVED-per-doc",
      fixture: grid({ rows: ["⠋ Editing app.ts (esc to interrupt)"] }),
      expected: "working",
    },
    {
      agent: "aider",
      name: "explicit yes/no confirmation",
      provenance: "DERIVED-per-doc",
      fixture: grid({ rows: ["Create this file?", "> Yes", "  No"] }),
      expected: "blocked",
    },
    {
      agent: "aider",
      name: "unknown screen",
      provenance: "doc-grounded",
      fixture: grid({ rows: ["unrecognized Aider screen"] }),
      expected: "idle",
    },

    // The generic manifest deliberately has working evidence only.
    {
      agent: "generic",
      name: "braille OSC title",
      provenance: "doc-grounded",
      fixture: grid({ oscTitle: "⠋ Running" }),
      expected: "working",
    },
    {
      agent: "generic",
      name: "spinner interrupt hint",
      provenance: "DERIVED-per-doc",
      fixture: grid({ rows: ["◦ Working (esc to interrupt)"] }),
      expected: "working",
    },
    {
      agent: "generic",
      name: "unknown screen",
      provenance: "doc-grounded",
      fixture: grid({ rows: ["unrecognized agent screen"] }),
      expected: "idle",
    },
  ];

  test.each(fixtures)("$agent: $name [$provenance] -> $expected", ({ agent, fixture, expected }) => {
    expect(evaluate(bundled(agent), fixture).state).toBe(expected);
  });

  test("Claude idle title containing permission text never becomes blocked", () => {
    const result = evaluate(
      bundled("claude"),
      grid({ oscTitle: "✳ Waiting for permission", rows: ["Permission required"] }),
    );

    expect(result).toMatchObject({ state: "idle", ruleId: "osc_title_idle" });
  });

  test("Codex Action Required title is blocked and braille title is working", () => {
    const manifest = bundled("codex");
    expect(evaluate(manifest, grid({ oscTitle: "[ . ] Action Required | repo" })).state).toBe(
      "blocked",
    );
    expect(evaluate(manifest, grid({ oscTitle: "⠹ repo" })).state).toBe("working");
  });
});

describe("manifestFor", () => {
  test("a local per-agent override wins over the bundled manifest", () => {
    withOverrideDir((overrideDir) => {
      writeFileSync(
        join(overrideDir, "claude.toml"),
        `
[[rules]]
id = "fixture_override"
state = "blocked"
priority = 1
region = "whole_recent"
contains = ["local override evidence"]
`,
      );

      const manifest = manifestFor("claude", { overrideDir });
      expect(manifest).not.toBeNull();
      expect(
        evaluate(
          manifest!,
          grid({ rows: ["local override evidence"], oscTitle: "⠐ bundled would be working" }),
        ),
      ).toEqual({ state: "blocked", ruleId: "fixture_override", fallback: false });
    });
  });

  test("a broken local override is logged and ignored in favor of the bundled manifest", () => {
    withOverrideDir((overrideDir) => {
      writeFileSync(join(overrideDir, "codex.toml"), "[[rules]\nid =");
      const warning = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const manifest = manifestFor("codex", { overrideDir });
        expect(manifest).not.toBeNull();
        expect(evaluate(manifest!, grid({ oscTitle: "[ ! ] Action Required | repo" })).state).toBe(
          "blocked",
        );
        expect(warning).toHaveBeenCalledTimes(1);
        expect(String(warning.mock.calls[0]?.[0])).toMatch(/override.*ignored/i);
      } finally {
        warning.mockRestore();
      }
    });
  });

  test("an unknown recognized agent receives the generic bundled manifest", () => {
    withOverrideDir((overrideDir) => {
      expect(manifestFor("future-agent", { overrideDir })).toBe(
        manifestFor("generic", { overrideDir }),
      );
      expect(manifestFor("constructor", { overrideDir })).toBe(
        manifestFor("generic", { overrideDir }),
      );
    });
  });
});
