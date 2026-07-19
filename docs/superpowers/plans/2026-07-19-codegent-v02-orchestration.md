# codegent v0.2 — Orchestrator + Agent Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board drives real agents end-to-end: card → auto-start in a worktree PTY → live Claude Code/Codex TUI → input flags from verified hooks → `task_complete` gates review → merge archives the worktree and pulls the next card.

**Architecture:** A pure card state machine (spec §4.1) consumed by an orchestrator engine (R1-R4) in the daemon. Adapters translate live-verified hook events (docs/research/cc-codex-hook-contract.md) into state-machine events; a loopback hook receiver + an MCP sidecar carry the signals. The web app gains reconnect, orchestration badges, and recovery actions. Spec §6.1 governs every detection/completion decision; the research docs are the implementation reference.

**Tech Stack:** Bun ≥1.3.14 + TypeScript 7 monorepo (existing packages/protocol, apps/daemon, apps/web). No new heavyweight deps: `@modelcontextprotocol/sdk` (latest stable) for the MCP sidecar is the only planned addition.

## Global Constraints

- Resolve every dependency at latest stable at execution time (spec rule). Bun on this machine is 1.3.14; TypeScript 7.0.2 at root.
- ghostty-web ONLY; never touch `vendor/ghostty-web`; no xterm.js in first-party code.
- Daemon port 4666 (auto-increment); RING_CAP 200KB; worktrees under `<repo>/.codegent/worktrees/`; managed branches `cg/<cardId>-<slug>`, scratch `wt/<slug>`.
- **Terminal content never reaches the UI** (spec principle 1): no question previews, no error text, no exit codes. State enums + timestamps only. The one sanctioned echo is `task_complete`'s dirty-worktree rejection, which goes into the *agent's own conversation* (MCP tool error), never our UI.
- **Spec §6.1 governs**: "done" is declared, never inferred (I1); ambiguity degrades to attention (I2); unknown → idle, never blocked; byte-quiescence is banned as a primary signal. When a task here conflicts with §6.1, §6.1 wins — stop and flag it.
- **Hook truth is pinned**: docs/research/cc-codex-hook-contract.md (live-verified 2026-07-19, CC 2.1.215 / Codex 0.144.6). CC hooks: SessionStart, PermissionRequest, PreToolUse(AskUserQuestion), PostToolUse(AskUserQuestion), Stop, StopFailure — `Notification` is NOT used (verified redundant). Adjust any code below to the recorded payload shapes; the doc wins over this plan's sketches.
- **Env hygiene (hard rule):** agent PTYs get `CLAUDE*` vars scrubbed from the inherited env (a leaked `CLAUDE_CODE_CHILD_SESSION` breaks `--resume` + transcripts). Codex runs against an isolated managed `CODEX_HOME` mirror — the user's `~/.codex` is never written.
- Orchestration numbers (adopted, spec §5/§6.1): worker limit default 1; heartbeat soft-warn >10 min; runaway notify >30 min; circuit breaker after 3 consecutive failed attempts; spawn timeout 30s; cancel = 5s grace → SIGHUP → 2s → SIGTERM → 2s → SIGKILL (process group); startup marks every `running` dispatch failed — nothing self-resumes.
- UI grammar: font sizes 9.5/10/11/12/13; weights 400/500 (650 caps-labels only); radii 6/8/999; `var(--…)` tokens; English copy; inline-SVG icons only; no emoji.
- Suite entry: bare `bun test` from root must stay green (bunfig scoping exists); `bun run typecheck` must stay exit 0 — both are part of every task's verification.
- Commits: plain conventional messages on the feature branch, **NO attribution trailers**, no AI/Claude mentions.
- Browser-verified UI tasks capture evidence PNG under `.superpowers/sdd/` (git-ignored).

## File Structure (new/modified)

```
packages/protocol/src/entities.ts        # v0.2 domain model (phases, flags, attempts, dispatches)
packages/protocol/src/events.ts          # NEW: domain event union (extracted from envelope users)
apps/daemon/src/store/{db,cards,attempts,dispatches}.ts   # migrations 2..n + new tables
apps/daemon/src/orchestrator/machine.ts  # NEW: pure card state machine
apps/daemon/src/orchestrator/engine.ts   # NEW: R1-R4 + envelope + timers
apps/daemon/src/agents/receiver.ts       # NEW: loopback hook receiver + endpoint file
apps/daemon/src/agents/mcp.ts            # NEW: MCP sidecar entry (task_get/progress/complete)
apps/daemon/src/agents/claude.ts         # NEW: CC adapter (settings gen, spawn, normalize)
apps/daemon/src/agents/codex.ts          # NEW: Codex adapter (CODEX_HOME mirror, normalize)
apps/daemon/src/pty/session.ts           # MOD: cmd argv support + env override + kill ladder
apps/daemon/src/pty/manager.ts           # MOD: agent sessions, insert-failure fix
apps/daemon/src/http/server.ts           # MOD: 404 consistency, action routes, reorder
apps/daemon/src/index.ts                 # MOD: boot reconciliation v2 + ring GC
apps/web/src/api.ts                      # MOD: WS reconnect + resubscribe
apps/web/src/components/{Board,Card}.tsx # MOD: badges, actions, derived Waiting
apps/web/src/components/Details.tsx      # NEW: details drawer (progress timeline)
.buildkite/pipeline.yml                  # MOD: nightly contract-test schedule
```

---

### Task 1: Protocol v0.2 — spec-true domain model

**Files:**
- Modify: `packages/protocol/src/entities.ts`
- Create: `packages/protocol/src/events.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/entities-v02.test.ts`

