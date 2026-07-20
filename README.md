# codegent

Browser-based AI coding-agent orchestrator. Pre-release — v0.2 orchestration.

## Develop

Needs [Bun](https://bun.sh) ≥ 1.3.14. One-time setup first: the terminal
renderer (`vendor/ghostty-web`) is a git submodule whose wasm + dist are
built from source, which needs Zig 0.15.2 (exact) on PATH — the build pulls
its own ~206MB ghostty checkout on first run. Build it *before* the root
`bun install` (install copies the built package into node_modules); details
and troubleshooting in `docs/research/ghostty-web-spike.md`.

```sh
git submodule update --init
(cd vendor/ghostty-web && bun install && bun run build)
```

Then install and run the unchanged development commands:

```sh
bun install
bun run dev:daemon   # prints http://127.0.0.1:4666/?t=<token>
bun run dev:web      # http://localhost:5666 — open it with ?t=<token>
```

The v0.2 loop:

1. Create a project from the absolute path to a Git repository.
2. Add a Queue card with `claude` or `codex`; it auto-starts in a worktree with a live terminal.
3. Answer questions in the terminal; when the agent calls `task_complete`, the card moves to In Review.
4. Review the result, then choose **Merge** to move the card to Done.
5. Each project has a worker limit of 1 by default; change `workerLimit` through `PATCH /api/projects/:id`.

Tests: `bun test` · License: AGPL-3.0
