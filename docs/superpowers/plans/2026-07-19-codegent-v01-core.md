# codegent v0.1 Core Implementation Plan (Plan 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working localhost codegent: daemon (SQLite, PTY sessions with persistent scrollback, git worktree manager, HTTP+WS API) + web UI (project sidebar, manual-mode kanban board, real ghostty-web terminal view) — the spec's v0.1 milestone.

**Architecture:** Bun monorepo. `packages/protocol` holds shared zod schemas + the WS envelope; `apps/daemon` is a single Bun process (Bun-native PTYs, bun:sqlite, Bun.serve for REST+WS+static); `apps/web` is React+Vite served by the daemon in prod, `vite dev` in development. No orchestration, no relay, no adapters in this plan (Plans 2–3).

**Tech Stack:** Bun ≥1.3.5 (PTY via `Bun.spawn({terminal})`), TypeScript strict, zod, React 18 + Vite, TanStack Query, Tailwind, ghostty-web (`coder/ghostty-web`), bun test.

## Global Constraints

- **Latest stable everything:** every dependency version written in this plan is an illustrative minimum. At execution time (Task 1), resolve EACH package to its latest stable (`bun pm view <pkg> version`), use that, and record the resolved set in the Task 1 commit body. Same for Bun itself (`bun upgrade` to latest stable first).
- Spec is the source of truth: `docs/superpowers/specs/2026-07-19-codegent-design.md`. On conflict, spec wins.
- Bun ≥ 1.3.5 required (native PTY). Verify with `bun --version` before starting.
- Terminal engine is **ghostty-web only** — never add xterm.js in any form. It is NOT installed from npm (release is stale): it is vendored as a git submodule at `vendor/ghostty-web` pinned to a recent `main` commit and **built from source** in Task 3; `apps/web` depends on it via `"ghostty-web": "file:../../vendor/ghostty-web"`.
- UI language is **English**; no emoji anywhere in UI chrome (Lucide-style inline SVG only).
- Nebula tokens (CSS variables, exact values): bg `#0d1117`, bg-deep `#010409`, surface `#161b22`, surface-2 `#21262d`, border `#30363d`, hairline `#1c2128`, text `#e6edf3`, text-2 `#adbac7`, ctrl `#9aa4b2`, meta `#7d8590`, dim `#57606a`, violet `#6d28d9`, violet-2 `#8b5cf6`, amber `#e8c163`, amber-dim `#9d8b4a`, red `#ffa198`, green `#7ee2a8`, git-green `#3fb950`, git-red `#f85149`.
- Font sizes only from ladder 9.5/10/11/12/13px; weights 400/500 (650 only inside badge caps). Radii 6/8/999px. Worktree dots 7px.
- Columns (fixed, English): Queue / Running / Waiting for Input / In Review / Done. v0.1 is **manual mode**: no orchestrator, users move cards freely between the five columns; `Waiting`-derivation and drag legality rules arrive in Plan 2.
- Branch naming for managed worktrees: `cg/<cardId>-<slug>`; worktrees live under `<repo>/.codegent/worktrees/`.
- Default daemon port **4666**, auto-increment if busy; localhost auth token required on every request (multi-user machines).
- Scrollback ring per session ≈ **200KB**, flushed to disk; reattach replays the ring through the terminal engine.
- **Commits: plain messages, NO attribution trailers of any kind** (no Co-Authored-By, no Generated-with). Conventional-commit style `feat:/fix:/test:/chore:`.
- License: AGPL-3.0 (root `LICENSE`).
- Study-first rule: spike tasks write findings to `docs/research/`.

## File Structure (locked by this plan)

```
package.json                     # bun workspaces root
tsconfig.base.json
LICENSE                          # AGPL-3.0
packages/protocol/
  package.json
  src/entities.ts                # Project/Card/Worktree/Session schemas (zod)
  src/envelope.ts                # WS envelope: encode/decode, channel types
  src/index.ts                   # re-exports
  test/entities.test.ts
  test/envelope.test.ts
apps/daemon/
  package.json
  src/config.ts                  # port scan, data dir, auth token
  src/store/db.ts                # sqlite open + migrations
  src/store/projects.ts
  src/store/cards.ts
  src/store/sessions.ts          # session rows (metadata only)
  src/pty/ring.ts                # byte ring buffer + disk flush
  src/pty/session.ts             # PtySession (spawn/attach/write/kill)
  src/pty/manager.ts             # registry keyed by session id
  src/git/worktrees.ts           # create/list/archive worktrees
  src/http/server.ts             # Bun.serve: static + REST + WS upgrade
  src/http/ws.ts                 # per-socket mux: subscribe terminal/events
  src/events.ts                  # tiny event bus (daemon-wide)
  src/index.ts                   # entry
  test/*.test.ts                 # one file per module above
apps/web/
  package.json
  index.html
  vite.config.ts
  src/main.tsx
  src/theme.css                  # Nebula tokens + base
  src/api.ts                     # REST client + WS client (typed by protocol)
  src/keys.ts                    # global keyboard map (1/2/3, K, Esc)
  src/components/Shell.tsx       # sidebar + topbar + view switch + strip
  src/components/Sidebar.tsx
  src/components/Board.tsx
  src/components/Card.tsx
  src/components/TerminalView.tsx
  src/components/SessionRail.tsx
  src/components/GhosttyTerm.tsx # engine wrapper (attach WS channel)
  src/components/Palette.tsx
  src/test/envelope-roundtrip.test.ts
docs/research/                   # spike findings
.buildkite/pipeline.yml
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `LICENSE`, `packages/protocol/package.json`, `apps/daemon/package.json`, `apps/web/package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: workspace layout every later task assumes; `bun test` runs from repo root.

- [ ] **Step 1: Verify Bun version**

Run: `bun --version`
Expected: `1.3.5` or higher. If lower: `bun upgrade` first. Record the exact version in the final commit message body.

- [ ] **Step 2: Write root workspace files**

`package.json`:
```json
{
  "name": "codegent",
  "private": true,
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "test": "bun test",
    "dev:daemon": "bun run --cwd apps/daemon dev",
    "dev:web": "bun run --cwd apps/web dev"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "types": ["bun-types"],
    "skipLibCheck": true
  }
}
```

`packages/protocol/package.json`:
```json
{ "name": "@codegent/protocol", "version": "0.0.1", "type": "module", "main": "src/index.ts", "dependencies": { "zod": "^3.23.0" } }
```

`apps/daemon/package.json`:
```json
{
  "name": "@codegent/daemon", "version": "0.0.1", "type": "module",
  "scripts": { "dev": "bun --watch src/index.ts" },
  "dependencies": { "@codegent/protocol": "workspace:*" }
}
```

`apps/web/package.json`:
```json
{
  "name": "@codegent/web", "version": "0.0.1", "type": "module",
  "scripts": { "dev": "vite", "build": "vite build" },
  "dependencies": {
    "@codegent/protocol": "workspace:*",
    "react": "^18.3.0", "react-dom": "^18.3.0",
    "@tanstack/react-query": "^5.50.0"
  },
  "devDependencies": { "vite": "^5.4.0", "@vitejs/plugin-react": "^4.3.0", "typescript": "^5.5.0", "tailwindcss": "^3.4.0", "autoprefixer": "^10.4.0", "postcss": "^8.4.0" }
}
```

Append to `.gitignore`:
```
node_modules/
dist/
*.log
.codegent/
docs/research/tmp/
```

