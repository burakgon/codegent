/**
 * Content-free process recognition for the universal terminal-state tier.
 *
 * The executable aliases and wrapper strategies come from
 * `docs/research/herdr-agent-state.md` §3a (runtime/shell/Nix unwrapping) and
 * `docs/research/orca-agent-state.md` §2.3 (package paths, Python modules,
 * packaged binary prefixes, and quoted argv scanning).
 */

export type AgentWrapper =
  | "node"
  | "bun"
  | "python"
  | "shell"
  | "cmd"
  | "powershell"
  | "nix";

export interface AgentRegistryEntry {
  /** Stable label emitted by Layer 1. */
  readonly name: string;
  /** Exact executable basenames, matched case-insensitively without platform extensions. */
  readonly binaries: readonly string[];
  /** Package path fragments accepted only when they are an interpreter entrypoint. */
  readonly nodePackagePaths: readonly string[];
  /** Python `-m` module roots. */
  readonly pythonModules: readonly string[];
  /** Python package path fragments accepted only for a script entrypoint. */
  readonly pythonPackagePaths: readonly string[];
  /** Native packaged executable prefixes such as `codex-aarch64-*`. */
  readonly packagedBinaryPrefixes: readonly string[];
  /** Runtime wrappers through which the entry may be recognized. */
  readonly wrappers: readonly AgentWrapper[];
  /** The sole non-recognition entry, used after a foreground process fails every known rule. */
  readonly fallback?: true;
}

const ALL_WRAPPERS = [
  "node",
  "bun",
  "python",
  "shell",
  "cmd",
  "powershell",
  "nix",
] as const satisfies readonly AgentWrapper[];

const noPaths: readonly string[] = [];

export const AGENT_REGISTRY: readonly AgentRegistryEntry[] = [
  {
    name: "claude",
    binaries: ["claude", "claude-code"],
    nodePackagePaths: ["node_modules/@anthropic-ai/claude-code/"],
    pythonModules: noPaths,
    pythonPackagePaths: noPaths,
    packagedBinaryPrefixes: noPaths,
    wrappers: ALL_WRAPPERS,
  },
  {
    name: "codex",
    binaries: ["codex"],
    nodePackagePaths: ["node_modules/@openai/codex/"],
    pythonModules: noPaths,
    pythonPackagePaths: noPaths,
    packagedBinaryPrefixes: ["codex-"],
    wrappers: ALL_WRAPPERS,
  },
  {
    name: "gemini",
    binaries: ["gemini"],
    nodePackagePaths: ["node_modules/@google/gemini-cli/"],
    pythonModules: noPaths,
    pythonPackagePaths: noPaths,
    packagedBinaryPrefixes: noPaths,
    wrappers: ALL_WRAPPERS,
  },
  {
    name: "opencode",
    binaries: ["opencode", "open-code"],
    nodePackagePaths: ["node_modules/opencode-ai/"],
    pythonModules: noPaths,
    pythonPackagePaths: noPaths,
    packagedBinaryPrefixes: ["opencode-"],
    wrappers: ALL_WRAPPERS,
  },
  {
    name: "aider",
    binaries: ["aider"],
    nodePackagePaths: noPaths,
    pythonModules: ["aider", "aider_chat"],
    pythonPackagePaths: ["site-packages/aider/", "site-packages/aider_chat/"],
    packagedBinaryPrefixes: noPaths,
    wrappers: ALL_WRAPPERS,
  },
  {
    name: "amp",
    binaries: ["amp", "amp-local"],
    nodePackagePaths: ["node_modules/@sourcegraph/amp/"],
    pythonModules: noPaths,
    pythonPackagePaths: noPaths,
    packagedBinaryPrefixes: noPaths,
    wrappers: ALL_WRAPPERS,
  },
  {
    name: "goose",
    binaries: ["goose"],
    nodePackagePaths: noPaths,
    pythonModules: noPaths,
    pythonPackagePaths: noPaths,
    packagedBinaryPrefixes: noPaths,
    wrappers: ALL_WRAPPERS,
  },
  {
    name: "generic",
    binaries: noPaths,
    nodePackagePaths: noPaths,
    pythonModules: noPaths,
    pythonPackagePaths: noPaths,
    packagedBinaryPrefixes: noPaths,
    wrappers: [],
    fallback: true,
  },
];

const PROCESS_EXTENSION_RE = /\.(?:exe|cmd|bat|ps1|js|mjs|cjs|py|pyw)$/i;
const PYTHON_RE = /^python(?:\d+(?:\.\d+)*)?$/;
const NODE_RE = /^(?:node|nodejs)$/;
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "fish", "ksh", "mksh"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const NODE_OPTIONS_WITH_VALUE = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
]);
const NODE_INLINE_SOURCE_OPTIONS = new Set(["-e", "--eval", "-p", "--print", "--check"]);
const PYTHON_OPTIONS_WITH_VALUE = new Set(["-W", "-X"]);
const CLAUDE_HEADLESS_FLAGS = new Set(["-p", "--print"]);
const CLAUDE_HEADLESS_FORMATS = new Set(["json", "stream-json"]);
const MAX_UNWRAP_DEPTH = 8;

