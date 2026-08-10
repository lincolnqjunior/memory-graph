#!/usr/bin/env bash
# Install the repo hooks into .git/hooks (idempotent).
# Run from the repo root: bash scripts/install-hooks.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK_SRC="$ROOT/scripts/hooks"
HOOK_DST="$ROOT/.git/hooks"

for hook in pre-commit; do
  cp "$HOOK_SRC/$hook" "$HOOK_DST/$hook"
  chmod +x "$HOOK_DST/$hook"
  echo "installed: .git/hooks/$hook"
done
