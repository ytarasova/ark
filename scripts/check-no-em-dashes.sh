#!/usr/bin/env bash
set -u
hits=$(grep -rln \
  --include='*.md' --include='*.ts' --include='*.tsx' \
  --include='*.yaml' --include='*.yml' --include='*.json' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.worktrees \
  --exclude-dir=.git \
  $'\xe2\x80\x94' . 2>/dev/null || true)
if [ -n "$hits" ]; then
  echo "Em dashes (U+2014) found in:" >&2
  echo "$hits" >&2
  echo "Replace with '--' or '-'." >&2
  exit 1
fi
exit 0