function comparablePath(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/").toLowerCase();
}

function basename(value: string): string {
  const comparable = comparablePath(value);
  return comparable.split("/").filter(Boolean).pop() ?? comparable;
}

function normalizedExecutable(value: string | undefined): string {
  return value ? basename(value).replace(PROCESS_EXTENSION_RE, "") : "";
}

function matchExecutable(value: string): string | null {
  const normalized = normalizedExecutable(value);
  if (!normalized) return null;

  for (const entry of AGENT_REGISTRY) {
    if (entry.name === "generic") continue;
    if (
      entry.binaries.includes(normalized) ||
      entry.packagedBinaryPrefixes.some((prefix) => normalized.startsWith(prefix))
    ) {
      return entry.name;
    }
  }
  return null;
}

function matchPackagePath(value: string, field: "nodePackagePaths" | "pythonPackagePaths"): string | null {
  const path = comparablePath(value);
  for (const entry of AGENT_REGISTRY) {
    if (entry.name === "generic") continue;
    if (entry[field].some((marker) => path.includes(marker))) return entry.name;
  }
  return null;
}

function matchPythonModule(value: string | undefined): string | null {
  if (!value || value.startsWith("-")) return null;
  const module = value.toLowerCase().replace(/-/g, "_");
  const root = module.split(".", 1)[0] ?? module;
  for (const entry of AGENT_REGISTRY) {
    if (entry.name === "generic") continue;
    if (entry.pythonModules.some((candidate) => candidate === module || candidate === root)) {
      return entry.name;
    }
  }
  return null;
}

/** Small argv scanner: preserves quoted spaces and the Windows path separators that are not escapes. */
function tokenize(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      const next = commandLine[index + 1];
      if (next && (/\s/.test(next) || next === "'" || next === '"' || next === "\\")) {
        escaped = true;
        continue;
      }
    }
    if ((char === "'" || char === '"') && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function optionName(token: string): string {
  return token.split("=", 1)[0]?.toLowerCase() ?? "";
}

function optionValue(tokens: readonly string[], index: number): string | undefined {
  const token = tokens[index] ?? "";
  const equals = token.indexOf("=");
  return equals === -1 ? tokens[index + 1] : token.slice(equals + 1);
}

function isHeadlessClaude(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const name = optionName(tokens[index] ?? "");
    if (CLAUDE_HEADLESS_FLAGS.has(name)) return true;
    if (name === "--output-format") {
      const format = optionValue(tokens, index)?.toLowerCase();
      if (format && CLAUDE_HEADLESS_FORMATS.has(format)) return true;
    }
  }
  return false;
}

function accept(agent: string | null, invocation: readonly string[]): string | null {
  // Orca `agent-process-recognition.ts:288-294`, recorded in
  // `docs/research/orca-agent-state.md` §2.3: one-shot Claude print mode is
  // deliberately excluded from interactive/TUI identity.
  if (agent === "claude" && isHeadlessClaude(invocation)) return null;
  return agent;
}

function stripCommandPrefixes(tokens: readonly string[]): string[] {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]?.toLowerCase() ?? "";
    if (["&", ".", "call", "command", "exec"].includes(token)) {
      index += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) {
      index += 1;
      continue;
    }
    if (token === "env") {
      index += 1;
      while (
        index < tokens.length &&
        ((tokens[index] ?? "").startsWith("-") ||
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? ""))
      ) {
        index += 1;
      }
      continue;
    }
    break;
  }
  return tokens.slice(index);
}

function recognizeNested(payload: string, trailing: readonly string[], depth: number): string | null {
  const pathAgent = matchExecutable(payload);
  if (pathAgent) return accept(pathAgent, [payload, ...trailing]);
  return recognizeTokens([...tokenize(payload), ...trailing], depth + 1);
}

function findNodeEntrypoint(tokens: readonly string[]): number | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") return index + 1 < tokens.length ? index + 1 : null;
    if (token.startsWith("-")) {
      const name = optionName(token);
      if (NODE_INLINE_SOURCE_OPTIONS.has(name)) return null;
      if (NODE_OPTIONS_WITH_VALUE.has(name) && token === name) index += 1;
      continue;
    }
    return index;
  }
  return null;
}

function recognizeNode(tokens: readonly string[], depth: number): string | null {
  const index = findNodeEntrypoint(tokens);
  if (index === null) return null;
  const entrypoint = tokens[index] ?? "";
  const invocation = [entrypoint, ...tokens.slice(index + 1)];
  const agent = matchExecutable(entrypoint) ?? matchPackagePath(entrypoint, "nodePackagePaths");
  if (agent) return accept(agent, invocation);
  return recognizeTokens(invocation, depth + 1);
}

