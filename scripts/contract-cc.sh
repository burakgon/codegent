#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

export CODEGENT_CONTRACT_LIVE=1
printf 'Running live Claude Code contract tests (Haiku; at most two paid turns)...\n'

if ! command -v claude >/dev/null 2>&1; then
  printf 'Claude CLI is not installed; the gated suite will skip.\n'
fi

exec bun test apps/daemon/test/contract
