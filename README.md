# codegent

**A local, browser-based orchestrator for AI coding agents.** The terminal
power of a real PTY, a kanban board that routes attention, and a review flow
with real diffs — for Claude Code, Codex, Gemini CLI, and any other agent CLI,
on your machine, with your subscriptions. No accounts, no cloud, no telemetry.

## Quick start

```sh
npx codegent-cli
```

That runs the daemon in the foreground and opens the board. Make it permanent:

```sh
curl -fsSL https://codegent.io/install | sh   # binary + PATH + user service
```

Then: add a project, drop a task card, watch an agent pick it up in a real
terminal, answer its questions in that terminal, review the diff, merge.

## What it does

- **Board** — queue → running → waiting-for-input → review → done. Cards, not
  chats. Auto-start with a worker limit; drag to reorder the queue.
- **Real terminals** — every agent runs interactively in its own PTY,
  streamed to the browser. Scrollback survives restarts.
- **Universal agent tier** — content-free state detection (process tree, OSC
  titles, screen manifests) tells the board when ANY recognized agent is
  working, stuck, or waiting — without reading your terminal's content out.
- **Review flow** — queue strip, file-by-file diff with viewed-marks, queued
  line comments sent back to the agent in one batch, stale/conflict tracking
  when the base moves, squash/merge/rebase, PR tracking via `gh`.
- **Local-only** — binds localhost, token-authed. Remote access is your own
  tunnel: see [docs/expose-safely.md](docs/expose-safely.md).

## CLI

```
codegent                  start + open the board
codegent doctor           environment checks
codegent task add "…"     queue a card from the shell
codegent service enable   keep it running (launchd / systemd --user)
```

## Principles

Terminal content never leaves the terminal — surfaces show state + elapsed
time only. The board observes and routes; conversation happens in the
terminal. Tasks are primary; worktrees are their shadow.

License: AGPL-3.0. No telemetry.