function recognizePython(tokens: readonly string[], depth: number): string | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") {
      const entrypoint = tokens[index + 1];
      return entrypoint
        ? recognizeNested(entrypoint, tokens.slice(index + 2), depth)
        : null;
    }
    if (token === "-m") {
      const module = tokens[index + 1];
      return accept(matchPythonModule(module), [module ?? "", ...tokens.slice(index + 2)]);
    }
    if (token === "-c") return null;
    if (token.startsWith("-")) {
      const name = optionName(token);
      if (PYTHON_OPTIONS_WITH_VALUE.has(name) && token === name) index += 1;
      continue;
    }
    const invocation = [token, ...tokens.slice(index + 1)];
    const agent = matchExecutable(token) ?? matchPackagePath(token, "pythonPackagePaths");
    return agent ? accept(agent, invocation) : recognizeTokens(invocation, depth + 1);
  }
  return null;
}

function recognizeShell(tokens: readonly string[], depth: number): string | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const lower = token.toLowerCase();
    if (lower === "--command" || /^-[^-]*c[^-]*$/.test(lower)) {
      const payload = tokens[index + 1];
      return payload ? recognizeNested(payload, tokens.slice(index + 2), depth) : null;
    }
    if (token === "--") {
      const entrypoint = tokens[index + 1];
      return entrypoint
        ? recognizeNested(entrypoint, tokens.slice(index + 2), depth)
        : null;
    }
    if (token.startsWith("-")) continue;
    return recognizeNested(token, tokens.slice(index + 1), depth);
  }
  return null;
}

function recognizeCmd(tokens: readonly string[], depth: number): string | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const flag = (tokens[index] ?? "").toLowerCase();
    if (flag === "/c" || flag === "/k") {
      const payload = tokens[index + 1];
      return payload ? recognizeNested(payload, tokens.slice(index + 2), depth) : null;
    }
  }
  return null;
}

function recognizePowerShell(tokens: readonly string[], depth: number): string | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const flag = (tokens[index] ?? "").toLowerCase();
    if (["-file", "-f", "/file"].includes(flag)) {
      const path = tokens[index + 1];
      return path ? recognizeNested(path, tokens.slice(index + 2), depth) : null;
    }
    if (["-command", "-c", "/command", "/c"].includes(flag)) {
      const payload = tokens[index + 1];
      return payload ? recognizeNested(payload, tokens.slice(index + 2), depth) : null;
    }
    if (["-encodedcommand", "-enc", "/encodedcommand", "/enc"].includes(flag)) return null;
  }
  return null;
}

function recognizeNix(tokens: readonly string[], depth: number): string | null {
  const wrapped = normalizedExecutable(tokens[0]).match(/^\.?(.+)-wrapped$/)?.[1];
  if (wrapped) {
    const agent = matchExecutable(wrapped);
    if (agent) return accept(agent, tokens);
  }

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (["--", "--command", "--run", "-c"].includes(token.toLowerCase())) {
      const payload = tokens[index + 1];
      return payload ? recognizeNested(payload, tokens.slice(index + 2), depth) : null;
    }
    const packageName = token.includes("#") ? token.slice(token.lastIndexOf("#") + 1) : "";
    const packageAgent = packageName ? matchExecutable(packageName) : null;
    if (packageAgent) return accept(packageAgent, [packageName, ...tokens.slice(index + 1)]);
  }
  return null;
}

function recognizeTokens(rawTokens: readonly string[], depth: number): string | null {
  if (depth > MAX_UNWRAP_DEPTH) return null;
  const tokens = stripCommandPrefixes(rawTokens);
  if (tokens.length === 0) return null;

  const direct = matchExecutable(tokens[0] ?? "");
  if (direct) return accept(direct, tokens);

  const runtime = normalizedExecutable(tokens[0]);
  if (NODE_RE.test(runtime)) return recognizeNode(tokens, depth);
  if (runtime === "bun") return recognizeNode(tokens, depth);
  if (PYTHON_RE.test(runtime)) return recognizePython(tokens, depth);
  if (SHELLS.has(runtime)) return recognizeShell(tokens, depth);
  if (runtime === "cmd") return recognizeCmd(tokens, depth);
  if (POWERSHELLS.has(runtime)) return recognizePowerShell(tokens, depth);
  if (runtime === "nix" || runtime === "nix-shell" || /\.?[^/]+-wrapped$/.test(runtime)) {
    return recognizeNix(tokens, depth);
  }
  return null;
}

/** Recognize one interactive agent command line, or `null` when no TUI rule matches. */
export function recognizeAgentCommand(commandLine: string): string | null {
  return recognizeTokens(tokenize(commandLine), 0);
}