Add `LICENSE`: full AGPL-3.0 text (copy verbatim from https://www.gnu.org/licenses/agpl-3.0.txt).

- [ ] **Step 3: Install and smoke-test the workspace**

First resolve latest stables: for each dependency above run `bun pm view <pkg> version` and replace the illustrative number with the latest stable (respect majors: read the migration notes if a major differs from the illustration — e.g. React 19 / Tailwind 4 / zod 4 if current). Then:

Run: `bun install && bun test`
Expected: install succeeds; `bun test` reports `0 tests` (no failures, exit 0).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: bun monorepo scaffold (protocol, daemon, web) + AGPL license"
```

---

### Task 2: Spike — Bun native PTY + single-binary gate (HARD GATE)

**Files:**
- Create: `docs/research/bun-pty-spike.md`, `apps/daemon/test/spike-pty.test.ts`

**Interfaces:**
- Produces: go/no-go for `Bun.spawn({ terminal })`; the exact spawn API shape Task 6 will use, documented in the findings file.

- [ ] **Step 1: Write the spike test (this is a real test that stays in the suite)**

`apps/daemon/test/spike-pty.test.ts`:
```ts
import { test, expect } from "bun:test";

test("Bun.spawn terminal: echo roundtrip + resize", async () => {
  const proc = Bun.spawn({
    cmd: [process.env.SHELL ?? "/bin/zsh", "-i"],
    terminal: { cols: 80, rows: 24 },
    env: { ...process.env, PS1: "SPIKE$ " },
  });
  const term = proc.terminal!;
  const chunks: Uint8Array[] = [];
  const reader = (async () => {
    for await (const chunk of term) chunks.push(chunk as Uint8Array);
  })();
  term.write("printf 'PTY_OK_%s\\n' 42\r");
  await Bun.sleep(500);
  term.resize(120, 40);
  term.write("exit\r");
  await proc.exited;
  await reader.catch(() => {});
  const out = Buffer.concat(chunks).toString();
  expect(out).toContain("PTY_OK_42");
}, 15000);
```

Note: if the real Bun API differs (e.g. output arrives on `proc.stdout` instead of iterating `proc.terminal`, or the option is named differently), FIX THE TEST to match the documented API — the deliverable is a passing test that proves the roundtrip; record the true shape in the findings doc.

- [ ] **Step 2: Run it**

Run: `bun test apps/daemon/test/spike-pty.test.ts`
Expected: PASS. If Bun's terminal API cannot deliver echo roundtrip + resize on macOS: STOP — this is the gate; escalate to the plan owner with the findings doc before proceeding (fallback per spec: Rust portable-pty sidecar, which changes Task 6 and needs a plan amendment).

- [ ] **Step 3: Compile gate**

```bash
mkdir -p docs/research/tmp
cat > docs/research/tmp/compile-probe.ts <<'EOF'
const proc = Bun.spawn({ cmd: ["/bin/echo", "compiled-ok"], stdout: "pipe" });
console.log(await new Response(proc.stdout).text());
EOF
bun build --compile docs/research/tmp/compile-probe.ts --outfile docs/research/tmp/probe
./docs/research/tmp/probe
```
Expected: prints `compiled-ok`. Then repeat the PTY test logic inside a compiled binary: copy the spike test body into `docs/research/tmp/compile-pty.ts` (as a plain script that exits 0 on success, 1 on failure), compile, run. Expected exit 0.

- [ ] **Step 4: Write findings**

`docs/research/bun-pty-spike.md` — record: Bun version, exact spawn/terminal API shape used, echo latency observed, resize behavior, compile results, any deviations from assumptions. One page max.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/test/spike-pty.test.ts docs/research/bun-pty-spike.md
git commit -m "test: bun native pty spike passes (echo, resize, compiled binary)"
```

---

### Task 3: Spike — ghostty-web gate (HARD GATE)

**Files:**
- Create: `docs/research/ghostty-web-spike.md`, `apps/web/spike/ghostty.html`, `apps/web/spike/ghostty-spike.ts`

**Interfaces:**
- Produces: a locally built `vendor/ghostty-web` (submodule, pinned SHA) wired into `apps/web`; the exact ghostty-web constructor/API calls Task 13's `GhosttyTerm.tsx` will use (documented in findings); go/no-go on the three spec risks: pane create/destroy soak, throughput, replay-on-reattach.

- [ ] **Step 1: Vendor + build ghostty-web from source (pinned main)**

```bash
git submodule add https://github.com/coder/ghostty-web vendor/ghostty-web
cd vendor/ghostty-web
git fetch origin main && git checkout origin/main   # pin = the SHA you now have; record it
git rev-parse HEAD                                   # → paste into the findings doc
cat README.md                                        # follow ITS build instructions exactly
```

Follow the repo's documented build (expect a WASM toolchain — likely Zig; install what its README names, e.g. `brew install zig`, and record the exact toolchain versions in the findings doc). Typical shape: `bun install && bun run build` producing a `dist/`. Verify the package's `main`/`exports` resolve to built files. Then wire it in:

```bash
cd ../..
# apps/web/package.json → add dependency: "ghostty-web": "file:../../vendor/ghostty-web"
bun install
```

Expected: `bun install` links the local build; `import { Terminal } from "ghostty-web"` resolves in `apps/web`. If the source build fails on the pinned SHA, walk back to the newest SHA that builds green and record both SHAs + failure notes in the findings doc.

- [ ] **Step 2: Build a minimal spike page**

`apps/web/spike/ghostty.html`:
```html
<!doctype html>
<html><body style="background:#0d1117">
<div id="grid" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;height:90vh"></div>
<pre id="log" style="color:#7ee2a8;font:11px monospace"></pre>
<script type="module" src="./ghostty-spike.ts"></script>
</body></html>
```

`apps/web/spike/ghostty-spike.ts`:
```ts
// Adjust the import/constructor to ghostty-web's actual exported API (check
// node_modules/ghostty-web/README.md) — deliverable is a working spike, and
// the findings doc records the real API for Task 13.
import { Terminal } from "ghostty-web";

const log = (m: string) => (document.getElementById("log")!.textContent += m + "\n");
const grid = document.getElementById("grid")!;

// (a) create/destroy soak — 20 cycles of 4 panes
for (let cycle = 0; cycle < 20; cycle++) {
  const terms: { t: any; el: HTMLElement }[] = [];
  for (let i = 0; i < 4; i++) {
    const el = document.createElement("div");
    grid.appendChild(el);
    const t = new Terminal({ cols: 80, rows: 24 });
    t.open(el);
    t.write(`cycle ${cycle} pane ${i}\r\n`);
    terms.push({ t, el });
  }
  await new Promise(r => setTimeout(r, 50));
  for (const { t, el } of terms) { t.dispose?.(); el.remove(); }
}
log("soak: 20x4 create/destroy OK");

// (b) throughput — 5MB of lines into one terminal
const el = document.createElement("div"); grid.appendChild(el);
const t = new Terminal({ cols: 120, rows: 40 }); t.open(el);
const line = "y".repeat(118) + "\r\n";
const start = performance.now();
for (let i = 0; i < 40000; i++) t.write(line);
log(`throughput: 5MB in ${(performance.now() - start).toFixed(0)}ms`);

// (c) replay-on-reattach — write 200KB, dispose, recreate, replay same bytes
const bytes: string[] = [];
for (let i = 0; i < 2000; i++) bytes.push(`replay line ${i} colored \x1b[32mOK\x1b[0m\r\n`);
const t2 = new Terminal({ cols: 120, rows: 40 });
const el2 = document.createElement("div"); grid.appendChild(el2); t2.open(el2);
for (const b of bytes) t2.write(b);
t2.dispose?.(); el2.remove();
const t3 = new Terminal({ cols: 120, rows: 40 });
const el3 = document.createElement("div"); grid.appendChild(el3); t3.open(el3);
for (const b of bytes) t3.write(b);  // ring replay simulation
log("replay: re-fed 200KB ring into fresh terminal — visually verify last lines + colors");
```

- [ ] **Step 3: Run the spike**

Run: `cd apps/web && bunx vite spike --open` (or `bunx vite . --open` and navigate to `/spike/ghostty.html`)
Expected: page completes all three phases; log shows soak OK and a throughput number. Manually verify: no crash/corruption during soak (spec risk #141), throughput for 5MB < 10s, replayed terminal shows correct last lines WITH colors. Additionally type into a pane with an IME (macOS Korean 2-Set) and record behavior.

- [ ] **Step 4: Gate decision + findings**

`docs/research/ghostty-web-spike.md`: pinned SHA + toolchain versions + exact build commands, real API surface (import path, constructor opts, write/dispose/resize names), soak result, throughput ms, replay fidelity, IME notes. If soak crashes or replay corrupts: STOP and escalate with the findings doc (spec says fix upstream — that needs owner sign-off on timeline), do not swap engines.

- [ ] **Step 5: Commit**

```bash
git add .gitmodules vendor/ghostty-web apps/web/package.json apps/web/spike docs/research/ghostty-web-spike.md
git commit -m "feat: vendor ghostty-web from source (pinned main) + spike findings"
```

---

### Task 4: protocol package — entities + WS envelope

**Files:**
- Create: `packages/protocol/src/entities.ts`, `packages/protocol/src/envelope.ts`, `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/entities.test.ts`, `packages/protocol/test/envelope.test.ts`

**Interfaces:**
- Produces (exact, later tasks import these):
  - `CardPhase = "queued"|"running"|"waiting"|"review"|"done"|"cancelled"` (v0.1 manual: phase stored directly)
  - `Project { id: string; name: string; path: string; baseBranch: string; createdAt: number }`
  - `Card { id: number; projectId: string; title: string; body: string; phase: CardPhase; agent: "claude"|"codex"|"none"; worktreeId: string|null; position: number; createdAt: number; updatedAt: number }`
  - `SessionMeta { id: string; projectId: string; kind: "shell"; title: string; cwd: string; worktreeId: string|null; live: boolean; createdAt: number }`
  - `Worktree { id: string; projectId: string; branch: string; path: string; base: string; state: "active"|"archived" }`
  - `Envelope` = `{ ch: "term"; sid: string; data: string /* base64 */ }` | `{ ch: "event"; ev: DomainEvent }` | `{ ch: "sub"; sid: string }` | `{ ch: "unsub"; sid: string }` | `{ ch: "input"; sid: string; data: string }` | `{ ch: "resize"; sid: string; cols: number; rows: number }`
  - `DomainEvent` = `{ t: "card"; card: Card }` | `{ t: "cardDeleted"; id: number }` | `{ t: "session"; session: SessionMeta }` | `{ t: "project"; project: Project }`
  - `encodeEnvelope(e: Envelope): string`, `decodeEnvelope(s: string): Envelope` (throws on invalid)

- [ ] **Step 1: Write failing tests**

`packages/protocol/test/entities.test.ts`:
```ts
import { test, expect } from "bun:test";
import { CardSchema, ProjectSchema } from "../src/entities";

test("card schema accepts a valid card and rejects bad phase", () => {
  const ok = CardSchema.safeParse({
    id: 1, projectId: "p1", title: "t", body: "", phase: "queued",
    agent: "claude", worktreeId: null, position: 0, createdAt: 1, updatedAt: 1,
  });
  expect(ok.success).toBe(true);
  const bad = CardSchema.safeParse({ ...ok.data, phase: "flying" } as any);
  expect(bad.success).toBe(false);
});

test("project schema requires absolute-ish path", () => {
  expect(ProjectSchema.safeParse({ id: "p", name: "n", path: "/tmp/x", baseBranch: "main", createdAt: 1 }).success).toBe(true);
});
```

`packages/protocol/test/envelope.test.ts`:
```ts
import { test, expect } from "bun:test";
import { encodeEnvelope, decodeEnvelope } from "../src/envelope";

test("envelope roundtrip: term data", () => {
  const e = { ch: "term", sid: "s1", data: Buffer.from("hello").toString("base64") } as const;
  expect(decodeEnvelope(encodeEnvelope(e))).toEqual(e);
});

test("decode rejects unknown channel", () => {
  expect(() => decodeEnvelope(JSON.stringify({ ch: "nope" }))).toThrow();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/protocol`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/protocol/src/entities.ts`:
```ts
import { z } from "zod";

export const CardPhase = z.enum(["queued", "running", "waiting", "review", "done", "cancelled"]);
export type CardPhase = z.infer<typeof CardPhase>;

export const ProjectSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), path: z.string().min(1),
  baseBranch: z.string().min(1), createdAt: z.number(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CardSchema = z.object({
  id: z.number().int(), projectId: z.string(), title: z.string().min(1),
  body: z.string(), phase: CardPhase, agent: z.enum(["claude", "codex", "none"]),
  worktreeId: z.string().nullable(), position: z.number(),
  createdAt: z.number(), updatedAt: z.number(),
});
export type Card = z.infer<typeof CardSchema>;

export const SessionMetaSchema = z.object({
  id: z.string(), projectId: z.string(), kind: z.literal("shell"),
  title: z.string(), cwd: z.string(), worktreeId: z.string().nullable(),
  live: z.boolean(), createdAt: z.number(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export const WorktreeSchema = z.object({
  id: z.string(), projectId: z.string(), branch: z.string(), path: z.string(),
  base: z.string(), state: z.enum(["active", "archived"]),
});
export type Worktree = z.infer<typeof WorktreeSchema>;
```

`packages/protocol/src/envelope.ts`:
```ts
import { z } from "zod";
import { CardSchema, ProjectSchema, SessionMetaSchema } from "./entities";

export const DomainEventSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("card"), card: CardSchema }),
  z.object({ t: z.literal("cardDeleted"), id: z.number() }),
  z.object({ t: z.literal("session"), session: SessionMetaSchema }),
  z.object({ t: z.literal("project"), project: ProjectSchema }),
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;

export const EnvelopeSchema = z.discriminatedUnion("ch", [
  z.object({ ch: z.literal("term"), sid: z.string(), data: z.string() }),
  z.object({ ch: z.literal("event"), ev: DomainEventSchema }),
  z.object({ ch: z.literal("sub"), sid: z.string() }),
  z.object({ ch: z.literal("unsub"), sid: z.string() }),
  z.object({ ch: z.literal("input"), sid: z.string(), data: z.string() }),
  z.object({ ch: z.literal("resize"), sid: z.string(), cols: z.number(), rows: z.number() }),
]);
export type Envelope = z.infer<typeof EnvelopeSchema>;

export const encodeEnvelope = (e: Envelope): string => JSON.stringify(EnvelopeSchema.parse(e));
export const decodeEnvelope = (s: string): Envelope => EnvelopeSchema.parse(JSON.parse(s));
```

`packages/protocol/src/index.ts`:
```ts
export * from "./entities";
export * from "./envelope";
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/protocol`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat: protocol package — entity schemas and ws envelope"
```

---

### Task 5: daemon store — sqlite + projects/cards CRUD

**Files:**
- Create: `apps/daemon/src/store/db.ts`, `apps/daemon/src/store/projects.ts`, `apps/daemon/src/store/cards.ts`
- Test: `apps/daemon/test/store.test.ts`

**Interfaces:**
- Consumes: `Project`, `Card`, `CardPhase` from `@codegent/protocol`.
- Produces:
  - `openDb(path: string): Database` (runs migrations; `":memory:"` supported for tests)
  - `createProject(db, { name, path, baseBranch }): Project` (id = slug of name + 4 random hex)
  - `listProjects(db): Project[]`
  - `createCard(db, { projectId, title, body, agent }): Card` (phase "queued", position = max+1)
  - `updateCard(db, id, patch: Partial<Pick<Card,"title"|"body"|"phase"|"position"|"agent"|"worktreeId">>): Card`
  - `deleteCard(db, id): void`
  - `listCards(db, projectId): Card[]` (ordered by phase, position)

- [ ] **Step 1: Write failing tests**

`apps/daemon/test/store.test.ts`:
```ts
import { test, expect } from "bun:test";
import { openDb } from "../src/store/db";
import { createProject, listProjects } from "../src/store/projects";
import { createCard, updateCard, deleteCard, listCards } from "../src/store/cards";

const db = openDb(":memory:");

test("project create/list", () => {
  const p = createProject(db, { name: "My App", path: "/tmp/myapp", baseBranch: "main" });
  expect(p.id).toMatch(/^my-app-[0-9a-f]{4}$/);
  expect(listProjects(db).length).toBe(1);
});

test("card lifecycle", () => {
  const p = createProject(db, { name: "B", path: "/tmp/b", baseBranch: "main" });
  const c1 = createCard(db, { projectId: p.id, title: "First", body: "", agent: "claude" });
  const c2 = createCard(db, { projectId: p.id, title: "Second", body: "", agent: "none" });
  expect(c1.phase).toBe("queued");
  expect(c2.position).toBeGreaterThan(c1.position);
  const moved = updateCard(db, c2.id, { phase: "running" });
  expect(moved.phase).toBe("running");
  deleteCard(db, c1.id);
  expect(listCards(db, p.id).map(c => c.id)).toEqual([c2.id]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/daemon/test/store.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`apps/daemon/src/store/db.ts`:
```ts
import { Database } from "bun:sqlite";

const MIGRATIONS = [
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
     base_branch TEXT NOT NULL, created_at INTEGER NOT NULL);`,
  `CREATE TABLE cards (
     id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id),
     title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', phase TEXT NOT NULL DEFAULT 'queued',
     agent TEXT NOT NULL DEFAULT 'none', worktree_id TEXT, position REAL NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'shell',
     title TEXT NOT NULL, cwd TEXT NOT NULL, worktree_id TEXT,
     live INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);`,
  `CREATE TABLE worktrees (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch TEXT NOT NULL,
     path TEXT NOT NULL, base TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active');`,
];

export function openDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (idx INTEGER PRIMARY KEY);`);
  const done = new Set(db.query(`SELECT idx FROM _migrations`).all().map((r: any) => r.idx));
  MIGRATIONS.forEach((sql, idx) => {
    if (!done.has(idx)) {
      db.exec(sql);
      db.query(`INSERT INTO _migrations (idx) VALUES (?1)`).run(idx);
    }
  });
  return db;
}
```

`apps/daemon/src/store/projects.ts`:
```ts
import type { Database } from "bun:sqlite";
import type { Project } from "@codegent/protocol";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const rowToProject = (r: any): Project => ({
  id: r.id, name: r.name, path: r.path, baseBranch: r.base_branch, createdAt: r.created_at,
});

export function createProject(db: Database, p: { name: string; path: string; baseBranch: string }): Project {
  const id = `${slug(p.name)}-${crypto.randomUUID().slice(0, 4)}`;
  const now = Date.now();
  db.query(`INSERT INTO projects (id, name, path, base_branch, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`)
    .run(id, p.name, p.path, p.baseBranch, now);
  return { id, name: p.name, path: p.path, baseBranch: p.baseBranch, createdAt: now };
}

export function listProjects(db: Database): Project[] {
  return db.query(`SELECT * FROM projects ORDER BY created_at`).all().map(rowToProject);
}
```

`apps/daemon/src/store/cards.ts`:
```ts
import type { Database } from "bun:sqlite";
import type { Card } from "@codegent/protocol";

const rowToCard = (r: any): Card => ({
  id: r.id, projectId: r.project_id, title: r.title, body: r.body, phase: r.phase,
  agent: r.agent, worktreeId: r.worktree_id, position: r.position,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

export function createCard(db: Database, c: { projectId: string; title: string; body: string; agent: Card["agent"] }): Card {
  const now = Date.now();
  const max = db.query(`SELECT COALESCE(MAX(position), 0) AS m FROM cards WHERE project_id = ?1`).get(c.projectId) as any;
  const res = db.query(
    `INSERT INTO cards (project_id, title, body, agent, position, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) RETURNING *`
  ).get(c.projectId, c.title, c.body, c.agent, max.m + 1, now) as any;
  return rowToCard(res);
}

const PATCHABLE = ["title", "body", "phase", "position", "agent", "worktreeId"] as const;
const COL: Record<string, string> = { worktreeId: "worktree_id" };

export function updateCard(db: Database, id: number, patch: Partial<Pick<Card, (typeof PATCHABLE)[number]>>): Card {
  const sets: string[] = []; const vals: any[] = [];
  for (const k of PATCHABLE) if (k in patch) { sets.push(`${COL[k] ?? k} = ?${vals.length + 2}`); vals.push((patch as any)[k]); }
  sets.push(`updated_at = ?${vals.length + 2}`); vals.push(Date.now());
  const row = db.query(`UPDATE cards SET ${sets.join(", ")} WHERE id = ?1 RETURNING *`).get(id, ...vals) as any;
  if (!row) throw new Error(`card ${id} not found`);
  return rowToCard(row);
}

export function deleteCard(db: Database, id: number): void {
  db.query(`DELETE FROM cards WHERE id = ?1`).run(id);
}

export function listCards(db: Database, projectId: string): Card[] {
  return db.query(`SELECT * FROM cards WHERE project_id = ?1 ORDER BY phase, position`).all(projectId).map(rowToCard);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test apps/daemon/test/store.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/store apps/daemon/test/store.test.ts
git commit -m "feat: daemon sqlite store — migrations, projects, cards"
```

---

### Task 6: PTY ring buffer + PtySession

**Files:**
- Create: `apps/daemon/src/pty/ring.ts`, `apps/daemon/src/pty/session.ts`
- Test: `apps/daemon/test/ring.test.ts`, `apps/daemon/test/pty-session.test.ts`

**Interfaces:**
- Consumes: the spawn shape proven in Task 2.
- Produces:
  - `class Ring { constructor(cap: number); push(b: Uint8Array): void; snapshot(): Uint8Array; flushTo(path: string): Promise<void>; static async load(path: string, cap: number): Promise<Ring> }`
  - `class PtySession { constructor(opts: { id: string; cwd: string; shell?: string; cols?: number; rows?: number; ringPath: string }); onData(cb: (b: Uint8Array) => void): () => void; write(data: Uint8Array | string): void; resize(cols: number, rows: number): void; kill(): void; readonly exited: Promise<number>; snapshot(): Uint8Array }`
  - Ring capacity constant `RING_CAP = 200 * 1024`.

- [ ] **Step 1: Failing ring tests**

`apps/daemon/test/ring.test.ts`:
```ts
import { test, expect } from "bun:test";
import { Ring } from "../src/pty/ring";

test("ring keeps only last cap bytes", () => {
  const r = new Ring(10);
  r.push(new TextEncoder().encode("0123456789ABCDEF")); // 16 bytes into cap 10
  expect(new TextDecoder().decode(r.snapshot())).toBe("6789ABCDEF");
  r.push(new TextEncoder().encode("xy"));
  expect(new TextDecoder().decode(r.snapshot())).toBe("89ABCDEFxy");
});

test("ring flush/load roundtrip", async () => {
  const r = new Ring(1024);
  r.push(new TextEncoder().encode("persist me"));
  const p = `/tmp/codegent-ring-${crypto.randomUUID()}.bin`;
  await r.flushTo(p);
  const r2 = await Ring.load(p, 1024);
  expect(new TextDecoder().decode(r2.snapshot())).toBe("persist me");
});
```

- [ ] **Step 2: Run — expect FAIL** (`bun test apps/daemon/test/ring.test.ts`)

- [ ] **Step 3: Implement Ring**

`apps/daemon/src/pty/ring.ts`:
```ts
export const RING_CAP = 200 * 1024;

export class Ring {
  private buf: Uint8Array;
  private len = 0;   // valid bytes
  private head = 0;  // write index
  constructor(private cap: number) { this.buf = new Uint8Array(cap); }

  push(b: Uint8Array): void {
    if (b.length >= this.cap) {
      this.buf.set(b.subarray(b.length - this.cap));
      this.head = 0; this.len = this.cap;
      return;
    }
    const tail = Math.min(b.length, this.cap - this.head);
    this.buf.set(b.subarray(0, tail), this.head);
    if (b.length > tail) this.buf.set(b.subarray(tail), 0);
    this.head = (this.head + b.length) % this.cap;
    this.len = Math.min(this.cap, this.len + b.length);
  }

  snapshot(): Uint8Array {
    const out = new Uint8Array(this.len);
    if (this.len < this.cap) { out.set(this.buf.subarray(0, this.len)); return out; }
    out.set(this.buf.subarray(this.head));
    out.set(this.buf.subarray(0, this.head), this.cap - this.head);
    return out;
  }

  async flushTo(path: string): Promise<void> { await Bun.write(path, this.snapshot()); }

  static async load(path: string, cap: number): Promise<Ring> {
    const r = new Ring(cap);
    const f = Bun.file(path);
    if (await f.exists()) r.push(new Uint8Array(await f.arrayBuffer()));
    return r;
  }
}
```

- [ ] **Step 4: Run ring tests — expect PASS**

- [ ] **Step 5: Failing PtySession test**

`apps/daemon/test/pty-session.test.ts`:
```ts
import { test, expect } from "bun:test";
import { PtySession } from "../src/pty/session";

test("pty session: data flows, ring accumulates, write works", async () => {
  const ringPath = `/tmp/codegent-s-${crypto.randomUUID()}.bin`;
  const s = new PtySession({ id: "s1", cwd: "/tmp", ringPath });
  const got: Uint8Array[] = [];
  const off = s.onData(b => got.push(b));
  s.write("printf 'SESSION_OK\\n'\r");
  await Bun.sleep(600);
  s.write("exit\r");
  await s.exited;
  off();
  const all = new TextDecoder().decode(s.snapshot());
  expect(all).toContain("SESSION_OK");
  expect(got.length).toBeGreaterThan(0);
}, 15000);
```

- [ ] **Step 6: Run — expect FAIL**

- [ ] **Step 7: Implement PtySession** (adapt spawn call to the Task-2-proven API shape)

`apps/daemon/src/pty/session.ts`:
```ts
import { Ring, RING_CAP } from "./ring";

type DataCb = (b: Uint8Array) => void;

export class PtySession {
  readonly id: string;
  readonly exited: Promise<number>;
  private proc: any;
  private term: any;
  private ring: Ring;
  private cbs = new Set<DataCb>();
  private flushTimer: ReturnType<typeof setInterval>;

  constructor(opts: { id: string; cwd: string; shell?: string; cols?: number; rows?: number; ringPath: string }) {
    this.id = opts.id;
    this.ring = new Ring(RING_CAP);
    this.proc = Bun.spawn({
      cmd: [opts.shell ?? process.env.SHELL ?? "/bin/zsh", "-i"],
      cwd: opts.cwd,
      terminal: { cols: opts.cols ?? 120, rows: opts.rows ?? 32 },
      env: { ...process.env },
    });
    this.term = this.proc.terminal;
    (async () => {
      for await (const chunk of this.term) {
        const b = chunk as Uint8Array;
        this.ring.push(b);
        for (const cb of this.cbs) cb(b);
      }
    })().catch(() => {});
    this.flushTimer = setInterval(() => this.ring.flushTo(opts.ringPath).catch(() => {}), 3000);
    this.exited = this.proc.exited.finally(() => {
      clearInterval(this.flushTimer);
      return this.ring.flushTo(opts.ringPath).catch(() => {});
    });
  }

  onData(cb: DataCb): () => void { this.cbs.add(cb); return () => this.cbs.delete(cb); }
  write(data: Uint8Array | string): void { this.term.write(data); }
  resize(cols: number, rows: number): void { this.term.resize(cols, rows); }
  kill(): void { this.proc.kill(); }
  snapshot(): Uint8Array { return this.ring.snapshot(); }
}
```

- [ ] **Step 8: Run — expect PASS**, then commit

```bash
git add apps/daemon/src/pty apps/daemon/test/ring.test.ts apps/daemon/test/pty-session.test.ts
git commit -m "feat: pty session with 200KB persistent scrollback ring"
```

---

### Task 7: PTY manager + session store rows

**Files:**
- Create: `apps/daemon/src/pty/manager.ts`, `apps/daemon/src/store/sessions.ts`, `apps/daemon/src/events.ts`
- Test: `apps/daemon/test/manager.test.ts`

**Interfaces:**
- Consumes: `PtySession` (Task 6), `openDb` (Task 5), `SessionMeta`, `DomainEvent`.
- Produces:
  - `events: { on(cb: (e: DomainEvent) => void): () => void; emit(e: DomainEvent): void }` (singleton bus in `src/events.ts`)
  - `class PtyManager { constructor(db: Database, dataDir: string); open(opts: { projectId: string; cwd: string; title: string; worktreeId?: string | null }): SessionMeta; get(id: string): PtySession | undefined; list(projectId: string): SessionMeta[]; close(id: string): void }`
  - Manager emits `{ t: "session", session }` on open/close (live flag flips), persists rows via `src/store/sessions.ts`:
    - `insertSession(db, meta: SessionMeta): void`, `setSessionLive(db, id, live: boolean): void`, `listSessions(db, projectId): SessionMeta[]`

- [ ] **Step 1: Failing test**

`apps/daemon/test/manager.test.ts`:
```ts
import { test, expect } from "bun:test";
import { openDb } from "../src/store/db";
import { PtyManager } from "../src/pty/manager";
import { events } from "../src/events";

test("manager opens shell session, lists it, closes it, emits events", async () => {
  const db = openDb(":memory:");
  const seen: string[] = [];
  const off = events.on(e => { if (e.t === "session") seen.push(`${e.session.id}:${e.session.live}`); });
  const m = new PtyManager(db, `/tmp/codegent-test-${crypto.randomUUID()}`);
  const meta = m.open({ projectId: "p1", cwd: "/tmp", title: "main" });
  expect(m.list("p1").length).toBe(1);
  expect(m.get(meta.id)).toBeDefined();
  m.close(meta.id);
  await Bun.sleep(300);
  expect(seen[0]).toBe(`${meta.id}:true`);
  expect(seen.at(-1)).toBe(`${meta.id}:false`);
  off();
}, 15000);
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

`apps/daemon/src/events.ts`:
```ts
import type { DomainEvent } from "@codegent/protocol";
type Cb = (e: DomainEvent) => void;
const cbs = new Set<Cb>();
export const events = {
  on(cb: Cb) { cbs.add(cb); return () => cbs.delete(cb); },
  emit(e: DomainEvent) { for (const cb of cbs) cb(e); },
};
```

`apps/daemon/src/store/sessions.ts`:
```ts
import type { Database } from "bun:sqlite";
import type { SessionMeta } from "@codegent/protocol";

const toMeta = (r: any): SessionMeta => ({
  id: r.id, projectId: r.project_id, kind: "shell", title: r.title,
  cwd: r.cwd, worktreeId: r.worktree_id, live: !!r.live, createdAt: r.created_at,
});

export function insertSession(db: Database, m: SessionMeta): void {
  db.query(`INSERT INTO sessions (id, project_id, kind, title, cwd, worktree_id, live, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
    .run(m.id, m.projectId, m.kind, m.title, m.cwd, m.worktreeId, m.live ? 1 : 0, m.createdAt);
}
export function setSessionLive(db: Database, id: string, live: boolean): void {
  db.query(`UPDATE sessions SET live = ?2 WHERE id = ?1`).run(id, live ? 1 : 0);
}
export function listSessions(db: Database, projectId: string): SessionMeta[] {
  return db.query(`SELECT * FROM sessions WHERE project_id = ?1 ORDER BY created_at`).all(projectId).map(toMeta);
}
```

`apps/daemon/src/pty/manager.ts`:
```ts
import type { Database } from "bun:sqlite";
import type { SessionMeta } from "@codegent/protocol";
import { PtySession } from "./session";
import { insertSession, setSessionLive, listSessions } from "../store/sessions";
import { events } from "../events";
import { mkdirSync } from "node:fs";

export class PtyManager {
  private live = new Map<string, PtySession>();
  constructor(private db: Database, private dataDir: string) {
    mkdirSync(`${dataDir}/rings`, { recursive: true });
  }

  open(opts: { projectId: string; cwd: string; title: string; worktreeId?: string | null }): SessionMeta {
    const id = crypto.randomUUID().slice(0, 8);
    const meta: SessionMeta = {
      id, projectId: opts.projectId, kind: "shell", title: opts.title,
      cwd: opts.cwd, worktreeId: opts.worktreeId ?? null, live: true, createdAt: Date.now(),
    };
    const s = new PtySession({ id, cwd: opts.cwd, ringPath: `${this.dataDir}/rings/${id}.bin` });
    this.live.set(id, s);
    insertSession(this.db, meta);
    events.emit({ t: "session", session: meta });
    s.exited.then(() => {
      this.live.delete(id);
      setSessionLive(this.db, id, false);
      events.emit({ t: "session", session: { ...meta, live: false } });
    });
    return meta;
  }

  get(id: string): PtySession | undefined { return this.live.get(id); }
  list(projectId: string): SessionMeta[] { return listSessions(this.db, projectId); }
  close(id: string): void { this.live.get(id)?.kill(); }
}
```

- [ ] **Step 4: Run — expect PASS**, then commit

```bash
git add apps/daemon/src/pty/manager.ts apps/daemon/src/store/sessions.ts apps/daemon/src/events.ts apps/daemon/test/manager.test.ts
git commit -m "feat: pty manager with session registry and domain events"
```

---

### Task 8: git worktree manager

**Files:**
- Create: `apps/daemon/src/git/worktrees.ts`
- Test: `apps/daemon/test/worktrees.test.ts`

**Interfaces:**
- Consumes: `Worktree` from protocol; `openDb`.
- Produces:
  - `createWorktree(db, project: Project, opts: { cardId?: number; slugSource: string; base?: string }): Promise<Worktree>` — branch `cg/<cardId>-<slug>` when cardId given, else `wt/<slug>`; path `<project.path>/.codegent/worktrees/<branch-with-slashes-as-dashes>`; ensures `.codegent/` line exists in the repo's `.git/info/exclude` (never touches the user's .gitignore).
  - `listWorktrees(db, projectId): Worktree[]`
  - `archiveWorktree(db, project: Project, id: string): Promise<void>` — `git worktree remove --force <path>` (branch is kept), row state → "archived".
  - All git invocations via `Bun.spawn` with `cwd: project.path`; on non-zero exit throw `Error(stderr)` (callers surface state, never the text — spec principle 1 lives at the UI layer).

- [ ] **Step 1: Failing test (uses a real temp git repo)**

`apps/daemon/test/worktrees.test.ts`:
```ts
import { test, expect, beforeAll } from "bun:test";
import { openDb } from "../src/store/db";
import { createProject } from "../src/store/projects";
import { createWorktree, listWorktrees, archiveWorktree } from "../src/git/worktrees";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sh = async (cwd: string, ...cmd: string[]) => {
  const p = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
};

let repo: string;
beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "cg-repo-"));
  await sh(repo, "git", "init", "-b", "main");
  await sh(repo, "git", "config", "user.email", "t@t"); 
  await sh(repo, "git", "config", "user.name", "t");
  await Bun.write(join(repo, "a.txt"), "hello");
  await sh(repo, "git", "add", "-A");
  await sh(repo, "git", "commit", "-m", "init");
});

test("create, list, archive worktree", async () => {
  const db = openDb(":memory:");
  const project = createProject(db, { name: "R", path: repo, baseBranch: "main" });
  const wt = await createWorktree(db, project, { cardId: 7, slugSource: "Fix Stripe webhook retries" });
  expect(wt.branch).toBe("cg/7-fix-stripe-webhook-retries");
  expect(await Bun.file(join(wt.path, "a.txt")).exists()).toBe(true);
  expect(listWorktrees(db, project.id).length).toBe(1);
  await archiveWorktree(db, project, wt.id);
  expect(listWorktrees(db, project.id)[0].state).toBe("archived");
  expect(await Bun.file(join(wt.path, "a.txt")).exists()).toBe(false);
}, 20000);
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

`apps/daemon/src/git/worktrees.ts`:
```ts
import type { Database } from "bun:sqlite";
import type { Project, Worktree } from "@codegent/protocol";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  const out = await new Response(p.stdout).text();
  if (code !== 0) throw new Error(await new Response(p.stderr).text());
  return out;
}

function ensureExcluded(repoPath: string): void {
  const excl = join(repoPath, ".git", "info", "exclude");
  const line = ".codegent/";
  const cur = existsSync(excl) ? readFileSync(excl, "utf8") : "";
  if (!cur.split("\n").includes(line)) writeFileSync(excl, cur.endsWith("\n") || cur === "" ? cur + line + "\n" : cur + "\n" + line + "\n");
}

const toWt = (r: any): Worktree => ({ id: r.id, projectId: r.project_id, branch: r.branch, path: r.path, base: r.base, state: r.state });

export async function createWorktree(
  db: Database, project: Project,
  opts: { cardId?: number; slugSource: string; base?: string },
): Promise<Worktree> {
  const base = opts.base ?? project.baseBranch;
  const branch = opts.cardId != null ? `cg/${opts.cardId}-${slug(opts.slugSource)}` : `wt/${slug(opts.slugSource)}`;
  const dirName = branch.replace(/\//g, "-");
  const path = join(project.path, ".codegent", "worktrees", dirName);
  mkdirSync(join(project.path, ".codegent", "worktrees"), { recursive: true });
  ensureExcluded(project.path);
  await git(project.path, "worktree", "add", "-b", branch, path, base);
  const wt: Worktree = { id: crypto.randomUUID().slice(0, 8), projectId: project.id, branch, path, base, state: "active" };
  db.query(`INSERT INTO worktrees (id, project_id, branch, path, base, state) VALUES (?1,?2,?3,?4,?5,?6)`)
    .run(wt.id, wt.projectId, wt.branch, wt.path, wt.base, wt.state);
  return wt;
}

export function listWorktrees(db: Database, projectId: string): Worktree[] {
  return db.query(`SELECT * FROM worktrees WHERE project_id = ?1`).all(projectId).map(toWt);
}

export async function archiveWorktree(db: Database, project: Project, id: string): Promise<void> {
  const row = db.query(`SELECT * FROM worktrees WHERE id = ?1`).get(id) as any;
  if (!row) throw new Error(`worktree ${id} not found`);
  await git(project.path, "worktree", "remove", "--force", row.path);
  db.query(`UPDATE worktrees SET state = 'archived' WHERE id = ?1`).run(id);
}
```

- [ ] **Step 4: Run — expect PASS**, then commit

```bash
git add apps/daemon/src/git apps/daemon/test/worktrees.test.ts
git commit -m "feat: git worktree manager — cg/<id>-<slug> create, list, archive"
```

---

### Task 9: HTTP + WS server

**Files:**
- Create: `apps/daemon/src/config.ts`, `apps/daemon/src/http/server.ts`, `apps/daemon/src/http/ws.ts`, `apps/daemon/src/index.ts`
- Test: `apps/daemon/test/http.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `loadConfig(): { port: number; dataDir: string; token: string }` — port from 4666 upward (probe with `Bun.listen` try/catch), dataDir `~/.codegent` (override `CODEGENT_DATA_DIR` for tests), token = random 32-hex persisted at `<dataDir>/token`.
  - `startServer(cfg, db, ptys): { url: string; stop(): void }` with routes (all require `?t=<token>` query or `x-codegent-token` header; 401 otherwise):
    - `GET /api/projects` → `Project[]` · `POST /api/projects {name,path,baseBranch?}` → `Project` (validates path is a git repo via `git rev-parse`; baseBranch default = `origin/HEAD` resolution, fallback current branch)
    - `GET /api/projects/:id/cards` → `Card[]` · `POST .../cards {title,body,agent}` → `Card` · `PATCH /api/cards/:id {..}` → `Card` · `DELETE /api/cards/:id`
    - `GET /api/projects/:id/sessions` → `SessionMeta[]` · `POST .../sessions {cwd?, worktreeId?, title}` → opens PTY, returns meta · `DELETE /api/sessions/:id`
    - `GET /api/projects/:id/worktrees` → `Worktree[]` · `POST .../worktrees {name, base?}` → scratch worktree
    - `GET /ws?t=<token>` → WebSocket speaking the protocol Envelope: client sends `sub {sid}` → server replies one `term` frame containing the full ring snapshot (base64), then streams live; `input`/`resize` forwarded to the session; every DomainEvent broadcast as `event` to all sockets.
    - `GET /*` → static files from `apps/web/dist` when present, else 404 JSON.
  - Card mutations emit `{t:"card"}` / `{t:"cardDeleted"}` on the bus (this is what makes the UI live).

- [ ] **Step 1: Failing HTTP test**

`apps/daemon/test/http.test.ts`:
```ts
import { test, expect } from "bun:test";
import { openDb } from "../src/store/db";
import { PtyManager } from "../src/pty/manager";
import { startServer } from "../src/http/server";
import { decodeEnvelope, encodeEnvelope } from "@codegent/protocol";

const db = openDb(":memory:");
const dataDir = `/tmp/cg-http-${crypto.randomUUID()}`;
const ptys = new PtyManager(db, dataDir);
const cfg = { port: 4790 + Math.floor(Math.random() * 100), dataDir, token: "testtoken" };
const srv = startServer(cfg, db, ptys);
const base = `${srv.url}api`;
const T = { headers: { "x-codegent-token": "testtoken", "content-type": "application/json" } };

test("auth required", async () => {
  const r = await fetch(`${base}/projects`);
  expect(r.status).toBe(401);
});

test("project + card REST roundtrip + ws event", async () => {
  const ws = new WebSocket(`${srv.url.replace("http", "ws")}ws?t=testtoken`);
  const events: any[] = [];
  ws.onmessage = m => { const e = decodeEnvelope(String(m.data)); if (e.ch === "event") events.push(e.ev); };
  await new Promise(r => (ws.onopen = r));

  const p = await (await fetch(`${base}/projects`, { ...T, method: "POST", body: JSON.stringify({ name: "X", path: "/tmp", baseBranch: "main", skipGitCheck: true }) })).json();
  const c = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "hello", body: "", agent: "none" }) })).json();
  expect(c.phase).toBe("queued");
  const moved = await (await fetch(`${base}/cards/${c.id}`, { ...T, method: "PATCH", body: JSON.stringify({ phase: "running" }) })).json();
  expect(moved.phase).toBe("running");
  await Bun.sleep(200);
  expect(events.some(e => e.t === "card" && e.card.phase === "running")).toBe(true);
  ws.close();
}, 15000);

test("terminal over ws: snapshot then live", async () => {
  const meta = ptys.open({ projectId: "p", cwd: "/tmp", title: "t" });
  const ws = new WebSocket(`${srv.url.replace("http", "ws")}ws?t=testtoken`);
  const frames: string[] = [];
  ws.onmessage = m => { const e = decodeEnvelope(String(m.data)); if (e.ch === "term" && e.sid === meta.id) frames.push(Buffer.from(e.data, "base64").toString()); };
  await new Promise(r => (ws.onopen = r));
  ws.send(encodeEnvelope({ ch: "sub", sid: meta.id }));
  await Bun.sleep(300);
  ws.send(encodeEnvelope({ ch: "input", sid: meta.id, data: Buffer.from("printf 'WS_OK\\n'\r").toString("base64") }));
  await Bun.sleep(700);
  expect(frames.join("")).toContain("WS_OK");
  ws.close(); ptys.close(meta.id);
}, 20000);
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

`apps/daemon/src/config.ts`:
```ts
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function loadConfig(): { port: number; dataDir: string; token: string } {
  const dataDir = process.env.CODEGENT_DATA_DIR ?? join(homedir(), ".codegent");
  mkdirSync(dataDir, { recursive: true });
  const tokenPath = join(dataDir, "token");
  if (!existsSync(tokenPath)) writeFileSync(tokenPath, crypto.randomUUID().replace(/-/g, ""));
  const token = readFileSync(tokenPath, "utf8").trim();
  let port = 4666;
  for (; port < 4766; port++) {
    try { const l = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); l.stop(); break; }
    catch { /* busy, try next */ }
  }
  return { port, dataDir, token };
}
```

`apps/daemon/src/http/ws.ts`:
```ts
import type { ServerWebSocket } from "bun";
import { encodeEnvelope, decodeEnvelope, type DomainEvent } from "@codegent/protocol";
import type { PtyManager } from "../pty/manager";
import { events } from "../events";

type WsData = { subs: Map<string, () => void> };
const sockets = new Set<ServerWebSocket<WsData>>();

events.on((e: DomainEvent) => {
  const msg = encodeEnvelope({ ch: "event", ev: e });
  for (const ws of sockets) ws.send(msg);
});

export const wsHandlers = (ptys: PtyManager) => ({
  open(ws: ServerWebSocket<WsData>) { ws.data = { subs: new Map() }; sockets.add(ws); },
  close(ws: ServerWebSocket<WsData>) { for (const off of ws.data.subs.values()) off(); sockets.delete(ws); },
  message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    let env; try { env = decodeEnvelope(String(raw)); } catch { return; }
    if (env.ch === "sub") {
      const s = ptys.get(env.sid); if (!s) return;
      ws.send(encodeEnvelope({ ch: "term", sid: env.sid, data: Buffer.from(s.snapshot()).toString("base64") }));
      const off = s.onData(b => ws.send(encodeEnvelope({ ch: "term", sid: env.sid, data: Buffer.from(b).toString("base64") })));
      ws.data.subs.set(env.sid, off);
    } else if (env.ch === "unsub") {
      ws.data.subs.get(env.sid)?.(); ws.data.subs.delete(env.sid);
    } else if (env.ch === "input") {
      ptys.get(env.sid)?.write(Buffer.from(env.data, "base64"));
    } else if (env.ch === "resize") {
      ptys.get(env.sid)?.resize(env.cols, env.rows);
    }
  },
});
```

`apps/daemon/src/http/server.ts`:
```ts
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createProject, listProjects } from "../store/projects";
import { createCard, updateCard, deleteCard, listCards } from "../store/cards";
import { createWorktree, listWorktrees } from "../git/worktrees";
import type { PtyManager } from "../pty/manager";
import { events } from "../events";
import { wsHandlers } from "./ws";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function resolveBaseBranch(path: string): Promise<string> {
  const run = async (...args: string[]) => {
    const p = Bun.spawn({ cmd: ["git", ...args], cwd: path, stdout: "pipe", stderr: "pipe" });
    return (await p.exited) === 0 ? (await new Response(p.stdout).text()).trim() : null;
  };
  const head = await run("symbolic-ref", "refs/remotes/origin/HEAD", "--short"); // e.g. origin/main
  if (head) return head.replace(/^origin\//, "");
  return (await run("branch", "--show-current")) ?? "main";
}

export function startServer(
  cfg: { port: number; dataDir: string; token: string },
  db: Database,
  ptys: PtyManager,
) {
  const staticRoot = join(import.meta.dir, "../../../web/dist");

  const server = Bun.serve<{ subs: Map<string, () => void> }>({
    hostname: "127.0.0.1",
    port: cfg.port,
    websocket: wsHandlers(ptys),
    async fetch(req, srv) {
      const url = new URL(req.url);
      const authed = url.searchParams.get("t") === cfg.token || req.headers.get("x-codegent-token") === cfg.token;

      if (url.pathname === "/ws") {
        if (!authed) return new Response("unauthorized", { status: 401 });
        return srv.upgrade(req) ? undefined as any : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname.startsWith("/api/")) {
        if (!authed) return json({ error: "unauthorized" }, 401);
        const body = req.method === "POST" || req.method === "PATCH" ? await req.json().catch(() => ({})) : {};
        const m = (re: RegExp) => url.pathname.match(re);
        let x: RegExpMatchArray | null;

        if (url.pathname === "/api/projects" && req.method === "GET") return json(listProjects(db));
        if (url.pathname === "/api/projects" && req.method === "POST") {
          if (!body.skipGitCheck) {
            const p = Bun.spawn({ cmd: ["git", "rev-parse", "--git-dir"], cwd: body.path, stdout: "pipe", stderr: "pipe" });
            if ((await p.exited) !== 0) return json({ error: "not a git repository" }, 400);
          }
          const baseBranch = body.baseBranch ?? (await resolveBaseBranch(body.path));
          const project = createProject(db, { name: body.name, path: body.path, baseBranch });
          events.emit({ t: "project", project });
          return json(project, 201);
        }
        if ((x = m(/^\/api\/projects\/([^/]+)\/cards$/)) && req.method === "GET") return json(listCards(db, x[1]));
        if ((x = m(/^\/api\/projects\/([^/]+)\/cards$/)) && req.method === "POST") {
          const card = createCard(db, { projectId: x[1], title: body.title, body: body.body ?? "", agent: body.agent ?? "none" });
          events.emit({ t: "card", card });
          return json(card, 201);
        }
        if ((x = m(/^\/api\/cards\/(\d+)$/)) && req.method === "PATCH") {
          const card = updateCard(db, Number(x[1]), body);
          events.emit({ t: "card", card });
          return json(card);
        }
        if ((x = m(/^\/api\/cards\/(\d+)$/)) && req.method === "DELETE") {
          deleteCard(db, Number(x[1]));
          events.emit({ t: "cardDeleted", id: Number(x[1]) });
          return json({ ok: true });
        }
        if ((x = m(/^\/api\/projects\/([^/]+)\/sessions$/)) && req.method === "GET") return json(ptys.list(x[1]));
        if ((x = m(/^\/api\/projects\/([^/]+)\/sessions$/)) && req.method === "POST") {
          const project = listProjects(db).find(p => p.id === x![1]);
          const meta = ptys.open({ projectId: x[1], cwd: body.cwd ?? project?.path ?? process.env.HOME ?? "/", title: body.title ?? "shell", worktreeId: body.worktreeId ?? null });
          return json(meta, 201);
        }
        if ((x = m(/^\/api\/sessions\/([^/]+)$/)) && req.method === "DELETE") { ptys.close(x[1]); return json({ ok: true }); }
        if ((x = m(/^\/api\/projects\/([^/]+)\/worktrees$/)) && req.method === "GET") return json(listWorktrees(db, x[1]));
        if ((x = m(/^\/api\/projects\/([^/]+)\/worktrees$/)) && req.method === "POST") {
          const project = listProjects(db).find(p => p.id === x![1]);
          if (!project) return json({ error: "project not found" }, 404);
          const wt = await createWorktree(db, project, { slugSource: body.name, base: body.base });
          return json(wt, 201);
        }
        return json({ error: "not found" }, 404);
      }
      // static
      const filePath = join(staticRoot, url.pathname === "/" ? "index.html" : url.pathname);
      if (existsSync(filePath)) return new Response(Bun.file(filePath));
      return json({ error: "ui not built — run bun run --cwd apps/web build, or use vite dev" }, 404);
    },
  });
  return { url: `http://127.0.0.1:${cfg.port}/`, stop: () => server.stop(true) };
}
```

`apps/daemon/src/index.ts`:
```ts
import { loadConfig } from "./config";
import { openDb } from "./store/db";
import { PtyManager } from "./pty/manager";
import { startServer } from "./http/server";
import { join } from "node:path";

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, "db.sqlite"));
const ptys = new PtyManager(db, cfg.dataDir);
const { url } = startServer(cfg, db, ptys);
console.log(`codegent daemon → ${url}?t=${cfg.token}`);
```

- [ ] **Step 4: Run — expect PASS** (`bun test apps/daemon/test/http.test.ts`), then full suite `bun test` — all green.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src apps/daemon/test/http.test.ts
git commit -m "feat: daemon http+ws server — rest api, terminal mux, static serving"
```

---

### Task 10: web scaffold — theme tokens + typed API client

**Files:**
- Create: `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/src/main.tsx`, `apps/web/src/theme.css`, `apps/web/src/api.ts`
- Test: `apps/web/src/test/envelope-roundtrip.test.ts`

**Interfaces:**
- Consumes: protocol package; daemon REST/WS shapes (Task 9).
- Produces:
  - `api.baseUrl` / `api.token` resolution: dev = `http://127.0.0.1:4666` + token from `localStorage.cgToken` (set once via `?t=` on first load — `main.tsx` strips it into localStorage); prod = same-origin.
  - `api.get<T>(path)`, `api.post<T>(path, body)`, `api.patch<T>(path, body)`, `api.del(path)`
  - `connectWs(onEvent: (e: DomainEvent) => void): CgSocket` where `CgSocket = { sub(sid, onData: (bytes: Uint8Array) => void): () => void; input(sid, bytes: Uint8Array): void; resize(sid, cols, rows): void; close(): void }`
  - CSS custom properties for every Nebula token, named `--bg --bg-deep --surface --surface-2 --border --hairline --text --text-2 --ctrl --meta --dim --violet --violet-2 --amber --amber-dim --red --green --git-green --git-red`.

- [ ] **Step 1: Failing test (pure logic only — WS frame handling)**

`apps/web/src/test/envelope-roundtrip.test.ts`:
```ts
import { test, expect } from "bun:test";
import { encodeEnvelope, decodeEnvelope } from "@codegent/protocol";
import { b64ToBytes, bytesToB64 } from "../api";

test("base64 helpers roundtrip", () => {
  const bytes = new TextEncoder().encode("türkçe çıktı ✓");
  expect(new TextDecoder().decode(b64ToBytes(bytesToB64(bytes)))).toBe("türkçe çıktı ✓");
});

test("term frame decodes to bytes", () => {
  const env = decodeEnvelope(encodeEnvelope({ ch: "term", sid: "s", data: bytesToB64(new Uint8Array([1, 2, 3])) }));
  if (env.ch !== "term") throw new Error("wrong ch");
  expect([...b64ToBytes(env.data)]).toEqual([1, 2, 3]);
});
```

- [ ] **Step 2: Run — expect FAIL** (`bun test apps/web`)

- [ ] **Step 3: Implement scaffold**

`apps/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>codegent</title>
  </head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

`apps/web/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()], server: { port: 5666 } });
```

`apps/web/src/theme.css`:
```css
:root {
  --bg:#0d1117; --bg-deep:#010409; --surface:#161b22; --surface-2:#21262d;
  --border:#30363d; --hairline:#1c2128;
  --text:#e6edf3; --text-2:#adbac7; --ctrl:#9aa4b2; --meta:#7d8590; --dim:#57606a;
  --violet:#6d28d9; --violet-2:#8b5cf6;
  --amber:#e8c163; --amber-dim:#9d8b4a; --red:#ffa198; --green:#7ee2a8;
  --git-green:#3fb950; --git-red:#f85149;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 12px/1.5 -apple-system, "Segoe UI", sans-serif; }
.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
```

`apps/web/src/api.ts`:
```ts
import { encodeEnvelope, decodeEnvelope, type DomainEvent } from "@codegent/protocol";

export const bytesToB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
export const b64ToBytes = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

const isDev = typeof location !== "undefined" && location.port === "5666";
export const baseUrl = isDev ? "http://127.0.0.1:4666" : "";
export const token = () => (typeof localStorage !== "undefined" ? localStorage.getItem("cgToken") ?? "" : "");

const H = () => ({ "x-codegent-token": token(), "content-type": "application/json" });
export const api = {
  get: async <T>(p: string): Promise<T> => (await fetch(baseUrl + p, { headers: H() })).json(),
  post: async <T>(p: string, body: unknown): Promise<T> => (await fetch(baseUrl + p, { method: "POST", headers: H(), body: JSON.stringify(body) })).json(),
  patch: async <T>(p: string, body: unknown): Promise<T> => (await fetch(baseUrl + p, { method: "PATCH", headers: H(), body: JSON.stringify(body) })).json(),
  del: async (p: string): Promise<void> => { await fetch(baseUrl + p, { method: "DELETE", headers: H() }); },
};

export type CgSocket = {
  sub(sid: string, onData: (bytes: Uint8Array) => void): () => void;
  input(sid: string, bytes: Uint8Array): void;
  resize(sid: string, cols: number, rows: number): void;
  close(): void;
};

export function connectWs(onEvent: (e: DomainEvent) => void): CgSocket {
  const ws = new WebSocket(`${baseUrl.replace("http", "ws") || `ws://${location.host}`}/ws?t=${token()}`);
  const handlers = new Map<string, (b: Uint8Array) => void>();
  const queue: string[] = [];
  const send = (s: string) => (ws.readyState === WebSocket.OPEN ? ws.send(s) : queue.push(s));
  ws.onopen = () => queue.splice(0).forEach(s => ws.send(s));
  ws.onmessage = m => {
    const env = decodeEnvelope(String(m.data));
    if (env.ch === "event") onEvent(env.ev);
    else if (env.ch === "term") handlers.get(env.sid)?.(b64ToBytes(env.data));
  };
  return {
    sub(sid, onData) {
      handlers.set(sid, onData);
      send(encodeEnvelope({ ch: "sub", sid }));
      return () => { handlers.delete(sid); send(encodeEnvelope({ ch: "unsub", sid })); };
    },
    input: (sid, bytes) => send(encodeEnvelope({ ch: "input", sid, data: bytesToB64(bytes) })),
    resize: (sid, cols, rows) => send(encodeEnvelope({ ch: "resize", sid, cols, rows })),
    close: () => ws.close(),
  };
}
```

`apps/web/src/main.tsx`:
```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./theme.css";
import { Shell } from "./components/Shell";

const t = new URLSearchParams(location.search).get("t");
if (t) { localStorage.setItem("cgToken", t); history.replaceState(null, "", location.pathname); }

const qc = new QueryClient();
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={qc}><Shell /></QueryClientProvider>
);
```

(Also create a placeholder `apps/web/src/components/Shell.tsx` exporting `export const Shell = () => <div style={{ padding: 20 }}>codegent</div>;` so the app builds — Task 11 replaces it.)

- [ ] **Step 4: Run tests + dev smoke**

Run: `bun test apps/web` → 2 pass. Then `bun run dev:daemon` in one shell, `bun run dev:web` in another; open `http://localhost:5666/?t=<token-from-daemon-log>`; expect the placeholder to render with the dark theme.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat: web scaffold — nebula tokens, typed api client, ws client"
```

---

### Task 11: app shell — sidebar, topbar, views, keyboard

**Files:**
- Create: `apps/web/src/components/Sidebar.tsx`, `apps/web/src/keys.ts`, `apps/web/src/components/Palette.tsx`
- Modify: `apps/web/src/components/Shell.tsx`

**Interfaces:**
- Consumes: `api`, `connectWs`, protocol types.
- Produces:
  - `Shell` owns global state: `activeProject: string | null`, `view: "board"|"terminal"|"diff"`, one `CgSocket` created once, and a `useEvents` bridge that invalidates TanStack Query caches on DomainEvents (`["cards", projectId]`, `["sessions", projectId]`, `["projects"]`).
  - Context exported from Shell: `export const AppCtx = createContext<{ projectId: string; view: View; setView: (v: View) => void; socket: CgSocket }>` — Board/TerminalView consume this.
  - Keyboard: `1/2/3` switch views, `K` opens palette, `Esc` closes overlays (ignored when target is INPUT/TEXTAREA or the terminal has focus).

- [ ] **Step 1: Implement Shell (UI task — verification is visual; logic kept in testable helpers)**

`apps/web/src/keys.ts`:
```ts
export function bindKeys(map: Record<string, () => void>): () => void {
  const h = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.closest("[data-term]")) return;
    const fn = map[e.key.toLowerCase()];
    if (fn) { e.preventDefault(); fn(); }
  };
  window.addEventListener("keydown", h);
  return () => window.removeEventListener("keydown", h);
}
```

`apps/web/src/components/Shell.tsx`:
```tsx
import React, { createContext, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@codegent/protocol";
import { api, connectWs, type CgSocket } from "../api";
import { bindKeys } from "../keys";
import { Sidebar } from "./Sidebar";
import { Board } from "./Board";
import { TerminalView } from "./TerminalView";
import { Palette } from "./Palette";

export type View = "board" | "terminal" | "diff";
export const AppCtx = createContext<{ projectId: string; view: View; setView: (v: View) => void; socket: CgSocket }>(null as any);

export function Shell() {
  const qc = useQueryClient();
  const [view, setView] = useState<View>("board");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const socket = useMemo(() => connectWs(ev => {
    if (ev.t === "card" || ev.t === "cardDeleted") qc.invalidateQueries({ queryKey: ["cards"] });
    if (ev.t === "session") qc.invalidateQueries({ queryKey: ["sessions"] });
    if (ev.t === "project") qc.invalidateQueries({ queryKey: ["projects"] });
  }), []);

  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  useEffect(() => {
    if (!projectId && projects.data?.length) setProjectId(projects.data[0].id);
  }, [projects.data, projectId]);

  useEffect(() => bindKeys({
    "1": () => setView("board"), "2": () => setView("terminal"), "3": () => setView("diff"),
    k: () => setPaletteOpen(true), escape: () => setPaletteOpen(false),
  }), []);

  const active = projects.data?.find(p => p.id === projectId);
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <Sidebar projects={projects.data ?? []} activeId={projectId} onSelect={setProjectId} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 14px", borderBottom: "1px solid var(--surface-2)", background: "var(--bg-deep)" }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{active?.name ?? "—"}</span>
          <div style={{ display: "flex", gap: 2, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 2 }}>
            {(["board", "terminal", "diff"] as View[]).map((v, i) => (
              <span key={v} onClick={() => setView(v)}
                style={{ padding: "5px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12,
                  background: view === v ? "var(--violet)" : "transparent",
                  color: view === v ? "#fff" : "var(--ctrl)", fontWeight: view === v ? 500 : 400 }}>
                {v[0].toUpperCase() + v.slice(1)} <b style={{ opacity: .55, fontWeight: 400 }}>{i + 1}</b>
              </span>
            ))}
          </div>
          <span onClick={() => setPaletteOpen(true)}
            style={{ marginLeft: "auto", fontSize: 11, color: "var(--ctrl)", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 11px", cursor: "pointer" }}>
            K palette
          </span>
        </div>
        {active && projectId ? (
          <AppCtx.Provider value={{ projectId, view, setView, socket }}>
            {view === "board" && <Board />}
            {view === "terminal" && <TerminalView project={active} />}
            {view === "diff" && <div style={{ display: "grid", placeItems: "center", flex: 1, color: "var(--dim)" }}>nothing to review</div>}
          </AppCtx.Provider>
        ) : (
          <AddFirstProject onDone={id => setProjectId(id)} />
        )}
      </div>
      {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} onJump={(pid, v) => { setProjectId(pid); setView(v); setPaletteOpen(false); }} />}
    </div>
  );
}

function AddFirstProject({ onDone }: { onDone: (id: string) => void }) {
  const [path, setPath] = useState("");
  const [err, setErr] = useState("");
  return (
    <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
      <div style={{ width: 420 }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>Add a project</div>
        <input value={path} onChange={e => setPath(e.target.value)} placeholder="/absolute/path/to/git/repo"
          onKeyDown={async e => {
            if (e.key !== "Enter") return;
            const name = path.replace(/\/+$/, "").split("/").pop() || "project";
            const r: any = await api.post("/api/projects", { name, path });
            if (r.error) setErr(r.error); else onDone(r.id);
          }}
          style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", padding: "8px 10px", fontSize: 12, outline: "none" }} />
        {err && <div style={{ color: "var(--red)", fontSize: 11, marginTop: 6 }}>{err}</div>}
      </div>
    </div>
  );
}
```

`apps/web/src/components/Sidebar.tsx`:
```tsx
import React from "react";
import type { Project } from "@codegent/protocol";

export function Sidebar({ projects, activeId, onSelect }: {
  projects: Project[]; activeId: string | null; onSelect: (id: string) => void;
}) {
  return (
    <div style={{ width: 228, background: "var(--bg-deep)", borderRight: "1px solid var(--surface-2)", padding: "14px 10px", display: "flex", flexDirection: "column" }}>
      <div style={{ fontSize: 15, fontWeight: 650, padding: "0 8px 16px" }}>
        code<span style={{ background: "linear-gradient(90deg,var(--violet-2),#22d3ee)", WebkitBackgroundClip: "text", color: "transparent" }}>gent</span>
      </div>
      <div style={{ fontSize: 10, fontWeight: 650, letterSpacing: ".8px", color: "var(--dim)", padding: "0 8px 8px" }}>PROJECTS</div>
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
```

`apps/web/src/components/Palette.tsx`:
```tsx
import React from "react";
import { useQuery } from "@tanstack/react-query";
import type { Project } from "@codegent/protocol";
import { api } from "../api";
import type { View } from "./Shell";

export function Palette({ onClose, onJump }: { onClose: () => void; onJump: (projectId: string, view: View) => void }) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, background: "rgba(1,4,9,.7)", display: "flex", justifyContent: "center", paddingTop: 60, zIndex: 50 }}>
      <div style={{ width: 540, maxHeight: 380, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, overflow: "auto", padding: 8, alignSelf: "flex-start" }}>
        <div style={{ fontSize: 10, fontWeight: 650, letterSpacing: ".8px", color: "var(--dim)", padding: "6px 8px" }}>PROJECTS</div>
        {(projects.data ?? []).map(p => (
          <div key={p.id} onClick={() => onJump(p.id, "board")}
            style={{ padding: "8px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12 }}
            onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
            {p.name}
          </div>
        ))}
      </div>
    </div>
  );
}
```

(Temporarily create `apps/web/src/components/Board.tsx` and `apps/web/src/components/TerminalView.tsx` as stubs — `export const Board = () => <div/>` / `export const TerminalView = (_: any) => <div/>` — Tasks 12–13 replace them. This keeps the app compiling at every commit.)

- [ ] **Step 2: Verify visually**

Run both dev servers; open with token. Expected: sidebar with logo + PROJECTS; empty state shows "Add a project"; after adding a real repo path, topbar shows Board/Terminal/Diff segment; `1/2/3` switch views; `K` opens palette; Esc closes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src
git commit -m "feat: app shell — sidebar, view switcher, palette, keyboard map"
```

---

### Task 12: Board view (manual mode)

**Files:**
- Create: `apps/web/src/components/Card.tsx`
- Modify: `apps/web/src/components/Board.tsx`

**Interfaces:**
- Consumes: `AppCtx` (projectId), `api`, `Card` type.
- Produces: manual kanban per Global Constraints — five fixed columns, "+ task" ghost row opening an inline composer (title input + agent select; Enter → POST, lands in Queue), card face = title + agent tag + hover ⋯ menu (edit inline / delete / move-to submenu with the 5 phases). No drag-and-drop in v0.1 (moves via ⋯ menu; DnD arrives with orchestration rules in Plan 2).

- [ ] **Step 1: Implement**

`apps/web/src/components/Board.tsx`:
```tsx
import React, { useContext, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Card as CardT, CardPhase } from "@codegent/protocol";
import { api } from "../api";
import { AppCtx } from "./Shell";
import { CardView } from "./Card";

const COLUMNS: { phase: CardPhase; label: string }[] = [
  { phase: "queued", label: "QUEUE" }, { phase: "running", label: "RUNNING" },
  { phase: "waiting", label: "WAITING FOR INPUT" }, { phase: "review", label: "IN REVIEW" },
  { phase: "done", label: "DONE" },
];

export function Board() {
  const { projectId } = useContext(AppCtx);
  const qc = useQueryClient();
  const cards = useQuery({ queryKey: ["cards", projectId], queryFn: () => api.get<CardT[]>(`/api/projects/${projectId}/cards`) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["cards", projectId] });
  const create = useMutation({
    mutationFn: (v: { title: string; agent: CardT["agent"] }) => api.post<CardT>(`/api/projects/${projectId}/cards`, { ...v, body: "" }),
    onSuccess: invalidate,
  });

  return (
    <div style={{ display: "flex", gap: 12, padding: 16, alignItems: "flex-start", overflow: "auto", flex: 1 }}>
      {COLUMNS.map(col => {
        const list = (cards.data ?? []).filter(c => c.phase === col.phase);
        return (
          <div key={col.phase} style={{ flex: 1, minWidth: 180 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, fontWeight: 650, letterSpacing: ".8px", color: "var(--dim)", marginBottom: 10 }}>
              {col.label}
              <span style={{ background: "var(--surface-2)", borderRadius: 999, padding: "0 7px", fontSize: 9.5, color: "var(--meta)" }}>{list.length}</span>
            </div>
            {list.map(c => <CardView key={c.id} card={c} onChanged={invalidate} />)}
            {col.phase === "queued" && <Composer onCreate={(title, agent) => create.mutate({ title, agent })} />}
          </div>
        );
      })}
    </div>
  );
}

function Composer({ onCreate }: { onCreate: (title: string, agent: CardT["agent"]) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [agent, setAgent] = useState<CardT["agent"]>("claude");
  if (!open) return (
    <div onClick={() => setOpen(true)}
      style={{ border: "1px dashed var(--border)", borderRadius: 8, color: "var(--dim)", fontSize: 11, textAlign: "center", padding: 7, cursor: "pointer" }}>
      + task
    </div>
  );
  return (
    <div style={{ border: "1px dashed var(--border)", borderRadius: 8, padding: "10px 12px" }}>
      <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="What should be done?"
        onKeyDown={e => {
          if (e.key === "Enter" && title.trim()) { onCreate(title.trim(), agent); setTitle(""); setOpen(false); }
          if (e.key === "Escape") setOpen(false);
        }}
        style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 11, padding: "7px 10px", outline: "none" }} />
      <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
        {(["claude", "codex", "none"] as const).map(a => (
          <span key={a} onClick={() => setAgent(a)}
            style={{ fontSize: 10, padding: "4px 9px", borderRadius: 6, cursor: "pointer",
              border: `1px solid ${agent === a ? "var(--violet-2)" : "var(--border)"}`,
              color: agent === a ? "#c4b5fd" : "var(--ctrl)" }}>{a}</span>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--dim)" }}>Enter → Queue</span>
      </div>
    </div>
  );
}
```

`apps/web/src/components/Card.tsx`:
```tsx
import React, { useState } from "react";
import type { Card, CardPhase } from "@codegent/protocol";
import { api } from "../api";

const PHASES: CardPhase[] = ["queued", "running", "waiting", "review", "done", "cancelled"];

export function CardView({ card, onChanged }: { card: Card; onChanged: () => void }) {
  const [menu, setMenu] = useState(false);
  const move = async (phase: CardPhase) => { await api.patch(`/api/cards/${card.id}`, { phase }); setMenu(false); onChanged(); };
  const del = async () => { await api.del(`/api/cards/${card.id}`); onChanged(); };
  return (
    <div style={{ position: "relative", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", marginBottom: 8 }}
      onMouseLeave={() => setMenu(false)}>
      <div style={{ fontSize: 12, fontWeight: 500, opacity: card.phase === "done" ? .55 : 1, textDecoration: card.phase === "done" ? "line-through" : "none" }}>{card.title}</div>
      <div style={{ display: "flex", gap: 5, marginTop: 6 }}>
        {card.agent !== "none" && (
          <span style={{ fontSize: 9.5, borderRadius: 6, padding: "1px 8px",
            border: "1px solid rgba(139,92,246,.28)", background: "rgba(139,92,246,.09)", color: "#c4b5fd" }}>{card.agent}</span>
        )}
      </div>
      <span onClick={() => setMenu(m => !m)}
        style={{ position: "absolute", top: 8, right: 10, cursor: "pointer", color: "var(--dim)" }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
      </span>
      {menu && (
        <div style={{ position: "absolute", top: 24, right: 8, zIndex: 10, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 6, minWidth: 140, boxShadow: "0 10px 30px rgba(0,0,0,.5)" }}>
          {PHASES.filter(p => p !== card.phase).map(p => (
            <div key={p} onClick={() => move(p)} style={{ padding: "6px 8px", borderRadius: 6, fontSize: 11, cursor: "pointer", color: "var(--text-2)" }}
              onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              move → {p}
            </div>
          ))}
          <div onClick={del} style={{ padding: "6px 8px", borderRadius: 6, fontSize: 11, cursor: "pointer", color: "var(--red)", borderTop: "1px solid var(--hairline)", marginTop: 4 }}>delete</div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify visually**

Both dev servers up. Expected: five columns render; "+ task" opens composer; Enter creates card in Queue (appears without refresh — WS event → query invalidation); ⋯ menu moves cards between all columns; delete removes. Open a second browser tab: changes in one tab appear in the other within ~1s (event bus proof).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/Board.tsx apps/web/src/components/Card.tsx
git commit -m "feat: manual-mode kanban board — five columns, composer, card moves"
```

---

### Task 13: Terminal view — rail + ghostty panes

**Files:**
- Create: `apps/web/src/components/GhosttyTerm.tsx`, `apps/web/src/components/SessionRail.tsx`
- Modify: `apps/web/src/components/TerminalView.tsx`

**Interfaces:**
- Consumes: `AppCtx.socket` (`sub/input/resize`), sessions REST, worktrees REST, ghostty-web API as recorded in `docs/research/ghostty-web-spike.md` (Task 3) — **adjust the import/constructor lines below to the recorded real API**.
- Produces: Terminal view per spec §7.4 v0.1 slice — flat session rail (title + meta, filled = focused), up to 2 panes side by side (click focuses; unfocused pane at 75% opacity), "+ terminal · main" with picker (main / existing worktrees / "in a new worktree…" name + base), reattach replays ring (server sends snapshot first — Task 9 already guarantees ordering).

- [ ] **Step 1: Implement the engine wrapper**

`apps/web/src/components/GhosttyTerm.tsx`:
```tsx
import React, { useContext, useEffect, useRef } from "react";
import { Terminal } from "ghostty-web"; // ← local source build (vendor/ghostty-web); exact API per docs/research/ghostty-web-spike.md
import { AppCtx } from "./Shell";

export function GhosttyTerm({ sid, focused, onFocus }: { sid: string; focused: boolean; onFocus: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { socket } = useContext(AppCtx);

  useEffect(() => {
    const el = ref.current!;
    const term = new Terminal({ cols: 100, rows: 30 });
    term.open(el);
    const offData = socket.sub(sid, bytes => term.write(bytes));
    const offInput = term.onData?.((data: string) => socket.input(sid, new TextEncoder().encode(data)));
    const ro = new ResizeObserver(() => {
      const cols = Math.max(20, Math.floor(el.clientWidth / 8));
      const rows = Math.max(5, Math.floor(el.clientHeight / 17));
      term.resize?.(cols, rows);
      socket.resize(sid, cols, rows);
    });
    ro.observe(el);
    return () => { offData(); offInput?.(); ro.disconnect(); term.dispose?.(); };
  }, [sid]);

  return (
    <div data-term ref={ref} onMouseDown={onFocus}
      style={{ flex: 1, minWidth: 0, opacity: focused ? 1 : .75, transition: "opacity .2s", background: "var(--bg)" }} />
  );
}
```

- [ ] **Step 2: Implement rail + view**

`apps/web/src/components/SessionRail.tsx`:
```tsx
import React, { useState } from "react";
import type { SessionMeta, Worktree } from "@codegent/protocol";

export function SessionRail({ sessions, worktrees, openIds, focusedId, onPick, onNew }: {
  sessions: SessionMeta[]; worktrees: Worktree[]; openIds: string[]; focusedId: string | null;
  onPick: (id: string) => void;
  onNew: (target: { kind: "main" } | { kind: "worktree"; id: string } | { kind: "new"; name: string; base?: string }) => void;
}) {
  const [picker, setPicker] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);
  return (
    <div style={{ width: 216, borderRight: "1px solid var(--surface-2)", background: "var(--bg-deep)", padding: 10, display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ fontSize: 10, fontWeight: 650, letterSpacing: ".8px", color: "var(--dim)", margin: "4px 0 8px" }}>SESSIONS</div>
      {sessions.filter(s => s.live).map(s => (
        <div key={s.id} onClick={() => onPick(s.id)}
          style={{ display: "flex", gap: 9, padding: "7px 9px", borderRadius: 8, cursor: "pointer",
            background: s.id === focusedId ? "var(--surface)" : "transparent",
            border: `1px solid ${s.id === focusedId ? "var(--border)" : "transparent"}` }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: s.worktreeId ? "#38bdf8" : "#6b7280", marginTop: 4, flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: s.id === focusedId ? "var(--text)" : "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
            <div style={{ fontSize: 10, color: "var(--dim)" }}>{openIds.includes(s.id) ? "on screen" : "shell"}</div>
          </div>
        </div>
      ))}
      <div style={{ position: "relative", marginTop: 6 }}>
        <div onClick={() => setPicker(p => !p)}
          style={{ display: "flex", justifyContent: "center", gap: 5, border: "1px dashed var(--border)", borderRadius: 8, color: "var(--dim)", fontSize: 11, padding: "7px 9px", cursor: "pointer" }}>
          + terminal · main
        </div>
        {picker && (
          <div style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, right: 0, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 6, zIndex: 30 }}>
            <div style={{ fontSize: 10, fontWeight: 650, color: "var(--dim)", padding: "4px 8px 6px", letterSpacing: ".6px" }}>OPEN WHERE?</div>
            <PickRow label="main" hint="default" onClick={() => { onNew({ kind: "main" }); setPicker(false); }} />
            {worktrees.filter(w => w.state === "active").map(w => (
              <PickRow key={w.id} label={w.branch} onClick={() => { onNew({ kind: "worktree", id: w.id }); setPicker(false); }} />
            ))}
            <div style={{ borderTop: "1px solid var(--surface-2)", margin: "5px 4px" }} />
            {newName === null
              ? <PickRow label="in a new worktree…" onClick={() => setNewName("")} />
              : <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
                  placeholder="branch name — e.g. spike"
                  onKeyDown={e => {
                    if (e.key === "Enter" && newName.trim()) { onNew({ kind: "new", name: newName.trim() }); setNewName(null); setPicker(false); }
                    if (e.key === "Escape") setNewName(null);
                  }}
                  style={{ width: "100%", boxSizing: "border-box", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 11, padding: "6px 8px", outline: "none", marginTop: 4 }} />}
          </div>
        )}
      </div>
    </div>
  );
}

function PickRow({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) {
  return (
    <div onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, fontSize: 11, color: "var(--text-2)", cursor: "pointer" }}
      onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
      {label}{hint && <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--dim)" }}>{hint}</span>}
    </div>
  );
}
```

`apps/web/src/components/TerminalView.tsx`:
```tsx
import React, { useContext, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, SessionMeta, Worktree } from "@codegent/protocol";
import { api } from "../api";
import { AppCtx } from "./Shell";
import { SessionRail } from "./SessionRail";
import { GhosttyTerm } from "./GhosttyTerm";

export function TerminalView({ project }: { project: Project }) {
  const { projectId } = useContext(AppCtx);
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["sessions", projectId], queryFn: () => api.get<SessionMeta[]>(`/api/projects/${projectId}/sessions`) });
  const worktrees = useQuery({ queryKey: ["worktrees", projectId], queryFn: () => api.get<Worktree[]>(`/api/projects/${projectId}/worktrees`) });
  const [open, setOpen] = useState<string[]>([]);       // ≤2 pane sids
  const [focused, setFocused] = useState<string | null>(null);

  const show = (id: string) => {
    setOpen(prev => prev.includes(id) ? prev : prev.length < 2 ? [...prev, id] : [prev[1], id]);
    setFocused(id);
  };

  const openNew = async (t: { kind: "main" } | { kind: "worktree"; id: string } | { kind: "new"; name: string; base?: string }) => {
    let cwd = project.path, worktreeId: string | null = null, title = "main";
    if (t.kind === "worktree") {
      const w = worktrees.data!.find(w => w.id === t.id)!;
      cwd = w.path; worktreeId = w.id; title = w.branch;
    } else if (t.kind === "new") {
      const w = await api.post<Worktree>(`/api/projects/${projectId}/worktrees`, { name: t.name, base: t.base });
      qc.invalidateQueries({ queryKey: ["worktrees", projectId] });
      cwd = w.path; worktreeId = w.id; title = w.branch;
    }
    const meta = await api.post<SessionMeta>(`/api/projects/${projectId}/sessions`, { cwd, worktreeId, title });
    qc.invalidateQueries({ queryKey: ["sessions", projectId] });
    show(meta.id);
  };

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <SessionRail sessions={sessions.data ?? []} worktrees={worktrees.data ?? []}
        openIds={open} focusedId={focused} onPick={show} onNew={openNew} />
      <div style={{ flex: 1, display: "flex", minWidth: 0 }}>
        {open.length === 0 && (
          <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--dim)", fontSize: 12 }}>
            pick a session — or press “+ terminal · main”
          </div>
        )}
        {open.map((sid, i) => (
          <React.Fragment key={sid}>
            {i > 0 && <div style={{ width: 3, cursor: "col-resize", background: "var(--surface-2)" }} />}
            <GhosttyTerm sid={sid} focused={focused === sid} onFocus={() => setFocused(sid)} />
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify visually (the core demo!)**

Both dev servers up, real repo added as project. Expected: "+ terminal · main" opens a live shell — typing works, colors render; `ls` output correct. Open a worktree via "in a new worktree… → spike" — new branch `wt/spike` appears, shell lands inside it (`git branch --show-current` prints `wt/spike`). Open two panes: unfocused dims to 75%, click switches focus. Reload the page, re-pick the session: scrollback replays (ring proof). Kill the daemon and restart it: session rows show non-live (rail hides them), no crash.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components
git commit -m "feat: terminal view — session rail, ghostty panes, worktree picker, ring replay"
```

---

### Task 14: CI pipeline + dev quickstart

**Files:**
- Create: `.buildkite/pipeline.yml`, `README.md`

**Interfaces:**
- Consumes: the full test suite.
- Produces: green pipeline on Linux + macOS agents; README that lets a stranger run the dev environment in 3 commands.

- [ ] **Step 1: Pipeline**

`.buildkite/pipeline.yml`:
```yaml
steps:
  - label: ":linux: test"
    key: linux
    agents: { os: linux }
    command: |
      bun install --frozen-lockfile
      bun test
  - label: ":mac: test"
    key: mac
    agents: { os: macos }
    command: |
      bun install --frozen-lockfile
      bun test
```

- [ ] **Step 2: README (dev section only — product README is a Plan 4 deliverable)**

`README.md`:
```markdown
# codegent

Browser-based AI coding-agent orchestrator. Pre-release — v0.1 core.

## Develop

```sh
bun install
bun run dev:daemon   # prints http://127.0.0.1:4666/?t=<token>
bun run dev:web      # http://localhost:5666 — open it with ?t=<token>
```

Tests: `bun test` · License: AGPL-3.0
```

- [ ] **Step 3: Full-suite check**

Run: `bun test`
Expected: every test from Tasks 2–10 passes.

- [ ] **Step 4: Commit**

```bash
git add .buildkite README.md
git commit -m "chore: buildkite pipeline and dev quickstart"
```

---

## Self-Review (performed at write time)

1. **Spec coverage (v0.1 milestone only):** daemon SQLite ✓(T5) · PTY+ring 200KB+replay ✓(T6,T9,T13) · worktree manager `cg/<id>-<slug>` + scratch `wt/<slug>` + archive ✓(T8) · localhost token auth ✓(T9) · port 4666 auto-increment ✓(T9) · manual board, five fixed columns, composer "Enter → Queue" ✓(T12) · sessions rail + panes + dim-unfocused + "+ terminal" picker incl. new-worktree(name+base UI: base field arrives with the picker's base chip in Plan 3 polish; API already accepts `base`) ✓(T13) · Nebula tokens/ladder ✓(T10, Global Constraints) · spikes with hard gates + `docs/research/` ✓(T2,T3) · Buildkite ✓(T14). Deliberately out (later plans): orchestrator/truth table, adapters, ACP, relay/pairing, diff view, review queue, plugins, installer/npx, Settings/first-run, notifications, strip/attention surfaces, sandbox modes, drag-and-drop.
2. **Placeholder scan:** the two engine-API notes in T2/T13 are explicit adapt-to-recorded-API instructions tied to spike findings docs, not TBDs; no other placeholders found.
3. **Type consistency:** `PtySession.onData/write/resize/kill/snapshot` used identically in T6/T7/T9; `Envelope` channels `sub/term/input/resize/event` consistent across T4/T9/T10/T13; `SessionMeta.live` flows T7→T9→T13; `createWorktree(slugSource)` naming consistent T8/T9(T13 via REST).

## Execution note for workers

Tasks 2 and 3 are HARD GATES: if either fails its criteria, stop and escalate with the findings doc — Tasks 6/13 depend on their recorded APIs. Task 11's stubs keep every commit compiling. All commits: plain conventional messages, never any attribution trailer.
