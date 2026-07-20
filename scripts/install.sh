#!/bin/sh
# rvmp installer (spec §14) — zero questions:
#   curl -fsSL https://codegent.io/install | sh
# detect OS/arch → download the release tarball → ~/.rvmp/{dist,bin} →
# PATH line → user service (skip with --no-service) → print the URL.
# Flags: --no-service, --dry-run (print the plan, change nothing).
# Env: RVMP_DOWNLOAD_BASE overrides the release URL base (self-host/CI).
set -eu

BASE="${RVMP_DOWNLOAD_BASE:-https://github.com/burakgon/rvmp/releases/latest/download}"
HOME_DIR="${HOME}"
ROOT="${HOME_DIR}/.rvmp"
DRY=0
SERVICE=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --no-service) SERVICE=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) plat="darwin" ;;
  Linux) plat="linux" ;;
  *) echo "unsupported OS: $os (WSL: run inside your Linux distro)" >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) cpu="arm64" ;;
  x86_64|amd64) cpu="x64" ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac
target="${plat}-${cpu}"
url="${BASE}/rvmp-${target}.tar.gz"

if [ "$DRY" = 1 ]; then
  echo "plan:"
  echo "  download ${url}"
  echo "  extract  ${ROOT}/dist/${target}"
  echo "  link     ${ROOT}/bin/rvmp"
  echo "  path     append ${ROOT}/bin to your shell rc (idempotent)"
  [ "$SERVICE" = 1 ] && echo "  service  rvmp service enable" || echo "  service  skipped (--no-service)"
  exit 0
fi

mkdir -p "${ROOT}/bin" "${ROOT}/dist"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "downloading ${url}"
curl -fSL --proto '=https' "$url" -o "${tmp}/rvmp.tar.gz"
# Extract to a staging dir FIRST (review A-Min): a corrupt archive must not
# destroy a working install.
mkdir -p "${tmp}/extract"
tar -xzf "${tmp}/rvmp.tar.gz" -C "${tmp}/extract"
[ -x "${tmp}/extract/bin/rvmp" ] || { echo "archive layout invalid" >&2; exit 1; }
rm -rf "${ROOT}/dist/${target}"
mkdir -p "${ROOT}/dist"
mv "${tmp}/extract" "${ROOT}/dist/${target}"
ln -sf "${ROOT}/dist/${target}/bin/rvmp" "${ROOT}/bin/rvmp"
chmod +x "${ROOT}/dist/${target}/bin/rvmp"

# PATH line, idempotent, into whichever rc files exist.
PATH_LINE="export PATH=\"\$HOME/.rvmp/bin:\$PATH\""
added=0
for rc in "${HOME_DIR}/.zshrc" "${HOME_DIR}/.zprofile" "${HOME_DIR}/.bashrc" "${HOME_DIR}/.profile"; do
  [ -f "$rc" ] || continue
  grep -qs '\.rvmp/bin' "$rc" || printf '\n%s\n' "$PATH_LINE" >> "$rc"
  added=1
done
# No rc file at all (fresh account, review A-Imp): create ~/.profile.
[ "$added" = 1 ] || printf '%s\n' "$PATH_LINE" >> "${HOME_DIR}/.profile"

if [ "$SERVICE" = 1 ]; then
  "${ROOT}/bin/rvmp" service enable || echo "service setup failed — run it later: rvmp service enable"
fi

echo ""
echo "rvmp installed."
TOKEN="$(cat "${ROOT}/token" 2>/dev/null || true)"
PORT="$(cat "${ROOT}/port" 2>/dev/null || echo 4666)"
if [ -n "$TOKEN" ]; then
  echo "  board:  http://localhost:${PORT}/#t=${TOKEN}"
else
  echo "  start:  ${ROOT}/bin/rvmp   (prints + opens the board URL)"
fi
echo "  (new shells have it on PATH as \`rvmp\`)"