**Interfaces:**
- Consumes: existing zod v4 style (`z.int()`, enums) from v0.1.
- Produces (later tasks rely on these exact names): `CardPhase = queued|working|review|done|cancelled`; `WorkingSub = starting|running|stopped|error`; `ErrorKind = start_failed|crashed|interrupted`; `ReviewSub = ready|stale|conflict|updating|merging` (schema-reserved; v0.2 logic uses `ready` only); `InputKind = question|permission|silent`; `CardSchema` gains `workingSub`, `errorKind`, `reviewSub`, `inputKind`, `inputSince`, `round`, `auto`, `attemptId` (all nullable except `round` int ≥1 default 1, `auto` boolean default true); `AttemptSchema {id: int, cardId: int, worktreeId: string|null, seq: int, status: "running"|"succeeded"|"failed"|"discarded", beforeHead: string|null, createdAt: number}`; `DispatchSchema {id: string, attemptId: int, status: "running"|"done"|"failed"|"interrupted", lastProgressAt: number|null, createdAt: number}`; `SessionMetaSchema.kind` widens to `"shell"|"agent"` + optional `adapterSessionId: string|null`, `attemptId: int|null`; `DomainEvent` union in events.ts: `{t:"card", card: Card} | {t:"session", session: SessionMeta} | {t:"cardDeleted", id: number} | {t:"attempt", attempt: Attempt} | {t:"notice", cardId: number, kind: "heartbeat-quiet"|"runaway"}` (notice = soft-warning chips; carries NO text).
- **Migration note for implementer:** v0.1 stored phase `waiting` and `running`. v0.2 maps `running→working+workingSub:"running"`, `waiting→working+inputKind:"silent"` (conservative: we don't know which kind it was). Board's Waiting column becomes a projection: `phase==="working" && inputKind !== null`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/protocol/test/entities-v02.test.ts
import { describe, expect, test } from "bun:test";
import { CardSchema, AttemptSchema, DispatchSchema, SessionMetaSchema } from "../src/entities";
import { DomainEventSchema } from "../src/events";

const baseCard = {
  id: 1, projectId: "p1", title: "t", body: "", phase: "working", agent: "claude",
  worktreeId: "w1", position: 1, createdAt: 1, updatedAt: 1,
  workingSub: "running", errorKind: null, reviewSub: null,
  inputKind: null, inputSince: null, round: 1, auto: true, attemptId: 1,
};

describe("v0.2 entities", () => {
  test("card accepts spec-true shape", () => {
    expect(CardSchema.parse(baseCard).workingSub).toBe("running");
  });
  test("waiting is not a phase", () => {
    expect(() => CardSchema.parse({ ...baseCard, phase: "waiting" })).toThrow();
  });
  test("input flag kinds", () => {
    for (const k of ["question", "permission", "silent"])
      expect(CardSchema.parse({ ...baseCard, inputKind: k, inputSince: 5 }).inputKind).toBe(k);
    expect(() => CardSchema.parse({ ...baseCard, inputKind: "shout" })).toThrow();
  });
  test("attempt + dispatch schemas", () => {
    expect(AttemptSchema.parse({ id: 1, cardId: 1, worktreeId: "w", seq: 1, status: "running", beforeHead: "abc", createdAt: 1 }).seq).toBe(1);
    expect(DispatchSchema.parse({ id: "d1", attemptId: 1, status: "running", lastProgressAt: null, createdAt: 1 }).id).toBe("d1");
  });
  test("agent session meta", () => {
    const m = SessionMetaSchema.parse({
      id: "s", projectId: "p", kind: "agent", title: "t", cwd: "/x",
      worktreeId: null, live: true, createdAt: 1, adapterSessionId: "cc-123", attemptId: 1,
    });
    expect(m.kind).toBe("agent");
  });
  test("notice event carries no text payload", () => {
    const e = DomainEventSchema.parse({ t: "notice", cardId: 3, kind: "runaway" });
    expect("message" in e).toBe(false);
    expect(() => DomainEventSchema.parse({ t: "notice", cardId: 3, kind: "runaway", message: "boom" })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test packages/protocol/test/entities-v02.test.ts` → FAIL (missing exports).

- [ ] **Step 3: Implement**

```ts
// packages/protocol/src/entities.ts  (replace CardSchema/SessionMetaSchema blocks; keep Project/Worktree)
export const CardPhase = z.enum(["queued", "working", "review", "done", "cancelled"]);
export type CardPhase = z.infer<typeof CardPhase>;
export const WorkingSub = z.enum(["starting", "running", "stopped", "error"]);
export const ErrorKind = z.enum(["start_failed", "crashed", "interrupted"]);
export const ReviewSub = z.enum(["ready", "stale", "conflict", "updating", "merging"]);
export const InputKind = z.enum(["question", "permission", "silent"]);

export const CardSchema = z.object({
  id: z.int(), projectId: z.string(), title: z.string().min(1),
  body: z.string(), phase: CardPhase, agent: z.enum(["claude", "codex", "none"]),
  worktreeId: z.string().nullable(), position: z.number(),
  createdAt: z.number(), updatedAt: z.number(),
  workingSub: WorkingSub.nullable(), errorKind: ErrorKind.nullable(),
  reviewSub: ReviewSub.nullable(),
  inputKind: InputKind.nullable(), inputSince: z.number().nullable(),
  round: z.int().min(1), auto: z.boolean(), attemptId: z.int().nullable(),
});
export type Card = z.infer<typeof CardSchema>;

export const AttemptSchema = z.object({
  id: z.int(), cardId: z.int(), worktreeId: z.string().nullable(),
  seq: z.int().min(1), status: z.enum(["running", "succeeded", "failed", "discarded"]),
  beforeHead: z.string().nullable(), createdAt: z.number(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const DispatchSchema = z.object({
  id: z.string(), attemptId: z.int(),
  status: z.enum(["running", "done", "failed", "interrupted"]),
  lastProgressAt: z.number().nullable(), createdAt: z.number(),
});
export type Dispatch = z.infer<typeof DispatchSchema>;

export const SessionMetaSchema = z.object({
  id: z.string(), projectId: z.string(), kind: z.enum(["shell", "agent"]),
  title: z.string(), cwd: z.string(), worktreeId: z.string().nullable(),
  live: z.boolean(), createdAt: z.number(),
  adapterSessionId: z.string().nullable().optional(), attemptId: z.int().nullable().optional(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;
```

```ts
// packages/protocol/src/events.ts
import { z } from "zod";
import { CardSchema, SessionMetaSchema, AttemptSchema } from "./entities";

export const DomainEventSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("card"), card: CardSchema }).strict(),
  z.object({ t: z.literal("cardDeleted"), id: z.number() }).strict(),
  z.object({ t: z.literal("session"), session: SessionMetaSchema }).strict(),
  z.object({ t: z.literal("attempt"), attempt: AttemptSchema }).strict(),
  z.object({ t: z.literal("notice"), cardId: z.int(), kind: z.enum(["heartbeat-quiet", "runaway"]) }).strict(),
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;
```

`index.ts`: add `export * from "./events";`. **Reality check:** the daemon's `events.ts` bus and `ws.ts` envelope currently define their own event shapes — find them, replace their local types with `DomainEvent` imports, and make `ws.ts` validate against `DomainEventSchema`. Existing daemon/web code that compiled against v0.1 `Card` will now fail typecheck — DO NOT fix call sites in this task beyond mechanical field additions with the migration defaults (`workingSub: null` etc. at construction sites); the store task (T2) owns the real wiring. Keep the suite green by updating fixtures minimally.

- [ ] **Step 4: Run tests + typecheck** — `bun test` all green, `bun run typecheck` exit 0.
- [ ] **Step 5: Commit** — `feat: v0.2 domain model — spec-true phases, flags, attempts, dispatches`

---

### Task 2: Store v0.2 — migration + transition-safe writes

**Files:**
- Modify: `apps/daemon/src/store/db.ts`, `apps/daemon/src/store/cards.ts`, `apps/daemon/src/store/sessions.ts`
- Create: `apps/daemon/src/store/attempts.ts`
- Test: `apps/daemon/test/store-v02.test.ts`

**Interfaces:**
- Consumes: T1 types.
- Produces: migration 2 (idempotent, versioned like migration 1, **each migration wrapped in a transaction** — closes the Plan-1 ledger minor); `createAttempt(db, {cardId, worktreeId, beforeHead}) → Attempt` (seq = max+1); `createDispatch(db, attemptId) → Dispatch` (id = crypto.randomUUID()); `completeDispatch(db, dispatchId, status) → Dispatch | null` — **write-once latch**: `UPDATE dispatches SET status=?, … WHERE id=? AND status='running' RETURNING *`; returns null when already terminal (VK latch — callers treat null as "stale, ignore"); `touchDispatchProgress(db, dispatchId, ts)`; `updateCard` PATCHABLE extends with the new columns (camelCase↔snake mapping); `failRunningDispatches(db) → number` for boot.
- Migration 2 SQL: add card columns `working_sub, error_kind, review_sub, input_kind, input_since, round DEFAULT 1, auto DEFAULT 1, attempt_id`; data fix-up `UPDATE cards SET phase='working', working_sub='running' WHERE phase='running'; UPDATE cards SET phase='working', input_kind='silent', input_since=<now> WHERE phase='waiting';` create `attempts` and `dispatches` tables; sessions gain `kind TEXT DEFAULT 'shell'`, `adapter_session_id`, `attempt_id`.

- [ ] **Step 1: Failing tests** — cover: migration converts a seeded v0.1 `waiting` card to `working+silent`; attempt seq increments per card; `completeDispatch` returns the row once and null the second time (the latch), including a two-caller race simulated by calling twice; `failRunningDispatches` flips only `running` rows; updateCard round-trips the new fields.

```ts
// apps/daemon/test/store-v02.test.ts (core assertions; implementer writes the seeding helpers in-file)
test("completeDispatch is write-once", () => {
  const d = createDispatch(db, attempt.id);
  expect(completeDispatch(db, d.id, "done")?.status).toBe("done");
  expect(completeDispatch(db, d.id, "failed")).toBeNull();          // stale retry can't overwrite
});
test("v0.1 waiting cards migrate to working+silent", () => { /* seed schema-v1 db, run migrate(), assert */ });
```

- [ ] **Step 2-4:** Fail → implement → green (`bun test`, typecheck).
- [ ] **Step 5: Commit** — `feat: store v0.2 — migration, attempts, write-once dispatch latch`

---

### Task 3: Pure card state machine

**Files:**
- Create: `apps/daemon/src/orchestrator/machine.ts`
- Test: `apps/daemon/test/machine.test.ts`

**Interfaces:**
- Consumes: T1 `Card`.
- Produces: `type MachineEvent = {t:"start"} | {t:"session-started"} | {t:"start-failed"} | {t:"flag", kind: InputKind} | {t:"flag-clear"} | {t:"complete"} | {t:"stop-failure"} | {t:"crashed"} | {t:"interrupted"} | {t:"user-stop"} | {t:"send-back"} | {t:"merge-start"} | {t:"merged"} | {t:"cancel"} | {t:"requeue"} | {t:"resume"} | {t:"restart"} | {t:"discard"}`; `transition(card: Card, ev: MachineEvent): {card: Card, effects: Effect[]} ` — throws `IllegalTransition` (with from/event, no free text beyond that) on illegal pairs; `Effect = "create-worktree"|"spawn-agent"|"kill-sessions"|"archive-worktree"|"compute-diffstat"|"push"|"undo-toast"|"requeue-auto-off"` (string enum — engine interprets).
- Encode §4.1's table EXACTLY, including: `start-failed` keeps phase `queued` visually (phase stays `queued`, `errorKind: "start_failed"`); `complete` from working → `review+ready`, increments nothing; `send-back` → working round+1; `merged` → done + effects kill-sessions/archive-worktree; `cancel` → cancelled + archive; `discard` (from error) → queued + `auto:false` + archive; flags never change phase (flag on working card only; flag while queued/review = IllegalTransition).

- [ ] **Step 1: Failing tests — EVERY legal transition asserted + a table-driven illegal sweep:**

```ts
// apps/daemon/test/machine.test.ts (shape; implementer enumerates all rows of §4.1)
const LEGAL: Array<[Partial<Card>, MachineEvent["t"], (c: Card) => void]> = [
  [{ phase: "queued" }, "start", c => { expect(c.phase).toBe("working"); expect(c.workingSub).toBe("starting"); }],
  [{ phase: "working", workingSub: "starting" }, "session-started", c => expect(c.workingSub).toBe("running")],
  [{ phase: "working", workingSub: "running" }, "complete", c => { expect(c.phase).toBe("review"); expect(c.reviewSub).toBe("ready"); }],
  [{ phase: "working", workingSub: "running" }, "flag", c => expect(c.inputKind).not.toBeNull()],
  // …every remaining §4.1 row
];
test("illegal pairs throw", () => {
  for (const phase of ["queued", "review", "done", "cancelled"] as const)
    expect(() => transition(mk({ phase }), { t: "flag", kind: "silent" })).toThrow(IllegalTransition);
  expect(() => transition(mk({ phase: "done" }), { t: "complete" })).toThrow(IllegalTransition);
  expect(() => transition(mk({ phase: "queued" }), { t: "merged" })).toThrow(IllegalTransition);
});
```

- [ ] **Step 2-4:** Fail → implement as a flat `switch` over `ev.t` with guard clauses (pure function, no Date.now inside — timestamps passed by caller) → green + typecheck.
- [ ] **Step 5: Commit** — `feat: pure card state machine per spec 4.1`

---

### Task 4: Daemon hygiene + PTY extensions (adapter prep)

**Files:**
- Modify: `apps/daemon/src/pty/session.ts`, `apps/daemon/src/pty/manager.ts`, `apps/daemon/src/http/server.ts`, `apps/daemon/src/index.ts`
- Test: `apps/daemon/test/pty-session.test.ts` (extend), `apps/daemon/test/http.test.ts` (extend)

**Interfaces:**
- Consumes: existing `PtySession{onData,write,resize,kill,exited,snapshot}`, `PtyManager.open`.
- Produces (adapters rely on these):
  - `PtySession` opts gain `cmd?: string[]` (default stays `[$SHELL|/bin/sh, "-i"]`) and `env?: Record<string,string|undefined>` (merged over the scrubbed base env). Export `scrubAgentEnv(base: NodeJS.ProcessEnv): Record<string,string>` — drops every key matching `/^CLAUDE/` (hard rule; contract doc: leaked `CLAUDE_CODE_CHILD_SESSION` breaks --resume) plus sets `TERM=xterm-256color` (existing behavior).
  - `PtySession.terminate(): Promise<number>` — the §6.1 ladder: SIGHUP → 2s → SIGTERM → 2s → SIGKILL (to the child; Bun kill on the PTY child — verify group semantics against docs/research/bun-pty-spike.md and record actual), resolving with the exit code. `kill()` stays as the immediate SIGHUP for shutdown paths.
  - `PtyManager.open` gains `kind?: "shell"|"agent"`, `cmd?: string[]`, `env?`, `attemptId?: number|null`; **insert-failure fix (Plan-1 minor):** wrap `insertSession` in try/catch — on throw, kill the spawned PTY and delete from the live map before rethrowing.
- 404 consistency (Plan-1 minor): `POST /api/projects/:id/cards|sessions|worktrees` pre-check the project row → 404 `{error:"project not found"}` (test: ghost project on all three routes; the cards FK 500 disappears).
- Ring GC + flush race (Plan-1 minors): boot sweep deletes `<dataDir>/rings/*.bin` whose session row is dead AND not the latest agent session of any card's current attempt (those replay as frozen "previous session" scrollback per spec §4.3); serialize interval-vs-final flush with a promise chain in `Ring` (1-line, per ledger note).

- [ ] **Step 1: failing tests** — `cmd` spawns a non-shell binary (use `["cat"]`, write bytes, assert echo); scrubbed env: spawn `["/usr/bin/env"]` with `CLAUDE_TEST=1` in parent env → captured output must not contain `CLAUDE_TEST` (assert on ring snapshot; content check is test-only, not product); `terminate()` on a SIGHUP-immune child (`["sh","-c","trap '' HUP; sleep 30"]`) resolves ≤5s (ladder reached SIGTERM); ghost-project 404 ×3 routes; ring GC leaves the latest attempt ring, removes others.
- [ ] **Step 2-4:** fail → implement → `bun test` green + typecheck.
- [ ] **Step 5: Commit** — `feat: pty cmd/env/terminate ladder, env scrub, 404 consistency, ring gc`

---

### Task 5: Web WS reconnect + disconnected strip

**Files:**
- Modify: `apps/web/src/api.ts`, `apps/web/src/components/Shell.tsx`
- Test: `apps/web/src/test/reconnect.test.ts`

**Interfaces:**
- Consumes: existing `connectWs(onEvent) → CgSocket{sub,input,resize,close}` and its module internals (read them first — T10/T13 flagged: close() must clear handlers + queue).
- Produces: `CgSocket` gains `state: "open"|"connecting"|"down"` + `onState(cb) → off`; internal reconnect with exponential backoff 1s→2s→4s→8s cap 15s (±20% jitter), infinite retries; on reopen: re-send `sub` for every registered sid (handlers map is the source of truth) and call the registered `onReconnect` callback — Shell wires it to `queryClient.invalidateQueries()` (full refetch closes any missed-event gap); `close()` clears handlers, queue, and timers (fixes the forever-queueing leak). Shell renders a thin top strip `connection lost — retrying` (sizes/tokens per grammar; `var(--amber)`) when state==="down" for >1s (no flash on instant reconnects); terminal panes stay mounted (ring replay on re-sub restores content).
- **Session-reminder for implementer:** snapshot-before-live ordering is guaranteed server-side per sub; re-sub after reconnect therefore replays the ring into the existing ghostty term — write the sanitize sequence again before re-sub (same rule as mount, per docs/research/ghostty-web-spike.md).

- [ ] **Step 1: failing test** — unit-test the backoff/queue logic by extracting it into `wsCore.ts` pure helpers (`nextDelay(attempt)`, `Resubscriber` tracking sids): `nextDelay` caps at 15000 and jitters within ±20%; `close()` empties handlers/queue.
- [ ] **Step 2-4:** implement; **browser verification:** kill daemon → strip appears; restart daemon → strip clears, board refetches, re-picked terminal replays; evidence PNG `.superpowers/sdd/task-5-evidence.png`.
- [ ] **Step 5: Commit** — `feat: ws reconnect with resubscribe and disconnected strip`

---

### Task 6: Hook receiver + MCP sidecar

**Files:**
- Create: `apps/daemon/src/agents/receiver.ts`, `apps/daemon/src/agents/mcp.ts`, `apps/daemon/src/agents/mcp-entry.ts`
- Modify: `apps/daemon/src/config.ts` (dataDir layout), `apps/daemon/src/index.ts` (start receiver)
- Test: `apps/daemon/test/receiver.test.ts`, `apps/daemon/test/mcp.test.ts`

**Interfaces:**
- Consumes: T2 store (`touchDispatchProgress`), T4 scrub; events bus.
- Produces:
  - `startHookReceiver(deps) → {port, token, endpointFile, handle(req), stop()}` — Bun.serve on `127.0.0.1:0` (random port); auth header `x-codegent-hook-token`; body cap 1MB → 413; POST `/hook/:agent` parses JSON, resolves pane identity from `CODEGENT_SESSION_ID` field injected by the hook script env, and forwards `{agent, sessionId, event}` to a registered `onHook` callback (adapters subscribe). Fail-open contract: receiver errors NEVER propagate to the agent (always 200 after auth). **Endpoint file** (Orca restart-survival): `<dataDir>/agents/endpoint.env` (`0600`, atomic tmp+rename) holding `CODEGENT_HOOK_PORT/TOKEN`; hook scripts source it first, env fallback second.
  - `writeHookScript(dataDir) → path` — a `/bin/sh` script: sources endpoint file, `curl --connect-timeout 0.5 --max-time 1.5 -s -H "x-codegent-hook-token: $CODEGENT_HOOK_TOKEN" -d @- …/hook/$1`, always `exit 0` (numbers are Orca-proven; keep them).
  - **MCP sidecar** (`mcp-entry.ts`, run as `bun apps/daemon/src/agents/mcp-entry.ts`): stdio MCP server via latest-stable `@modelcontextprotocol/sdk` exposing EXACTLY `task_get`, `task_progress`, `task_complete` (spec §6 — no task_ask_user). It talks to the daemon over `http://127.0.0.1:<port>/api/agent/...` using `CODEGENT_HOOK_TOKEN` + `CODEGENT_CARD_ID`/`CODEGENT_DISPATCH_ID` env (set at spawn). Daemon routes (add in this task): `GET /api/agent/task` (title/body/acceptance), `POST /api/agent/progress {note}` (append to timeline + `touchDispatchProgress`), `POST /api/agent/complete {summary}` — **dirty-worktree gate:** run `git status --porcelain` in the attempt worktree; non-empty → 409 `{error:"worktree has uncommitted changes:\n<porcelain>"}` which the sidecar surfaces as an MCP tool ERROR (the text lands in the agent's own conversation only — sanctioned by §6.1); clean → engine `complete` event (T8 wires; until then the route stores a pending-complete marker the test asserts).
- **Progress notes render only in the Details drawer** (spec §7.3) — never on card faces; the API stores note text in a `timeline` table (add here: `timeline(id, card_id, ts, kind, text)`, kinds `progress|round`).

- [ ] **Step 1: failing tests** — receiver: rejects bad token (401), caps body (413), accepts + forwards valid hook, always-200 on handler throw; endpoint file mode 0600 + atomic rewrite; hook script is executable and posts (spawn it with a fake env against the live receiver in-test). MCP: spawn the sidecar as a child process with `CODEGENT_*` env against a stub daemon route, drive one `tools/call` roundtrip over stdio (`initialize` → `task_get`), assert the three tools and ONLY the three tools are listed; dirty-gate: repo fixture with an uncommitted file → `task_complete` returns MCP error containing the porcelain line; clean repo → 200.
- [ ] **Step 2-4:** fail → implement → green + typecheck. **Record the actual @modelcontextprotocol/sdk API surface used in the task report** (it moves; latest stable at execution time governs).
- [ ] **Step 5: Commit** — `feat: loopback hook receiver, fail-open scripts, mcp sidecar with dirty-gate`

---

### Task 7: Claude Code adapter

**Files:**
- Create: `apps/daemon/src/agents/claude.ts`, `apps/daemon/src/agents/types.ts`
- Test: `apps/daemon/test/claude-adapter.test.ts`
- Fixtures: `apps/daemon/test/fixtures/cc-hooks/*.json` — **copy trimmed real payloads** from the spike capture (`docs/research/tmp/cc-hook-spike/`, gitignored) for: session-start(startup/resume), permission-request, pretooluse-askuserquestion, posttooluse-askuserquestion, stop, stop-failure. Redact machine paths → `~`. These become the repo's canonical CC payload record.

**Interfaces:**
- Consumes: T4 (`PtyManager.open` with cmd/env/kind), T6 (receiver `onHook`, hook script path, endpoint env), T2/T3 types.
- Produces `AgentAdapter` (in `types.ts` — Codex implements it too):
```ts
export interface AgentAdapter {
  agent: "claude" | "codex";
  spawn(ctx: SpawnCtx): Promise<SpawnResult>;   // SpawnCtx {project, card, attempt, dispatch, worktreePath, mode: "auto"|"host"|"ask", resumeSessionId?: string|null}
  onHook(sessionId: string, event: unknown): AdapterSignal[];   // pure normalize — no IO
}
export type AdapterSignal =
  | { s: "session-started"; adapterSessionId: string }
  | { s: "flag"; kind: "question" | "permission" }
  | { s: "flag-clear" }            // PostToolUse(AskUserQuestion) → native answer (contract doc §3)
  | { s: "complete-eval" }         // Stop — engine checks pending task_complete (truth table)
  | { s: "stop-failure" };
export type SpawnResult = { sessionMeta: SessionMeta; settingsDir: string };
```
- `spawn` writes to a per-dispatch temp dir under `<dataDir>/agents/<dispatchId>/`: `settings.json` (hook config: the six verified events, matcher shapes per the contract doc — AskUserQuestion via `PreToolUse`/`PostToolUse` matcher `"AskUserQuestion"`, others `"*"`; each command = `<hookScript> claude` with env `CODEGENT_SESSION_ID=<sid>` baked into the hooks' command string, NOT the PTY env — hook scripts run as children of claude and inherit PTY env anyway, but the explicit arg survives claude's own env filtering; verify against the contract doc's recorded working config and use THAT shape) and `mcp.json` (stdio server: command `bun`, args `[<abs mcp-entry.ts>]`, env `CODEGENT_HOOK_PORT/TOKEN/CARD_ID/DISPATCH_ID`). Then `PtyManager.open({kind:"agent", cmd, env, …})` where `cmd = ["claude", "--settings", <settings.json>, "--mcp-config", <mcp.json>, ...(mode==="host" ? ["--dangerously-skip-permissions"] : mode==="auto" ? [<sandbox flags per contract doc>] : []), ...(resumeSessionId ? ["--resume", resumeSessionId] : [])]` and `env = scrubAgentEnv(process.env) + CODEGENT_*`. The task prompt (card title+body+`task_complete` instruction + dispatch envelope ids) is WRITTEN INTO THE PTY after spawn — the contract doc records CC restores interrupted prompts to the composer, so prefix `\x15` (Ctrl+U) before injected text; end with `\r`.
- `onHook` maps events EXACTLY per the truth table: SessionStart→session-started (capture `session_id`); PermissionRequest→flag(permission); PreToolUse+AskUserQuestion→flag(question); PostToolUse+AskUserQuestion→flag-clear; Stop→complete-eval; StopFailure→stop-failure. Unknown events → `[]` (fail-open). NO content fields are copied into signals — the normalizer's output type structurally cannot carry text (§6.1 "can't leak what can't be represented").

- [ ] **Step 1: failing tests** — table-driven: each fixture file → expected `AdapterSignal[]`; settings.json golden test (parse the generated file, assert the six events and the absence of `Notification`); spawn-arg assembly per mode incl. resume; prompt injection is `\x15…\r` framed; unknown-event fail-open.
- [ ] **Step 2-4:** fail → implement → green + typecheck. Do NOT live-spawn claude in unit tests (T13/T14 cover live).
- [ ] **Step 5: Commit** — `feat: claude code adapter — verified hook set, mcp wiring, scrubbed spawn`

---

### Task 8: Orchestrator engine (R1-R4 + envelope)

**Files:**
- Create: `apps/daemon/src/orchestrator/engine.ts`
- Modify: `apps/daemon/src/http/server.ts` (wire routes), `apps/daemon/src/index.ts` (construct engine)
- Test: `apps/daemon/test/engine.test.ts`

**Interfaces:**
- Consumes: T3 `transition`, T2 store, T4 worktrees (`createWorktree`), T6 receiver + agent routes, T7 `AgentAdapter` registry (`{claude: ClaudeAdapter, codex: null /* until T10 */}`), events bus.
- Produces `Engine`:
```ts
new Engine(deps: {db, ptys, adapters, events, clock: () => number, timers?: {heartbeatWarnMs?: number, runawayMs?: number}})
engine.tick(): void                      // R1: while running < workerLimit(project) → start topmost queued auto:on card
engine.start(cardId): Promise<void>      // queued→starting: createWorktree(cardId) → beforeHead = rev-parse → createAttempt+Dispatch → adapter.spawn (30s timeout → start_failed + rollback partial worktree) → prompt inject
engine.handleSignal(sessionId, sig: AdapterSignal): void   // machine transition + effects; complete-eval consults pendingComplete(dispatchId)
engine.completeFromApi(dispatchId): void // the /api/agent/complete route calls this after the dirty-gate: completeDispatch latch → null = ignore stale; else machine "complete", attempt succeeded, diffstat effect, R1 tick
engine.stop(cardId)                      // user ⏹: PTY write \x03 (SIGINT to fg group), card → stopped
engine.merge(cardId): Promise<void>      // review.ready only: squash-merge cg branch into base in the MAIN repo checkout via a plain `git` sequence (record merge as an EVENT row in timeline — spec: merges are recorded facts); then machine "merged": kill sessions → archive worktree (unless pinned) → branch ref reset to squash commit (VK) → R4: re-check other review cards (v0.2: emit card events; stale computation is v0.3) → tick()
engine.sendBack(cardId, comments: string[])  // review→working round+1: comments injected into the SAME session if live (Ctrl+U framing) else new dispatch with resume
engine.interval(): void                  // every 30s: heartbeat check (lastProgressAt/dispatch age > 10min → notice heartbeat-quiet once per quiet period), runaway (>30min → notice runaway + push effect), circuit breaker state
```
- Circuit breaker: on attempt failure (`stop-failure`, crash T9, spawn fail) count consecutive failed attempts per card; 3rd → card error stays + `auto` forced false (never auto-restarts into the same failure; VK/Orca hybrid), R1 skips it.
- **Timers use injected clock** — tests drive time; no real sleeps in unit tests.
- Board reorder route: `PATCH /api/projects/:id/cards/:cardId/position {position}` (queue ordering feeds R1's "topmost").
- Worker limit: `projects.worker_limit` column (migration in this task, default 1) + `PATCH /api/projects/:id {workerLimit}`.

- [ ] **Step 1: failing tests** — with a FakeAdapter (scripted signals) + tmp git repo: R1 starts topmost auto:on only while slots free; full happy path queued→…→review via completeFromApi; stale completeDispatch (second complete) is ignored; question flag → Waiting projection → flag-clear resumes; StopFailure → error + attempt failed; 3 consecutive failures → auto:false + no more R1 pickup; heartbeat notice at +10min fake clock, runaway at +30min, each emitted once; merge: real tmp repo with a committed change on the cg branch → squash lands on base, worktree archived, branch reset to squash sha; sendBack live vs dead session paths; stop writes \x03.
- [ ] **Step 2-4:** fail → implement → green + typecheck.
- [ ] **Step 5: Commit** — `feat: orchestrator engine — r1-r4, dispatch envelope, breaker, merge`

---

### Task 9: Failure & recovery actions

**Files:**
- Modify: `apps/daemon/src/orchestrator/engine.ts`, `apps/daemon/src/index.ts`, `apps/daemon/src/http/server.ts`
- Test: `apps/daemon/test/recovery.test.ts`

**Interfaces:**
- Consumes: T8 engine, T2 store, §9.1 spec (verbatim behaviors), §4.3 reconciliation.
- Produces:
  - **Crash detection:** agent session `exited` with code ≠ 0 AND no Stop signal seen this dispatch → machine `crashed` (card error(crashed), attempt failed, scrollback kept). Exit 0 without task_complete → machine stays working; §6.1 silent flag path (the universal-stack idle classification arrives in v0.3 — v0.2's silent trigger is exit-0-no-complete + CC Stop-without-complete question mapping per truth table).
  - **Boot reconciliation v2** (extends the v0.1 sweep): `failRunningDispatches`; live sessions already get live=0; cards in working → error(interrupted); attempts running → failed; emit card events. One-line global banner data: `GET /api/state/interrupted` → `{cards: number[]}` (web shows "N cards interrupted — resume from their cards").
  - **Action routes** (spec §9.1 — one click, no dialogs, no error text): `POST /api/cards/:id/resume` — same worktree; if `adapterSessionId` exists → adapter spawn with `resumeSessionId` (**re-pass the original mode flags** — persist `mode` on the attempt row, migration here); else fresh dispatch seeded with a context block (task_get + last progress note + `git status --porcelain` summary — injected into the AGENT's prompt, never UI). `POST /api/cards/:id/restart` — same worktree, fresh conversation, original prompt + the spec's fixed note sentence; **never git reset**. `POST /api/cards/:id/discard` — archive worktree (branch kept), card → queued `auto:false`; response carries `{undo: true}` and web shows an undo toast (undo = re-pin worktree? v0.2: undo restores card fields only — worktree re-create happens on next start; disclose this simplification in the task report).
- [ ] **Step 1: failing tests** — crash vs clean-exit paths; reconciliation flips exactly the right rows (seed: 1 working card, 1 queued, 1 done); resume re-passes mode flags (assert argv); restart never runs reset (spy on git calls); discard sets auto:false + archives.
- [ ] **Step 2-4:** fail → implement → green + typecheck.
- [ ] **Step 5: Commit** — `feat: crash detection, boot reconciliation v2, resume/restart/discard`

---

### Task 10: Codex adapter

**Files:**
- Create: `apps/daemon/src/agents/codex.ts`
- Test: `apps/daemon/test/codex-adapter.test.ts` + fixtures `apps/daemon/test/fixtures/codex-hooks/*.json` (trimmed real payloads from the spike capture, like T7)

**Interfaces:**
- Consumes: T7 `AgentAdapter`/`AdapterSignal`, T4/T6 infra; contract doc §7 (Codex 0.144.6 facts).
- Produces `CodexAdapter implements AgentAdapter`:
  - **CODEX_HOME mirror** (Orca's trick, contract-verified): `<dataDir>/agents/codex-home/` — copy the user's `~/.codex/config.toml` if present (never write back), add `hooks.json` (the 10 Claude-compatible events → `<hookScript> codex`), project trust entry for the worktree path. Refresh the mirror at each spawn (config drift). Spawn env: `CODEX_HOME=<mirror>` + scrub + `CODEGENT_*`.
  - `cmd = ["codex", "--dangerously-bypass-hook-trust", ...(mode==="host" ? [<bypass-approvals flag per contract doc>] : []), ...(resumeSessionId ? ["resume", resumeSessionId] : [])]` — exact flags per the contract doc's recorded working invocations; the doc wins.
  - Normalizer: Codex has NO StopFailure/SessionEnd — map its Stop-class event → complete-eval; PermissionRequest → flag(permission); AskUserQuestion-equivalents per the doc; `session_id` present in EVERY payload → treat first event as session-started if none seen (**lazy firing**: TUI hooks fire at first submit — the engine must tolerate session-started arriving late; add an engine test for late session-started in this task).
  - MCP: mirror `config.toml` gains the codegent MCP server entry (same sidecar, env-scoped).
- [ ] **Step 1: failing tests** — mirror generation (user config copied, hooks.json valid, trust present, `~/.codex` untouched — assert by mtime/content on a fixture home); fixture→signal table; late session-started tolerated (engine: flag before session-started doesn't throw — buffered or applied); argv per mode/resume.
- [ ] **Step 2-4:** fail → implement → green + typecheck. If `codex` binary is absent on the machine, unit scope is fully covered by fixtures; note it in the report (T14's live demo covers presence).
- [ ] **Step 5: Commit** — `feat: codex adapter — managed codex_home mirror, verified hook set`

---

### Task 11: Board v0.2 — orchestration UI

**Files:**
- Modify: `apps/web/src/components/Board.tsx`, `apps/web/src/components/Card.tsx`
- Create: `apps/web/src/components/Details.tsx`
- Test: browser verification (evidence PNG) + `apps/web/src/test/projection.test.ts`

**Interfaces:**
- Consumes: T1 card shape, T5 socket, existing api helpers; new routes from T8/T9.
- Produces:
  - **Column projection** (pure function, unit-tested): `columnOf(card): "queue"|"running"|"waiting"|"review"|"done"` — queue = phase queued (incl. errorKind start_failed badge); running = working && !inputKind; waiting = working && inputKind; review; done (+ collapsed cancelled section). Waiting is DERIVED — no phase writes from the UI for it.
  - **Badges** (grammar: 9.5-10px caps, 650, radius 999): QUEUE·n position; RUNNING (+ `round N` when round>1); QUESTION / PERMISSION / SILENT (distinct inline-SVG icons, `var(--amber)` family); ERROR (kind-agnostic — no error text, principle 1); READY FOR REVIEW; slots counter `n/m` in Running header; elapsed time on running chips (client-side from updatedAt).
  - **Actions**: queued card ▸ start (POST start); running ⏹ stop; error row resume/restart/discard (one click each + discard undo toast); review row Merge + Send back (Send back opens a plain textarea in the Details drawer — comments POST to sendBack); auto toggle chip on queued cards (`auto:on/off`); queue reorder via drag within the Queue column ONLY (HTML5 DnD, position PATCH; other cross-column drags stay out of v0.2).
  - **Details drawer** (right side, 360px, spec §7.3 lite): full title/body (editable → PATCH), timeline (progress notes + round markers from `GET /api/cards/:id/timeline`), session history list, mark-state override menu (`running · needs-input` — POST override route from T8; the §9.2 watchdog cross-check is v0.3, note in report). The ONLY surface rendering progress-note text.
  - Interrupted banner (from T9 route) over the board.
- [ ] **Step 1:** unit-test `columnOf` exhaustively (every phase/flag combo).
- [ ] **Step 2-3:** implement; **browser verification with the full loop live** (daemon + web + a real throwaway repo + claude): create card → start → RUNNING badge + terminal shows live TUI → agent asks (prompt it to) → WAITING/QUESTION → answer in terminal → RUNNING → task_complete → REVIEW → Merge → DONE + worktree archived + next queued card auto-starts. Evidence PNGs (board mid-flow + details drawer).
- [ ] **Step 4: Commit** — `feat: board v0.2 — derived waiting, badges, actions, details drawer`

---

### Task 12: Terminal rail v0.2 — agent sessions

**Files:**
- Modify: `apps/web/src/components/SessionRail.tsx`, `apps/web/src/components/TerminalView.tsx`
- Test: browser verification

**Interfaces:**
- Consumes: T1 SessionMeta.kind/attemptId; existing rail/pane machinery.
- Produces: agent sessions render with the card title + a small agent glyph (SVG) and sort above shells; clicking a Waiting card (T11 click-target rule) routes to terminal view focused on that card's live agent session (Shell view-switch + focus param — smallest viable wiring, e.g. AppCtx `focusSession(sid)`); dead agent sessions of the current attempt render with a thin "previous session" header row above the replayed frozen scrollback (ring kept by T4 GC rule); shells unchanged.
- [ ] Implement → browser-verify (Waiting card click lands in the right pane; previous-session label after a daemon restart) → evidence PNG → commit `feat: terminal rail v0.2 — agent sessions, waiting-card routing, previous-session replay`.

---

### Task 13: Contract-test harness + nightly CI

**Files:**
- Create: `apps/daemon/test/contract/cc-live.test.ts`, `scripts/contract-cc.sh`
- Modify: `.buildkite/pipeline.yml`
- Test: itself.

**Interfaces:**
- Consumes: T7 normalizer, spike repro harness style (docs/research/cc-codex-hook-contract.md has the recipe: temp project, --settings hooks → JSONL log, `--model haiku`, ANTHROPIC_BASE_URL→400 for StopFailure).
- Produces: fixture tests run always (already in T7/T10). LIVE contract test gated behind `CODEGENT_CONTRACT_LIVE=1`: runs real `claude` (2 scenarios: trivial turn → Stop; forced 400 → StopFailure) and asserts the event NAMES + required payload keys still match the recorded contract; on mismatch prints the diff of event shapes (this is a dev/CI surface, not product UI). Buildkite: a `schedule`d nightly step (pipeline-level `schedules` or a separate pipeline file per Buildkite convention — implementer verifies current Buildkite schedule syntax and records it) running `CODEGENT_CONTRACT_LIVE=1 bun test apps/daemon/test/contract` on the linux agent, `soft_fail: true` (a vendor CLI change must not redden main CI; it should page us via the nightly's own status).
- **Cost note:** live scenarios ≤2 haiku turns total; skip silently (pass) when `claude` binary or auth is absent — CI agents without claude just no-op until we provision one.
- [ ] Implement → verify: default run skips live (suite green), `CODEGENT_CONTRACT_LIVE=1` locally runs both scenarios green → commit `feat: nightly agent contract tests`.

---

### Task 14: End-to-end demo + docs

**Files:**
- Modify: `README.md` (dev section gains the v0.2 loop), `.superpowers/sdd/` evidence
- Test: the full loop, twice (fresh + restart-recovery).

- [ ] **Step 1: Full-loop verification** (the v0.2 exit gate — both agents if codex present, else claude + note):
  1. Fresh throwaway repo project; worker limit 1; two cards queued (auto:on).
  2. Card 1 auto-starts: worktree `cg/1-…` created, claude TUI live in terminal view, RUNNING badge.
  3. Prompted question → WAITING/QUESTION + push-less strip; answer in terminal → RUNNING (PostToolUse clear).
  4. `task_complete` with dirty worktree → agent visibly commits then completes (watch the TUI; nothing surfaces in board UI) → REVIEW.
  5. Merge → DONE, worktree archived, branch reset to squash sha (`git log` proof), card 2 auto-starts (R1).
  6. Kill daemon mid-run of card 2 → restart → interrupted banner, card error(interrupted) → resume → same conversation continues (`--resume` proof: agent recalls context) → complete → merge.
  7. Circuit breaker: card with a prompt engineered to StopFailure (400 base URL in a scratch env var override on the attempt — engineer via a test-only project env override, disclose mechanism) 3× → auto:false + ERROR, queue continues.
- [ ] **Step 2:** README dev section: the loop in 5 lines + `worker limit` note. No marketing, no promises.
- [ ] **Step 3:** Evidence PNGs + written narrative in the task report; ledger updated.
- [ ] **Step 4: Commit** — `docs: v0.2 dev loop`

---

## Self-Review (performed at write time)

1. **Spec coverage (v0.2 milestone):** orchestrator R1-R4 ✓(T8) · completion truth table live ✓(T6 gate + T7/T8 complete-eval) · CC adapter e2e ✓(T7+T14) · Codex adapter ✓(T10) · error/recovery actions ✓(T9) · §6.1 envelope (ids, latch, heartbeat, breaker, before-HEAD, dirty-gate) ✓(T2/T6/T8) · §4.1 machine incl. drag-map subset ✓(T3/T11) · carried b-items: WS reconnect ✓(T5), ring policy ✓(T4), 404 ✓(T4), PTY leak ✓(T4), migration atomicity ✓(T2), second-signal force-exit (done in v0.1 fix round) · nightly contract tests ✓(T13). Deliberately out (v0.3+): universal terminal-state tier (§6.1 layers for non-premium agents), review queue UI/diff view/stale-conflict flows, relay, attention strip, palette counts, push notifications, mark-state watchdog cross-check, DnD beyond queue-reorder.
2. **Placeholder scan:** T7/T10 "per contract doc" clauses are adapt-to-recorded-truth instructions pointing at committed evidence (same pattern as Plan 1's spike-doc references), not TBDs. T8 merge/diffstat kept minimal deliberately (diff VIEW is v0.3). No TBD/TODO text remains.
3. **Type consistency:** `AdapterSignal` names match engine handlers (T7↔T8); `completeDispatch` null-latch semantics consistent T2↔T8; `columnOf` consumes T1 fields exactly; SessionMeta.kind widening flows T1→T4→T12; MachineEvent names match engine calls (T3↔T8/T9).
4. **Risk note for the executor:** T7/T10 fixture copies come from a gitignored spike dir — if absent (fresh clone), re-run the spike recipe in the contract doc to regenerate; do not invent payloads.
